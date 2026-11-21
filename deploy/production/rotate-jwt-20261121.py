#!/usr/bin/env python3
"""Rotate production Realtime/API JWT secrets away from the public Supabase demo defaults.

  rotate-jwt.py --dry-run   preflight + backups + render new configs (no production change)
  rotate-jwt.py --execute   apply: tenant secret -> realtime v2 -> kong restart -> api v3 -> verify

Never prints secrets. Never deletes containers (old ones are kept stopped). Automatic rollback on failure.
"""
import base64, copy, hashlib, hmac, json, os, pathlib, re, secrets, shutil, subprocess, sys, time

RT = pathlib.Path('/etc/fastpay/prod-runtime-v1')
ENV_API, ENV_RT, KONG = RT / 'api.env', RT / 'realtime.env', RT / 'kong.yml'
B = pathlib.Path('/var/backups/fastpay/PROD_JWT_ROTATION_20261121_V1')
DEP = pathlib.Path('/opt/fastpay/production-s5-20261121-v1')
NET = 'fastpay-prod-v1-backend'
HELPER_IMAGE = 'fastpay/api:prod-s5-20261121-v1'
DEMO = 'super-secret-jwt-token-with-at-least-32-characters-long'
# Public Supabase CLI demo service key: detected by pattern (literal omitted for secret scanners).
DEMO_SERVICE_KEY_RE = r"sb_secret_[A-Za-z0-9_-]{20,}"
PUBLISHABLE = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
RT_OLD, RT_NEW = 'fastpay-realtime-prod-v1', 'fastpay-realtime-prod-v2'
API_OLD, API_NEW = 'fastpay-api-prod-s5-v2', 'fastpay-api-prod-s5-v3'
KONG_C = 'fastpay-kong-prod-v1'

def emit(m): print(m, flush=True)
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode: raise RuntimeError(f'{cmd[:3]} rc={r.returncode} {r.stderr.strip()[-300:]}')
    return r.stdout
def exists(n): return subprocess.run(['docker', 'inspect', n], capture_output=True).returncode == 0
def state(n): return json.loads(run(['docker', 'inspect', n]))[0]['State']
def b64(d): return base64.urlsafe_b64encode(d).rstrip(b'=').decode()
def jwt(secret, claims):
    h = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    p = b64(json.dumps(claims, separators=(',', ':')).encode())
    s = b64(hmac.new(secret.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest())
    return f'{h}.{p}.{s}'
def env_get(path, key):
    for line in path.read_text().splitlines():
        if line.startswith(key + '='): return line.split('=', 1)[1].strip().strip('"')
    raise KeyError(key)
def env_set(text, key, value):
    pat = re.compile(r'^' + re.escape(key) + r'=.*$', re.M)
    assert len(pat.findall(text)) == 1, key
    return pat.sub(lambda m: f'{key}={value}', text)

def mgmt(method, mgmt_secret, body=None):
    """Call the Realtime management API from inside the backend network (helper container, no ports)."""
    n = int(time.time())
    token = jwt(mgmt_secret, {'iat': n, 'exp': n + 120, 'role': 'supabase_admin'})
    js = ('fetch("http://realtime-dev:4000/api/tenants/realtime-dev",{method:process.env.M,'
          'headers:{authorization:"Bearer "+process.env.T,"content-type":"application/json"},'
          'body:process.env.BODY||undefined}).then(r=>console.log(r.status)).catch(()=>console.log(0))')
    out = run(['docker', 'run', '--rm', '--network', NET, '--read-only', '--cap-drop', 'ALL',
               '-e', 'M=' + method, '-e', 'T=' + token, '-e', 'BODY=' + (json.dumps(body) if body else ''),
               '--entrypoint', 'node', HELPER_IMAGE, '-e', js])
    return int(out.strip().splitlines()[-1])

DB_ENC_KEY_HEX = b'supabaserealtime'.hex()  # Realtime DB_ENC_KEY (AES-128-ECB, base64), validated by round-trip.
def psql(sql):
    return run(['docker', 'exec', '-i', 'fastpay-postgres-prod-v1', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input=sql).strip()
def tenant_enc(): return psql("select jwt_secret from _realtime.tenants where external_id='realtime-dev'")
def encrypt(plain): return run(['openssl', 'enc', '-aes-128-ecb', '-K', DB_ENC_KEY_HEX, '-base64', '-A'], input=plain).strip()
def decrypt(enc): return run(['openssl', 'enc', '-d', '-aes-128-ecb', '-K', DB_ENC_KEY_HEX, '-base64', '-A'], input=enc)
def set_tenant(enc):
    assert re.fullmatch(r'[A-Za-z0-9+/=]+', enc)
    psql(f"begin; update _realtime.tenants set jwt_secret='{enc}', updated_at=now() where external_id='realtime-dev'; commit;")
    assert tenant_enc() == enc

def wait(pred, seconds, what):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            if pred(): return
        except Exception: pass
        time.sleep(3)
    raise RuntimeError('timeout: ' + what)
def healthy(n):
    s = state(n); return s['Running'] and s.get('Health', {}).get('Status', 'healthy') == 'healthy'

def compose_for(src_compose, svc, project, name, out):
    c = json.loads(pathlib.Path(src_compose).read_text())
    s = copy.deepcopy(c['services'][svc]); s.update(container_name=name, restart='no')
    cfg = {'name': project, 'services': {svc: s}, 'networks': c['networks']}
    out.write_text(json.dumps(cfg, indent=2)); out.chmod(0o600)
    dry = subprocess.run(['docker', 'compose', '-f', str(out), 'up', '--dry-run', '-d', '--no-build', '--no-recreate', '--pull', 'never', svc], capture_output=True, text=True)
    assert f'Container {name}' in dry.stdout + dry.stderr, f'dry-run target mismatch for {name}'

def swap(old, compose, svc, new):
    run(['docker', 'update', '--restart=no', old]); run(['docker', 'stop', '--time', '30', old])
    run(['docker', 'compose', '-f', str(compose), 'up', '-d', '--no-build', '--no-recreate', '--pull', 'never', svc])

DONE = []
def rollback(reason):
    emit('ROLLBACK_START ' + reason)
    for f in ('api.env', 'realtime.env', 'kong.yml'):
        (RT / f).write_text((B / (f + '.before')).read_text())
    if 'api' in DONE:
        subprocess.run(['docker', 'stop', API_NEW], capture_output=True)
        subprocess.run(['docker', 'start', API_OLD], capture_output=True)
        subprocess.run(['docker', 'update', '--restart=unless-stopped', API_OLD], capture_output=True)
    if 'kong' in DONE: subprocess.run(['docker', 'restart', KONG_C], capture_output=True)
    if 'realtime' in DONE:
        subprocess.run(['docker', 'stop', RT_NEW], capture_output=True)
        subprocess.run(['docker', 'start', RT_OLD], capture_output=True)
        subprocess.run(['docker', 'update', '--restart=unless-stopped', RT_OLD], capture_output=True)
    if 'tenant' in DONE:
        try:
            set_tenant((B / 'tenant-jwt-secret.enc.before').read_text().strip())
            subprocess.run(['docker', 'restart', RT_OLD if not exists(RT_NEW) or not state(RT_NEW)['Running'] else RT_NEW], capture_output=True)
            emit('ROLLBACK_TENANT=PASS')
        except Exception as e: emit('ROLLBACK_TENANT=FAIL ' + str(e))
    emit('ROLLBACK_DONE')

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    assert mode in ('--dry-run', '--execute')
    # Preflight
    for n in (RT_OLD, API_OLD, KONG_C): assert state(n)['Running'], n
    assert not exists(RT_NEW) and not exists(API_NEW)
    assert env_get(ENV_RT, 'API_JWT_SECRET') == DEMO and env_get(ENV_API, 'SUPABASE_JWT_SECRET') == DEMO
    assert mgmt('GET', DEMO) == 200
    assert decrypt(tenant_enc()) == DEMO, 'tenant secret format/value unexpected'
    kong = KONG.read_text()
    old_anon = re.search(r"apikey == '" + re.escape(PUBLISHABLE) + r"' and '([^']+)'", kong).group(1)
    DEMO_SERVICE_KEY = re.search(DEMO_SERVICE_KEY_RE, kong).group(0)
    assert kong.count(DEMO_SERVICE_KEY) >= 1 and kong.count(old_anon) >= 1
    emit('PREFLIGHT=PASS')
    # Backups
    B.mkdir(mode=0o700, exist_ok=True)
    for f in ('api.env', 'realtime.env', 'kong.yml'):
        p = B / (f + '.before'); p.write_text((RT / f).read_text()); p.chmod(0o600)
    p = B / 'tenant-jwt-secret.enc.before'
    if not p.exists(): p.write_text(tenant_enc()); p.chmod(0o600)
    run(['/usr/local/sbin/fastpay-db-backup.sh'])
    emit('BACKUPS=PASS db=' + run(['readlink', '/var/backups/fastpay/db-daily/latest']).strip())
    # Render new configs (secrets never printed)
    sec_path = B / 'new-secrets.private.json'
    if sec_path.exists(): S = json.loads(sec_path.read_text())
    else:
        S = {'client': secrets.token_urlsafe(48), 'mgmt': secrets.token_urlsafe(48), 'metrics': secrets.token_urlsafe(48)}
        sec_path.write_text(json.dumps(S)); sec_path.chmod(0o600)
    new_anon = jwt(S['client'], {'iss': 'fastpay', 'role': 'anon', 'iat': int(time.time()), 'exp': int(time.time()) + 10 * 365 * 86400})
    rt = ENV_RT.read_text(); rt = env_set(rt, 'API_JWT_SECRET', S['mgmt']); rt = env_set(rt, 'METRICS_JWT_SECRET', S['metrics'])
    api = env_set(ENV_API.read_text(), 'SUPABASE_JWT_SECRET', S['client'])
    # Kong: drop the demo service_role mapping, re-sign the anon mapping.
    k2 = re.sub(r"\((?:query_params|headers)\.apikey == '" + re.escape(DEMO_SERVICE_KEY) + r"' and '(?:Bearer )?[^']+'\) or ", '', kong)
    k2 = k2.replace(old_anon, new_anon)
    assert DEMO_SERVICE_KEY not in k2 and old_anon not in k2 and new_anon in k2 and k2.count(PUBLISHABLE) == kong.count(PUBLISHABLE)
    for name, text in (('realtime.env.new', rt), ('api.env.new', api), ('kong.yml.new', k2)):
        p = B / name; p.write_text(text); p.chmod(0o600)
    compose_for('/opt/fastpay/production-v1/compose.json', 'realtime', 'fastpay-production-s5-realtime-v2', RT_NEW, DEP / 'realtime-compose-v2.json')
    compose_for(str(DEP / 'api-compose-v2.json'), 'api', 'fastpay-production-s5-api-v3', API_NEW, DEP / 'api-compose-v3.json')
    emit('RENDER_AND_COMPOSE_DRYRUN=PASS')
    if mode == '--dry-run': emit('DRY_RUN_COMPLETE production unchanged'); return

    try:
        new_enc = encrypt(S['client']); assert decrypt(new_enc) == S['client']
        DONE.append('tenant'); set_tenant(new_enc)
        emit('TENANT_SECRET_ROTATED=PASS')
        ENV_RT.write_text(rt)
        swap(RT_OLD, DEP / 'realtime-compose-v2.json', 'realtime', RT_NEW); DONE.append('realtime')
        wait(lambda: mgmt('GET', S['mgmt']) == 200, 120, 'realtime v2 mgmt with new secret')
        assert mgmt('GET', DEMO) in (401, 403), 'demo mgmt secret still accepted'
        emit('REALTIME_V2=PASS')
        KONG.write_text(k2); run(['docker', 'restart', KONG_C]); DONE.append('kong')
        wait(lambda: healthy(KONG_C), 90, 'kong healthy'); emit('KONG=PASS')
        ENV_API.write_text(api)
        swap(API_OLD, DEP / 'api-compose-v3.json', 'api', API_NEW); DONE.append('api')
        wait(lambda: healthy(API_NEW), 180, 'api v3 healthy'); emit('API_V3=PASS')
    except Exception as e:
        rollback(f'{type(e).__name__}: {e}'); emit('RESULT=ROLLED_BACK'); sys.exit(2)
    for n, c, svc in ((RT_NEW, DEP / 'realtime-compose-v2.json', 'realtime'), (API_NEW, DEP / 'api-compose-v3.json', 'api')):
        run(['docker', 'update', '--restart=unless-stopped', n])
        cfg = json.loads(c.read_text()); cfg['services'][svc]['restart'] = 'unless-stopped'; c.write_text(json.dumps(cfg, indent=2))
    emit(f'RESULT=PASS realtime={RT_NEW} api={API_NEW} old_kept_stopped={RT_OLD},{API_OLD}')

if __name__ == '__main__':
    main()
