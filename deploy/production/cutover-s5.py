#!/usr/bin/env python3
"""FastPay production release S5 (repo main) — coordinated cutover.

Usage (as root):  cutover-s5.py --dry-run   -> preflight + backup + prepare, NO production change
                  cutover-s5.py --execute   -> migration + api/customer/driver cutover + verify

Never deletes containers, images, volumes or networks. Old containers are kept STOPPED
(restart=no) for rollback. On any failure after changes start, everything is rolled back
automatically (old containers restarted, migration reverted).
"""
import copy, http.client, json, pathlib, subprocess, sys, time

TAG = 'prod-s5-20261121-v1'
RELEASE = pathlib.Path('/opt/fastpay/releases/' + TAG)
DEPLOY = pathlib.Path('/opt/fastpay/production-s5-20261121-v1')
BACKUP = pathlib.Path('/var/backups/fastpay/PROD_S5_20261121_V1')
DB = 'fastpay-postgres-prod-v1'
MIGRATION = RELEASE / 'supabase/migrations/20261005000100_delivery_monitor_session_revocation_v2.sql'
HISTORY_SQL = RELEASE / 'migration-history-20261005000100.sql'

APPS = [  # order matters: api first (topic contract), then frontends
    {'svc': 'api', 'old': 'fastpay-api-prod-s3-cash-closing-v1', 'new': 'fastpay-api-prod-s5-v1',
     'compose': '/opt/fastpay/production-s3-cash-closing-v1/api-compose.json', 'path': '/api/v1'},
    {'svc': 'customer', 'old': 'fastpay-customer-prod-s3-ops-business-entry-v1', 'new': 'fastpay-customer-prod-s5-v1',
     'compose': '/opt/fastpay/production-s3-ops-business-entry-v1/customer-compose.json', 'path': '/'},
    {'svc': 'driver', 'old': 'fastpay-driver-prod-v1', 'new': 'fastpay-driver-prod-s5-v1',
     'compose': '/opt/fastpay/production-v1/compose.json', 'path': '/'},
]
PUBLIC_CHECKS = [('app.fastpay.com.bo', '/', 200), ('ops.fastpay.com.bo', '/ops', 200),
                 ('admin.fastpay.com.bo', '/admin', 200), ('driver.fastpay.com.bo', '/', 200),
                 ('api.fastpay.com.bo', '/api/v1', 200), ('api.fastpay.com.bo', '/api/v1/ops/orders', 401),
                 ('api.fastpay.com.bo', '/api/v1/ops/delivery-monitor/active', 401)]

def emit(msg): print(msg, flush=True)
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0: raise RuntimeError(f'{cmd[:4]} rc={r.returncode} {r.stderr.strip()[:300]}')
    return r.stdout
def inspect(name): return json.loads(run(['docker', 'inspect', name]))[0]
def exists(name): return subprocess.run(['docker', 'inspect', name], capture_output=True).returncode == 0
def psql(sql=None, file=None):
    cmd = ['docker', 'exec', '-i', DB, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1']
    data = file.read_text() if file else sql
    return run(cmd, input=data)
def http_status(host, path):
    c = http.client.HTTPConnection('127.0.0.1', 80, timeout=20)
    c.request('GET', path, headers={'Host': host, 'X-Forwarded-Proto': 'https'})
    s = c.getresponse().status; c.close(); return s
def wait_healthy(name, seconds=180):
    deadline = time.monotonic() + seconds
    while True:
        st = inspect(name)['State']
        h = st.get('Health', {}).get('Status')
        if st['Status'] in ('exited', 'dead') or h == 'unhealthy': raise RuntimeError(f'{name} {st["Status"]}/{h}')
        if st['Running'] and h == 'healthy': return
        if time.monotonic() > deadline: raise RuntimeError(f'{name} health timeout ({h})')
        time.sleep(3)

def preflight():
    for a in APPS:
        st = inspect(a['old'])['State']
        assert st['Running'] and st.get('Health', {}).get('Status') == 'healthy', a['old'] + ' not healthy'
        assert not exists(a['new']), a['new'] + ' already exists'
        img = json.loads(run(['docker', 'image', 'inspect', f"fastpay/{a['svc']}:{TAG}"]))[0]
        assert img['Config']['User'] == 'node' and img['Architecture'] == 'amd64'
        a['image'] = img['Id']
    assert MIGRATION.is_file() and HISTORY_SQL.is_file()
    assert psql("select count(*) from supabase_migrations.schema_migrations where version='20261005000100'").strip() == '0'
    assert psql("select count(*) from pg_proc where proname='delivery_monitor_session_receive_v2'").strip() == '0'
    for host, path, code in PUBLIC_CHECKS: assert http_status(host, path) == code, f'baseline {host}{path}'
    emit('PREFLIGHT=PASS')

def backup():
    BACKUP.mkdir(mode=0o700, exist_ok=True)
    run(['/usr/local/sbin/fastpay-db-backup.sh'])
    emit('DB_BACKUP=' + run(['readlink', '/var/backups/fastpay/db-daily/latest']).strip())
    fn = psql("select pg_get_functiondef('public.flashdelivery_delivery_monitor_broadcast_location_v1'::regproc)")
    (BACKUP / 'rollback.sql').write_text(
        'begin;\n' + fn.strip() + ';\n'
        'drop policy if exists delivery_monitor_session_receive_v2 on realtime.messages;\n'
        'drop function if exists public.delivery_monitor_session_receive_v2();\n'
        "delete from supabase_migrations.schema_migrations where version='20261005000100';\ncommit;\n")
    for a in APPS:
        (BACKUP / f"{a['svc']}-container-before.json").write_text(json.dumps(inspect(a['old'])))
    emit('ROLLBACK_PREPARED=PASS')

def prepare():
    DEPLOY.mkdir(mode=0o700, exist_ok=True)
    for a in APPS:
        src = json.loads(pathlib.Path(a['compose']).read_text())
        svc = copy.deepcopy(src['services'][a['svc']])
        svc.update(image=a['image'], container_name=a['new'], restart='no')
        cfg = {'name': f"fastpay-production-s5-{a['svc']}-v1", 'services': {a['svc']: svc}, 'networks': src['networks']}
        path = DEPLOY / f"{a['svc']}-compose.json"
        path.write_text(json.dumps(cfg, indent=2)); path.chmod(0o600)
        new = json.loads(run(['docker', 'compose', '-f', str(path), 'config', '--format', 'json']))['services'][a['svc']]
        old = json.loads(run(['docker', 'compose', '-f', a['compose'], 'config', '--format', 'json']))['services'][a['svc']]
        expected = copy.deepcopy(old); expected.update(image=a['image'], container_name=a['new'], restart='no')
        assert new == expected, a['svc'] + ' CONFIG_DRIFT'
        a['deploy'] = str(path)
    emit('COMPOSE_PREPARED_IDENTICAL_EXCEPT_IMAGE=PASS')

def switch(a):
    pol = inspect(a['old'])['HostConfig']['RestartPolicy']['Name']
    a['policy'] = pol
    run(['docker', 'update', '--restart=no', a['old']])
    run(['docker', 'stop', '--time', '30', a['old']])
    a['switched'] = True
    run(['docker', 'compose', '-f', a['deploy'], 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', a['svc']])
    wait_healthy(a['new'])
    emit(f"CUTOVER_{a['svc'].upper()}=PASS")

def rollback(reason):
    emit('ROLLBACK_START reason=' + reason)
    for a in reversed(APPS):
        if not a.get('switched'): continue
        if exists(a['new']): subprocess.run(['docker', 'stop', '--time', '20', a['new']], capture_output=True)
        subprocess.run(['docker', 'start', a['old']], capture_output=True)
        subprocess.run(['docker', 'update', '--restart=' + a.get('policy', 'unless-stopped'), a['old']], capture_output=True)
        try: wait_healthy(a['old'], 180); emit(f"ROLLBACK_{a['svc'].upper()}=PASS")
        except Exception as e: emit(f"ROLLBACK_{a['svc'].upper()}=FAIL {e}")
    if MIGRATED:
        try: psql(file=BACKUP / 'rollback.sql'); emit('ROLLBACK_MIGRATION=PASS')
        except Exception as e: emit('ROLLBACK_MIGRATION=FAIL ' + str(e))

MIGRATED = False
def main():
    global MIGRATED
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    assert mode in ('--dry-run', '--execute'), 'use --dry-run or --execute'
    preflight(); backup(); prepare()
    if mode == '--dry-run':
        emit('DRY_RUN_COMPLETE production unchanged'); return
    try:
        psql(file=MIGRATION); MIGRATED = True
        psql(file=HISTORY_SQL)
        emit('MIGRATION_20261005000100=PASS')
        for a in APPS: switch(a)
        for host, path, code in PUBLIC_CHECKS:
            got = http_status(host, path)
            assert got == code, f'{host}{path} expected {code} got {got}'
        emit('PUBLIC_CHECKS=PASS')
        assert psql("select count(*) from pg_policies where policyname='delivery_monitor_session_receive_v2' and permissive='RESTRICTIVE'").strip() == '1'
    except Exception as e:
        rollback(f'{type(e).__name__}: {e}')
        emit('RESULT=ROLLED_BACK'); sys.exit(2)
    for a in APPS:
        run(['docker', 'update', '--restart=' + a['policy'], a['new']])
        cfg = json.loads(pathlib.Path(a['deploy']).read_text())
        cfg['services'][a['svc']]['restart'] = a['policy']
        pathlib.Path(a['deploy']).write_text(json.dumps(cfg, indent=2))
    emit('RESULT=PASS new=' + ','.join(a['new'] for a in APPS) + ' old_kept_stopped=' + ','.join(a['old'] for a in APPS))

if __name__ == '__main__':
    main()
