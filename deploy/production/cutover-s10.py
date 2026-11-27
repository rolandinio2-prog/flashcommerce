#!/usr/bin/env python3
"""FastPay production release S10 (repo main @ eca78f6) — cash on delivery for courier requests.

Applies migration 20261127000100 (additive columns with defaults: collected_total/net_amount on
courier_client_statements, collected_amount on its items, settled_by_staff_user_id on
delivery_cash_settlements; existing statements are backfilled net = -fee) and switches api and customer.
The driver app is unchanged (stays on S8). The migration is backward compatible with the S9 API, so a
rollback only restores the previous containers; the migration stays.

Usage (as root):  cutover-s10.py --dry-run   -> preflight + backup + prepare, NO production change
                  cutover-s10.py --execute   -> migration + api/customer cutover + public verification

Never deletes containers, images, volumes or networks. Previous containers are kept STOPPED for rollback.
"""
import copy, http.client, json, pathlib, subprocess, sys, time

TAG = 'prod-s10-20261127-v1'
COMMIT = 'eca78f6'
RELEASE = pathlib.Path('/opt/fastpay/releases/' + TAG)
S9 = '/opt/fastpay/production-s9-20261126-v1'
DEPLOY = pathlib.Path('/opt/fastpay/production-s10-20261127-v1')
BACKUP = pathlib.Path('/var/backups/fastpay/PROD_S10_20261127_V1')
DB = 'fastpay-postgres-prod-v1'
MIGRATION = ('20261127000100', 'courier_cod_v1')
APPS = [  # api first, then frontends
    {'svc': 'api', 'old': 'fastpay-api-prod-s9-v1', 'new': 'fastpay-api-prod-s10-v1', 'compose': S9 + '/api-compose.json'},
    {'svc': 'customer', 'old': 'fastpay-customer-prod-s9-v1', 'new': 'fastpay-customer-prod-s10-v1', 'compose': S9 + '/customer-compose.json'},
]
PUBLIC_CHECKS = [('app.fastpay.com.bo', '/', 200), ('ops.fastpay.com.bo', '/ops', 200),
                 ('admin.fastpay.com.bo', '/admin', 200), ('driver.fastpay.com.bo', '/', 200),
                 ('api.fastpay.com.bo', '/api/v1', 200), ('api.fastpay.com.bo', '/api/v1/ops/orders', 401),
                 ('api.fastpay.com.bo', '/api/v1/ops/delivery-monitor/active', 401),
                 ('api.fastpay.com.bo', '/api/v1/ops/courier/requests', 401),
                 ('api.fastpay.com.bo', '/api/v1/ops/courier/statements', 401),
                 ('api.fastpay.com.bo', '/api/v1/ops/courier/cash', 401)]

def emit(msg): print(msg, flush=True)
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0: raise RuntimeError(f'{cmd[:4]} rc={r.returncode} {r.stderr.strip()[:300]}')
    return r.stdout
def inspect(name): return json.loads(run(['docker', 'inspect', name]))[0]
def exists(name): return subprocess.run(['docker', 'inspect', name], capture_output=True).returncode == 0
def psql(sql):
    return run(['docker', 'exec', '-i', DB, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input=sql)
def migrations(): return int(psql('select count(*) from supabase_migrations.schema_migrations').strip())
def http_status(host, path):
    c = http.client.HTTPConnection('127.0.0.1', 80, timeout=20)
    c.request('GET', path, headers={'Host': host, 'X-Forwarded-Proto': 'https'})
    s = c.getresponse().status; c.close(); return s
def wait_healthy(name, seconds=180):
    deadline = time.monotonic() + seconds
    while True:
        st = inspect(name)['State']; h = st.get('Health', {}).get('Status')
        if st['Status'] in ('exited', 'dead') or h == 'unhealthy': raise RuntimeError(f'{name} {st["Status"]}/{h}')
        if st['Running'] and h == 'healthy': return
        if time.monotonic() > deadline: raise RuntimeError(f'{name} health timeout ({h})')
        time.sleep(3)

def preflight():
    assert (RELEASE / 'SOURCE_COMMIT').read_text().strip() == COMMIT, 'SOURCE_COMMIT mismatch'
    for a in APPS:
        st = inspect(a['old'])['State']
        assert st['Running'] and st.get('Health', {}).get('Status') == 'healthy', a['old'] + ' not healthy'
        assert not exists(a['new']), a['new'] + ' already exists'
        img = json.loads(run(['docker', 'image', 'inspect', f"fastpay/{a['svc']}:{TAG}"]))[0]
        assert img['Config']['User'] == 'node' and img['Architecture'] == 'amd64'
        a['image'] = img['Id']
    # The customer bundle must target production (guards against a staging/local bundle).
    out = run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', f'fastpay/customer:{TAG}', '-c',
               "grep -rlE 'fastpay.com.bo' .next/static | wc -l; grep -rlE 'staging(-driver)?\\.fastpay\\.com\\.bo|localhost:1?8000|127\\.0\\.0\\.1' .next/static | wc -l"]).split()
    assert out[0] != '0' and out[1] == '0', f'customer bundle target check failed {out}'
    n = migrations(); assert n in (49, 50), f'unexpected migration count {n}'
    emit(f'MIGRATIONS={n}')
    for host, path, code in PUBLIC_CHECKS[:-1]: assert http_status(host, path) == code, f'baseline {host}{path}'
    emit('PREFLIGHT=PASS')

def backup():
    BACKUP.mkdir(mode=0o700, exist_ok=True)
    run(['/usr/local/sbin/fastpay-db-backup.sh'])
    emit('DB_BACKUP=' + run(['readlink', '/var/backups/fastpay/db-daily/latest']).strip())
    for a in APPS:
        (BACKUP / f"{a['svc']}-container-before.json").write_text(json.dumps(inspect(a['old'])))

def prepare():
    DEPLOY.mkdir(mode=0o700, exist_ok=True)
    for a in APPS:
        src = json.loads(pathlib.Path(a['compose']).read_text())
        svc = copy.deepcopy(src['services'][a['svc']]); svc.update(image=a['image'], container_name=a['new'], restart='no')
        cfg = {'name': f"fastpay-production-s10-{a['svc']}-v1", 'services': {a['svc']: svc}, 'networks': src['networks']}
        path = DEPLOY / f"{a['svc']}-compose.json"; path.write_text(json.dumps(cfg, indent=2)); path.chmod(0o600)
        new = json.loads(run(['docker', 'compose', '-f', str(path), 'config', '--format', 'json']))['services'][a['svc']]
        old = json.loads(run(['docker', 'compose', '-f', a['compose'], 'config', '--format', 'json']))['services'][a['svc']]
        expected = copy.deepcopy(old); expected.update(image=a['image'], container_name=a['new'], restart='no')
        assert new == expected, a['svc'] + ' CONFIG_DRIFT'
        dry = subprocess.run(['docker', 'compose', '-f', str(path), 'up', '--dry-run', '-d', '--no-build', '--no-recreate', '--pull', 'never', a['svc']], capture_output=True, text=True)
        assert f"Container {a['new']}" in dry.stdout + dry.stderr, a['svc'] + ' DRYRUN_TARGET_MISMATCH'
        a['deploy'] = str(path)
    emit('COMPOSE_PREPARED_IDENTICAL_EXCEPT_IMAGE=PASS')

def migrate():
    if migrations() == 50:
        assert psql(f"select count(*) from supabase_migrations.schema_migrations where version='{MIGRATION[0]}'").strip() == '1'
        emit('MIGRATION=ALREADY_APPLIED'); return
    sql = (RELEASE / f'supabase/migrations/{MIGRATION[0]}_{MIGRATION[1]}.sql').read_text()
    psql('begin;\nset local role postgres;\n' + sql + '\nreset role;\n'
         f"insert into supabase_migrations.schema_migrations(version,name,statements) values ('{MIGRATION[0]}','{MIGRATION[1]}','{{}}');\ncommit;\n")
    assert migrations() == 50
    cols = psql("select count(*) from information_schema.columns where table_schema='public' and (table_name, column_name) in "
                "(('courier_client_statements','collected_total'),('courier_client_statements','net_amount'),"
                "('courier_client_statement_items','collected_amount'),('delivery_cash_settlements','settled_by_staff_user_id'))").strip()
    assert cols == '4', f'columns {cols}'
    emit('MIGRATION=PASS')

def switch(a):
    a['policy'] = inspect(a['old'])['HostConfig']['RestartPolicy']['Name']
    run(['docker', 'update', '--restart=no', a['old']]); run(['docker', 'stop', '--time', '30', a['old']])
    a['switched'] = True
    run(['docker', 'compose', '-f', a['deploy'], 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', a['svc']])
    wait_healthy(a['new']); emit(f"CUTOVER_{a['svc'].upper()}=PASS")

def rollback(reason):
    emit('ROLLBACK_START reason=' + reason)
    for a in reversed(APPS):
        if not a.get('switched'): continue
        if exists(a['new']): subprocess.run(['docker', 'stop', '--time', '20', a['new']], capture_output=True)
        subprocess.run(['docker', 'start', a['old']], capture_output=True)
        subprocess.run(['docker', 'update', '--restart=' + a.get('policy', 'unless-stopped'), a['old']], capture_output=True)
        try: wait_healthy(a['old'], 180); emit(f"ROLLBACK_{a['svc'].upper()}=PASS")
        except Exception as e: emit(f"ROLLBACK_{a['svc'].upper()}=FAIL {e}")

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    assert mode in ('--dry-run', '--execute'), 'use --dry-run or --execute'
    preflight(); backup(); prepare()
    if mode == '--dry-run': emit('DRY_RUN_COMPLETE production unchanged'); return
    migrate()  # transactional; a failure here leaves production untouched
    try:
        for a in APPS: switch(a)
        for host, path, code in PUBLIC_CHECKS:
            got = http_status(host, path); assert got == code, f'{host}{path} expected {code} got {got}'
        emit('PUBLIC_CHECKS=PASS')
    except Exception as e:
        rollback(f'{type(e).__name__}: {e}'); emit('RESULT=ROLLED_BACK'); sys.exit(2)
    for a in APPS:
        run(['docker', 'update', '--restart=' + a['policy'], a['new']])
        cfg = json.loads(pathlib.Path(a['deploy']).read_text()); cfg['services'][a['svc']]['restart'] = a['policy']
        pathlib.Path(a['deploy']).write_text(json.dumps(cfg, indent=2))
    emit('RESULT=PASS new=' + ','.join(a['new'] for a in APPS) + ' old_kept_stopped=' + ','.join(a['old'] for a in APPS))

if __name__ == '__main__':
    main()
