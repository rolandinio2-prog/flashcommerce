#!/usr/bin/env python3
"""Rotate production Postgres login-role passwords away from the default 'postgres'.

- Every role with LOGIN gets a new random password (stored root-only on the server).
- API (DATABASE_URL, role postgres) and Realtime (DB_PASSWORD + encrypted tenant CDC db_password, role
  supabase_admin) are updated and rolled to new containers; previous containers are kept stopped.
- Local-socket access used by backups/maintenance (trust for supabase_admin) is unaffected.
- Rollback restores the exact previous password hashes, env files, tenant settings and containers.

  --dry-run | --execute
"""
import json, pathlib, re, secrets, subprocess, sys, time, urllib.parse

RT = pathlib.Path('/etc/fastpay/prod-runtime-v1')
ENV_API, ENV_RT = RT / 'api.env', RT / 'realtime.env'
B = pathlib.Path('/var/backups/fastpay/PROD_DB_PASSWORD_ROTATION_20261121_V1')
DEP = pathlib.Path('/opt/fastpay/production-s5-20261121-v1')
API_OLD, API_NEW = 'fastpay-api-prod-s5-v3', 'fastpay-api-prod-s5-v4'
RT_OLD, RT_NEW = 'fastpay-realtime-prod-v3', 'fastpay-realtime-prod-v4'
DB_IMAGE = 'public.ecr.aws/supabase/postgres@sha256:99b1729aeb0bac314445024fc149fbd39306170b61dd50800ccf180327ab3459'
NET = 'fastpay-prod-v1-backend'

def emit(m): print(m, flush=True)
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode: raise RuntimeError(f'{cmd[:3]} rc={r.returncode} {r.stderr.strip()[-300:]}')
    return r.stdout
def psql(sql):  # local socket (trust for supabase_admin): independent of the passwords being rotated
    return run(['docker', 'exec', '-i', 'fastpay-postgres-prod-v1', 'psql', '-U', 'supabase_admin', '-d', 'postgres',
                '-At', '-v', 'ON_ERROR_STOP=1'], input=sql).strip()
def tcp_login(user, password):  # real network login, as services do
    r = subprocess.run(['docker', 'run', '--rm', '--network', NET, '-e', 'PGPASSWORD=' + password, '--entrypoint', 'psql',
                        DB_IMAGE, '-h', 'database-prod-v1', '-U', user, '-d', 'postgres', '-At', '-c', 'select 1'],
                       capture_output=True, text=True)
    return r.stdout.strip() == '1'
def state(n): return json.loads(run(['docker', 'inspect', n]))[0]['State']
def exists(n): return subprocess.run(['docker', 'inspect', n], capture_output=True).returncode == 0
def healthy(n): s = state(n); return s['Running'] and s.get('Health', {}).get('Status', 'healthy') == 'healthy'
def enc(plain, key): return run(['openssl', 'enc', '-aes-128-ecb', '-K', key.encode().hex(), '-base64', '-A'], input=plain).strip()
def dec(v, key): return run(['openssl', 'enc', '-d', '-aes-128-ecb', '-K', key.encode().hex(), '-base64', '-A'], input=v)
def env_get(path, key):
    for l in path.read_text().splitlines():
        if l.startswith(key + '='): return l.split('=', 1)[1].strip().strip('"')
def env_set(text, key, value):
    pat = re.compile(r'^' + re.escape(key) + r'=.*$', re.M); assert len(pat.findall(text)) == 1, key
    return pat.sub(lambda m: f'{key}={value}', text)
def settings(): return json.loads(psql("select settings::text from _realtime.extensions where tenant_external_id='realtime-dev' and type='postgres_cdc_rls'"))
def set_settings(s):
    psql("update _realtime.extensions set settings='" + json.dumps(s).replace("'", "''") + "'::jsonb, updated_at=now() "
         "where tenant_external_id='realtime-dev' and type='postgres_cdc_rls';")
def compose(src, svc, project, name, out):
    c = json.loads(pathlib.Path(src).read_text()); c['name'] = project
    c['services'][svc].update(container_name=name, restart='no')
    out.write_text(json.dumps(c, indent=2)); out.chmod(0o600)
    dry = subprocess.run(['docker', 'compose', '-f', str(out), 'up', '--dry-run', '-d', '--no-build', '--no-recreate', '--pull', 'never', svc], capture_output=True, text=True)
    assert f'Container {name}' in dry.stdout + dry.stderr, f'dry-run mismatch {name}'
    return c
def swap(old, new, cfile, svc):
    run(['docker', 'update', '--restart=no', old]); run(['docker', 'stop', '--time', '20', old])
    run(['docker', 'compose', '-f', str(cfile), 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', svc])

STEP = []
def rollback(reason):
    emit('ROLLBACK_START ' + reason)
    if 'roles' in STEP:
        old = json.loads((B / 'role-hashes.before.json').read_text())
        psql('\n'.join(f"alter role \"{r}\" password '{h}';" if h else f'alter role "{r}" password null;' for r, h in old.items()))
        set_settings(json.loads((B / 'rt-settings.before.json').read_text()))
    ENV_API.write_text((B / 'api.env.before').read_text()); ENV_RT.write_text((B / 'realtime.env.before').read_text())
    for old, new in ((API_OLD, API_NEW), (RT_OLD, RT_NEW)):
        if exists(new): subprocess.run(['docker', 'stop', new], capture_output=True)
        if not state(old)['Running']:
            subprocess.run(['docker', 'start', old], capture_output=True)
            subprocess.run(['docker', 'update', '--restart=unless-stopped', old], capture_output=True)
    emit('ROLLBACK_DONE')

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    assert mode in ('--dry-run', '--execute')
    assert state(API_OLD)['Running'] and state(RT_OLD)['Running'] and not exists(API_NEW) and not exists(RT_NEW)
    db_url = env_get(ENV_API, 'DATABASE_URL'); u = urllib.parse.urlsplit(db_url)
    assert u.username == 'postgres' and u.password == 'postgres', 'API DB credentials not the expected default'
    assert env_get(ENV_RT, 'DB_USER') == 'supabase_admin' and env_get(ENV_RT, 'DB_PASSWORD') == 'postgres'
    enc_key = env_get(ENV_RT, 'DB_ENC_KEY'); s = settings()
    assert dec(s['db_user'], enc_key) == 'supabase_admin' and dec(s['db_password'], enc_key) == 'postgres'
    roles = psql("select rolname from pg_roles where rolcanlogin order by 1").split()
    assert 'postgres' in roles and 'supabase_admin' in roles
    assert tcp_login('postgres', 'postgres') and tcp_login('supabase_admin', 'postgres')
    emit(f'PREFLIGHT=PASS login_roles={len(roles)}')
    B.mkdir(mode=0o700, exist_ok=True)
    for name, path in (('api.env.before', ENV_API), ('realtime.env.before', ENV_RT)):
        p = B / name
        if not p.exists(): p.write_text(path.read_text()); p.chmod(0o600)
    p = B / 'rt-settings.before.json'
    if not p.exists(): p.write_text(json.dumps(s)); p.chmod(0o600)
    p = B / 'role-hashes.before.json'
    if not p.exists():
        hashes = dict(l.split('|', 1) for l in psql("select rolname||'|'||coalesce(rolpassword,'') from pg_authid where rolcanlogin").splitlines())
        p.write_text(json.dumps(hashes)); p.chmod(0o600)
    run(['/usr/local/sbin/fastpay-db-backup.sh'])
    sp = B / 'new-role-passwords.private.json'
    if not sp.exists():
        sp.write_text(json.dumps({r: secrets.token_urlsafe(32) for r in roles})); sp.chmod(0o600)
    P = json.loads(sp.read_text()); assert set(P) == set(roles)
    new_api = env_set(ENV_API.read_text(), 'DATABASE_URL', db_url.replace('postgres:postgres@', 'postgres:' + P['postgres'] + '@', 1))
    new_rt = env_set(ENV_RT.read_text(), 'DB_PASSWORD', P['supabase_admin'])
    new_s = dict(s); new_s['db_password'] = enc(P['supabase_admin'], enc_key); assert dec(new_s['db_password'], enc_key) == P['supabase_admin']
    api_c = compose(DEP / 'api-compose-v3.json', 'api', 'fastpay-production-s5-api-v4', API_NEW, DEP / 'api-compose-v4.json')
    rt_c = compose(DEP / 'realtime-compose-v3.json', 'realtime', 'fastpay-production-s5-realtime-v4', RT_NEW, DEP / 'realtime-compose-v4.json')
    emit('BACKUPS_AND_RENDER=PASS db_backup=' + run(['readlink', '/var/backups/fastpay/db-daily/latest']).strip())
    if mode == '--dry-run': emit('DRY_RUN_COMPLETE production unchanged'); return
    try:
        STEP.append('roles')
        psql('begin;\n' + '\n'.join(f"alter role \"{r}\" password '{P[r]}';" for r in roles) + '\ncommit;')
        set_settings(new_s)
        ENV_API.write_text(new_api); ENV_RT.write_text(new_rt)
        assert tcp_login('postgres', P['postgres']) and not tcp_login('postgres', 'postgres')
        emit('ROLES_ROTATED=PASS')
        swap(API_OLD, API_NEW, DEP / 'api-compose-v4.json', 'api')
        deadline = time.time() + 180
        while not healthy(API_NEW):
            assert state(API_NEW)['Running'] and time.time() < deadline, 'api v4 not healthy'; time.sleep(3)
        emit('API_V4=PASS')
        swap(RT_OLD, RT_NEW, DEP / 'realtime-compose-v4.json', 'realtime')
        deadline = time.time() + 120
        while 'Running RealtimeWeb.Endpoint' not in subprocess.run(['docker', 'logs', RT_NEW], capture_output=True, text=True).stdout + subprocess.run(['docker', 'logs', RT_NEW], capture_output=True, text=True).stderr:
            assert state(RT_NEW)['Running'] and time.time() < deadline, 'realtime v4 not ready'; time.sleep(3)
        emit('REALTIME_V4=PASS')
    except Exception as e:
        rollback(f'{type(e).__name__}: {e}'); emit('RESULT=ROLLED_BACK'); sys.exit(2)
    for n, c, svc, path in ((API_NEW, api_c, 'api', DEP / 'api-compose-v4.json'), (RT_NEW, rt_c, 'realtime', DEP / 'realtime-compose-v4.json')):
        run(['docker', 'update', '--restart=unless-stopped', n]); c['services'][svc]['restart'] = 'unless-stopped'
        path.write_text(json.dumps(c, indent=2))
    emit(f'RESULT=PASS api={API_NEW} realtime={RT_NEW} old_kept_stopped={API_OLD},{RT_OLD}')

if __name__ == '__main__':
    main()
