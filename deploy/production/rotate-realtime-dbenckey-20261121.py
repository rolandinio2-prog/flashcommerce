#!/usr/bin/env python3
"""Rotate production Realtime DB_ENC_KEY away from the public demo value ('supabaserealtime').

Re-encrypts every encrypted field (tenants.jwt_secret + extension settings db_host/db_name/db_port/
db_user/db_password) with a new random 16-char key, updates realtime.env and rolls Realtime to a new
container (old one kept stopped). Plain values never change and are never printed.

  --dry-run   decrypt/re-encrypt round-trip check, backups, compose dry-run (no production change)
  --execute   apply with automatic rollback
"""
import json, pathlib, re, secrets, subprocess, sys, time

ENV_RT = pathlib.Path('/etc/fastpay/prod-runtime-v1/realtime.env')
B = pathlib.Path('/var/backups/fastpay/PROD_RT_DBENCKEY_ROTATION_20261121_V1')
DEP = pathlib.Path('/opt/fastpay/production-s5-20261121-v1')
OLD_C, NEW_C = 'fastpay-realtime-prod-v2', 'fastpay-realtime-prod-v3'
SRC_COMPOSE, NEW_COMPOSE = DEP / 'realtime-compose-v2.json', DEP / 'realtime-compose-v3.json'
ENC_FIELDS = ('db_host', 'db_name', 'db_port', 'db_user', 'db_password')
NET, HELPER = 'fastpay-prod-v1-backend', 'fastpay/api:prod-s5-20261121-v1'

def emit(m): print(m, flush=True)
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode: raise RuntimeError(f'{cmd[:3]} rc={r.returncode} {r.stderr.strip()[-300:]}')
    return r.stdout
def psql(sql):
    return run(['docker', 'exec', '-i', 'fastpay-postgres-prod-v1', 'psql', '-U', 'supabase_admin', '-d', 'postgres',
                '-At', '-v', 'ON_ERROR_STOP=1'], input=sql).strip()
def enc(plain, key): return run(['openssl', 'enc', '-aes-128-ecb', '-K', key.encode().hex(), '-base64', '-A'], input=plain).strip()
def dec(value, key): return run(['openssl', 'enc', '-d', '-aes-128-ecb', '-K', key.encode().hex(), '-base64', '-A'], input=value)
def env_get(key):
    for l in ENV_RT.read_text().splitlines():
        if l.startswith(key + '='): return l.split('=', 1)[1].strip().strip('"')
def state(n): return json.loads(run(['docker', 'inspect', n]))[0]['State']
def exists(n): return subprocess.run(['docker', 'inspect', n], capture_output=True).returncode == 0
def read_db():
    jwt = psql("select jwt_secret from _realtime.tenants where external_id='realtime-dev'")
    settings = json.loads(psql("select settings::text from _realtime.extensions where tenant_external_id='realtime-dev' and type='postgres_cdc_rls'"))
    return jwt, settings
def write_db(jwt, settings):
    for v in [jwt] + [settings[f] for f in ENC_FIELDS]: assert re.fullmatch(r'[A-Za-z0-9+/=]+', v)
    psql("begin;\n"
         f"update _realtime.tenants set jwt_secret='{jwt}', updated_at=now() where external_id='realtime-dev';\n"
         "update _realtime.extensions set settings='" + json.dumps(settings).replace("'", "''") +
         "'::jsonb, updated_at=now() where tenant_external_id='realtime-dev' and type='postgres_cdc_rls';\ncommit;")
def mgmt_ok(secret):
    import base64, hashlib, hmac
    b = lambda d: base64.urlsafe_b64encode(d).rstrip(b'=').decode()
    n = int(time.time()); h = b(b'{"alg":"HS256","typ":"JWT"}'); p = b(json.dumps({'iat': n, 'exp': n + 120}).encode())
    t = f'{h}.{p}.' + b(hmac.new(secret.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest())
    js = 'fetch("http://realtime-dev:4000/api/tenants/realtime-dev",{headers:{authorization:"Bearer "+process.env.T}}).then(r=>console.log(r.status)).catch(()=>console.log(0))'
    out = run(['docker', 'run', '--rm', '--network', NET, '--read-only', '--cap-drop', 'ALL', '-e', 'T=' + t, '--entrypoint', 'node', HELPER, '-e', js])
    return out.strip().splitlines()[-1] == '200'

STEP = []
def rollback(reason):
    emit('ROLLBACK_START ' + reason)
    ENV_RT.write_text((B / 'realtime.env.before').read_text())
    if 'db' in STEP:
        before = json.loads((B / 'db-encrypted.before.json').read_text()); write_db(before['jwt'], before['settings'])
    if 'container' in STEP:
        subprocess.run(['docker', 'stop', NEW_C], capture_output=True)
        subprocess.run(['docker', 'start', OLD_C], capture_output=True)
        subprocess.run(['docker', 'update', '--restart=unless-stopped', OLD_C], capture_output=True)
    emit('ROLLBACK_DONE')

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    assert mode in ('--dry-run', '--execute')
    old_key = env_get('DB_ENC_KEY'); assert old_key == 'supabaserealtime', 'DB_ENC_KEY is not the demo value'
    assert state(OLD_C)['Running'] and not exists(NEW_C)
    mgmt = env_get('API_JWT_SECRET'); assert mgmt_ok(mgmt), 'realtime mgmt not reachable'
    jwt, settings = read_db()
    plains = {'jwt': dec(jwt, old_key), **{f: dec(settings[f], old_key) for f in ENC_FIELDS}}
    assert all(plains.values()) and all(enc(v, old_key) == (jwt if k == 'jwt' else settings[k]) for k, v in plains.items())
    emit('PREFLIGHT=PASS (all 6 fields decrypt and round-trip with current key)')
    B.mkdir(mode=0o700, exist_ok=True)
    p = B / 'realtime.env.before'
    if not p.exists(): p.write_text(ENV_RT.read_text()); p.chmod(0o600)
    p = B / 'db-encrypted.before.json'
    if not p.exists(): p.write_text(json.dumps({'jwt': jwt, 'settings': settings})); p.chmod(0o600)
    run(['/usr/local/sbin/fastpay-db-backup.sh'])
    kp = B / 'new-key.private'
    if not kp.exists(): kp.write_text(secrets.token_hex(8)); kp.chmod(0o600)
    new_key = kp.read_text().strip(); assert len(new_key) == 16
    new_jwt = enc(plains['jwt'], new_key); new_settings = dict(settings)
    for f in ENC_FIELDS: new_settings[f] = enc(plains[f], new_key)
    assert dec(new_jwt, new_key) == plains['jwt'] and all(dec(new_settings[f], new_key) == plains[f] for f in ENC_FIELDS)
    new_env = re.sub(r'^DB_ENC_KEY=.*$', 'DB_ENC_KEY=' + new_key, ENV_RT.read_text(), count=1, flags=re.M)
    assert new_env.count('DB_ENC_KEY=' + new_key) == 1
    c = json.loads(SRC_COMPOSE.read_text()); s = c['services']['realtime']
    s.update(container_name=NEW_C, restart='no'); c['name'] = 'fastpay-production-s5-realtime-v3'
    NEW_COMPOSE.write_text(json.dumps(c, indent=2)); NEW_COMPOSE.chmod(0o600)
    dry = subprocess.run(['docker', 'compose', '-f', str(NEW_COMPOSE), 'up', '--dry-run', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'realtime'], capture_output=True, text=True)
    assert f'Container {NEW_C}' in dry.stdout + dry.stderr, 'compose dry-run target mismatch'
    emit('BACKUPS_AND_RENDER=PASS db_backup=' + run(['readlink', '/var/backups/fastpay/db-daily/latest']).strip())
    if mode == '--dry-run': emit('DRY_RUN_COMPLETE production unchanged'); return
    try:
        run(['docker', 'update', '--restart=no', OLD_C]); run(['docker', 'stop', '--time', '30', OLD_C]); STEP.append('container')
        STEP.append('db'); write_db(new_jwt, new_settings)
        ENV_RT.write_text(new_env)
        run(['docker', 'compose', '-f', str(NEW_COMPOSE), 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', 'realtime'])
        deadline = time.time() + 120
        while not mgmt_ok(mgmt):
            assert state(NEW_C)['Running'], 'realtime v3 exited'
            assert time.time() < deadline, 'realtime v3 not ready'
            time.sleep(4)
        emit('REALTIME_V3=PASS')
    except Exception as e:
        rollback(f'{type(e).__name__}: {e}'); emit('RESULT=ROLLED_BACK'); sys.exit(2)
    run(['docker', 'update', '--restart=unless-stopped', NEW_C])
    c['services']['realtime']['restart'] = 'unless-stopped'; NEW_COMPOSE.write_text(json.dumps(c, indent=2))
    emit(f'RESULT=PASS realtime={NEW_C} old_kept_stopped={OLD_C}')

if __name__ == '__main__':
    main()
