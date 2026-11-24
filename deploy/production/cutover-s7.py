#!/usr/bin/env python3
"""FastPay production release S7 (repo main @ 1585d75) — stock reservations + R1/R2 API refactor.

Changes only the API container and applies migration 20261124000100 (additive: new table, functions,
trigger on orders). The migration is backward compatible with the S6 API, so a rollback only restores
the S6 API container; the migration stays (it does nothing while no product has a tracked quantity).

Usage (as root):  cutover-s7.py --dry-run   -> preflight + backup + prepare, NO production change
                  cutover-s7.py --execute   -> migration + api cutover + public verification

Never deletes containers, images, volumes or networks. The S6 API container is kept STOPPED.
"""
import copy, http.client, json, pathlib, subprocess, sys, time

TAG = 'prod-s7-20261124-v1'
RELEASE = pathlib.Path('/opt/fastpay/releases/' + TAG)
S6 = '/opt/fastpay/production-s6-20261123-v1'
DEPLOY = pathlib.Path('/opt/fastpay/production-s7-20261124-v1')
BACKUP = pathlib.Path('/var/backups/fastpay/PROD_S7_20261124_V1')
DB = 'fastpay-postgres-prod-v1'
MIGRATION = ('20261124000100', 'stock_reservations_v1')
API = {'svc': 'api', 'old': 'fastpay-api-prod-s6-v1', 'new': 'fastpay-api-prod-s7-v1', 'compose': S6 + '/api-compose.json'}
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
    st = inspect(API['old'])['State']
    assert st['Running'] and st.get('Health', {}).get('Status') == 'healthy', API['old'] + ' not healthy'
    assert not exists(API['new']), API['new'] + ' already exists'
    img = json.loads(run(['docker', 'image', 'inspect', f'fastpay/api:{TAG}']))[0]
    assert img['Config']['User'] == 'node' and img['Architecture'] == 'amd64'
    API['image'] = img['Id']
    assert (RELEASE / 'SOURCE_COMMIT').read_text().strip() == '1585d75'
    n = migrations(); assert n in (46, 47), f'unexpected migration count {n}'
    tracked = psql('select count(*) from public.branch_products where available_quantity is not null').strip()
    emit(f'MIGRATIONS={n} TRACKED_PRODUCTS={tracked}')
    for host, path, code in PUBLIC_CHECKS: assert http_status(host, path) == code, f'baseline {host}{path}'
    emit('PREFLIGHT=PASS')

def backup():
    BACKUP.mkdir(mode=0o700, exist_ok=True)
    run(['/usr/local/sbin/fastpay-db-backup.sh'])
    emit('DB_BACKUP=' + run(['readlink', '/var/backups/fastpay/db-daily/latest']).strip())
    (BACKUP / 'api-container-before.json').write_text(json.dumps(inspect(API['old'])))

def prepare():
    DEPLOY.mkdir(mode=0o700, exist_ok=True)
    src = json.loads(pathlib.Path(API['compose']).read_text())
    svc = copy.deepcopy(src['services']['api']); svc.update(image=API['image'], container_name=API['new'], restart='no')
    cfg = {'name': 'fastpay-production-s7-api-v1', 'services': {'api': svc}, 'networks': src['networks']}
    path = DEPLOY / 'api-compose.json'; path.write_text(json.dumps(cfg, indent=2)); path.chmod(0o600)
    new = json.loads(run(['docker', 'compose', '-f', str(path), 'config', '--format', 'json']))['services']['api']
    old = json.loads(run(['docker', 'compose', '-f', API['compose'], 'config', '--format', 'json']))['services']['api']
    expected = copy.deepcopy(old); expected.update(image=API['image'], container_name=API['new'], restart='no')
    assert new == expected, 'api CONFIG_DRIFT'
    dry = subprocess.run(['docker', 'compose', '-f', str(path), 'up', '--dry-run', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'api'], capture_output=True, text=True)
    assert f"Container {API['new']}" in dry.stdout + dry.stderr, 'api DRYRUN_TARGET_MISMATCH'
    API['deploy'] = str(path)
    emit('COMPOSE_PREPARED_IDENTICAL_EXCEPT_IMAGE=PASS')

def migrate():
    if migrations() == 47:
        assert psql(f"select count(*) from supabase_migrations.schema_migrations where version='{MIGRATION[0]}'").strip() == '1'
        emit('MIGRATION=ALREADY_APPLIED'); return
    sql = (RELEASE / f'supabase/migrations/{MIGRATION[0]}_{MIGRATION[1]}.sql').read_text()
    psql('begin;\nset local role postgres;\n' + sql + '\nreset role;\n'
         f"insert into supabase_migrations.schema_migrations(version,name,statements) values ('{MIGRATION[0]}','{MIGRATION[1]}','{{}}');\ncommit;\n")
    assert migrations() == 47
    owner = psql("select tableowner from pg_tables where schemaname='public' and tablename='stock_reservations'").strip()
    assert owner == 'postgres', 'owner ' + owner
    emit('MIGRATION=PASS')

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    assert mode in ('--dry-run', '--execute'), 'use --dry-run or --execute'
    preflight(); backup(); prepare()
    if mode == '--dry-run': emit('DRY_RUN_COMPLETE production unchanged'); return
    migrate()  # transactional; a failure here leaves production untouched
    switched = False
    try:
        API['policy'] = inspect(API['old'])['HostConfig']['RestartPolicy']['Name']
        run(['docker', 'update', '--restart=no', API['old']]); run(['docker', 'stop', '--time', '30', API['old']])
        switched = True
        run(['docker', 'compose', '-f', API['deploy'], 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'api'])
        wait_healthy(API['new']); emit('CUTOVER_API=PASS')
        for host, path, code in PUBLIC_CHECKS:
            got = http_status(host, path); assert got == code, f'{host}{path} expected {code} got {got}'
        emit('PUBLIC_CHECKS=PASS')
    except Exception as e:
        emit(f'ROLLBACK_START reason={type(e).__name__}: {e}')
        if switched:
            if exists(API['new']): subprocess.run(['docker', 'stop', '--time', '20', API['new']], capture_output=True)
            subprocess.run(['docker', 'start', API['old']], capture_output=True)
            subprocess.run(['docker', 'update', '--restart=' + API.get('policy', 'unless-stopped'), API['old']], capture_output=True)
            try: wait_healthy(API['old'], 180); emit('ROLLBACK_API=PASS')
            except Exception as e2: emit(f'ROLLBACK_API=FAIL {e2}')
        emit('RESULT=ROLLED_BACK'); sys.exit(2)
    run(['docker', 'update', '--restart=' + API['policy'], API['new']])
    cfg = json.loads(pathlib.Path(API['deploy']).read_text()); cfg['services']['api']['restart'] = API['policy']
    pathlib.Path(API['deploy']).write_text(json.dumps(cfg, indent=2))
    emit(f"RESULT=PASS new={API['new']} old_kept_stopped={API['old']}")

if __name__ == '__main__':
    main()
