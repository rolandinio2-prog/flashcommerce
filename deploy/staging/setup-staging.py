#!/usr/bin/env python3
"""Private STAGING environment on the production droplet (isolated network, own secrets).

Phases (run as root, in order; each is idempotent-safe and verifies itself):
  images    build staging customer/driver images (Realtime URL = localhost tunnel) + tag api
  db        create staging Postgres, restore latest prod backup, anonymize, re-key Realtime tenant
  services  start Realtime, Kong, API, Customer, Driver for staging
  verify    health + isolation checks

Never touches production containers, networks, volumes or config files (read-only copies only).
Access from a PC only through an SSH tunnel to the fixed container IPs (no public exposure).
"""
import json, os, pathlib, re, secrets, shutil, subprocess, sys, time

TAG = 'staging-20261121-v1'
SRC = pathlib.Path('/opt/fastpay/releases/staging-20261121-v1')        # repo source (uploaded)
ETC = pathlib.Path('/etc/fastpay/staging-v1')                          # staging secrets/config (root 600)
DEP = pathlib.Path('/opt/fastpay/staging-v1')                          # compose
PROD_RT = pathlib.Path('/etc/fastpay/prod-runtime-v1')
PROD_PG = pathlib.Path('/etc/fastpay/prod-v1')
NET, SUBNET = 'fastpay-staging-v1-backend', '172.30.80.0/24'
IP = {'db': '172.30.80.2', 'api': '172.30.80.3', 'customer': '172.30.80.4', 'driver': '172.30.80.5',
      'realtime': '172.30.80.6', 'kong': '172.30.80.7'}
PG_IMAGE = 'public.ecr.aws/supabase/postgres@sha256:99b1729aeb0bac314445024fc149fbd39306170b61dd50800ccf180327ab3459'
RT_IMAGE = 'public.ecr.aws/supabase/realtime@sha256:85adbb7a33786dd4c213ecd9206d0e402a527ac1a0f725abbe0757ccba592693'
KONG_IMAGE = 'public.ecr.aws/supabase/kong@sha256:1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d'
PUBLISHABLE = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
TUNNEL = {'customer': 13000, 'api': 13001, 'driver': 13002, 'kong': 18000, 'db': 15433}

def emit(m): print(m, flush=True)
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode: raise RuntimeError(f'{" ".join(cmd[:4])} rc={r.returncode} {r.stderr.strip()[-400:]}')
    return r.stdout
def exists(n): return subprocess.run(['docker', 'inspect', n], capture_output=True).returncode == 0
def write(p, text, mode=0o600):
    p.write_text(text); p.chmod(mode)

def secrets_file():
    ETC.mkdir(mode=0o700, parents=True, exist_ok=True)
    p = ETC / 'secrets.private.json'
    if p.exists(): return json.loads(p.read_text())
    tok = lambda: secrets.token_urlsafe(48)
    s = {'pg_supabase_admin': tok(), 'pg_postgres': tok(), 'jwt_client': tok(), 'rt_mgmt': tok(),
         'rt_metrics': tok(), 'rt_secret_key_base': secrets.token_urlsafe(64), 'rt_db_enc_key': secrets.token_hex(8),
         'pgsodium_key': secrets.token_hex(32), 'cashier_key': tok(), 'ops_key': tok(), 'payment_lab_key': tok(),
         'pod_secret': tok(), 'staff_password': 'Stg-' + secrets.token_urlsafe(12)}
    write(p, json.dumps(s)); return s

def env_read(path):
    out = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1); out[k] = v
    return out
def env_text(d): return ''.join(f'{k}={v}\n' for k, v in d.items())

def jwt(secret, claims):
    import base64, hashlib, hmac
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
    h = b(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    p = b(json.dumps(claims, separators=(',', ':')).encode())
    return f'{h}.{p}.' + b(hmac.new(secret.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest())

# ---------------------------------------------------------------- images
def phase_images():
    assert (SRC / 'apps/customer/build-next.cjs').is_file()
    ETC.mkdir(mode=0o700, parents=True, exist_ok=True)
    node_image = pathlib.Path('/var/backups/fastpay/FLASHCOMMERCE_LINUX_BUILD_V1/node-image.txt').read_text().strip()
    for app in ('customer', 'driver'):
        prod_pub = env_read(pathlib.Path(f'/etc/fastpay/build/linux-20260928-v2/{app}-public.env'))
        pub = {k: v for k, v in prod_pub.items()}
        if app == 'customer':
            pub['NEXT_PUBLIC_SUPABASE_URL'] = f'"http://localhost:{TUNNEL["kong"]}"'
            pub['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] = f'"{PUBLISHABLE}"'
        pub['NEXT_PUBLIC_FLASH_DEPLOYMENT'] = '"staging"'
        pf = ETC / f'{app}-public.env'; write(pf, env_text(pub))
        emit(f'BUILD_{app.upper()}_START')
        run(['docker', 'build', '--platform', 'linux/amd64', '--build-arg', 'NODE_IMAGE=' + node_image,
             '--secret', f'id=public_env,src={pf}', '--tag', f'fastpay/{app}:{TAG}', str(SRC / 'apps' / app)],
            env={**os.environ, 'DOCKER_BUILDKIT': '1'}, timeout=1800)
    run(['docker', 'tag', 'fastpay/api:prod-s5-20261121-v1', f'fastpay/api:{TAG}'])
    emit('IMAGES=PASS')

# ---------------------------------------------------------------- db
def psql(sql, db='postgres', user='supabase_admin', check=True, extra=()):
    cmd = ['docker', 'exec', '-i', 'fastpay-staging-postgres-v1', 'psql', '-U', user, '-d', db, '-At', *extra]
    if check: cmd += ['-v', 'ON_ERROR_STOP=1']
    r = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    if check and r.returncode: raise RuntimeError(r.stderr[-500:])
    return r.stdout.strip()

def compose_doc(S):
    prod_pg = json.loads(run(['docker', 'inspect', 'fastpay-postgres-prod-v1']))[0]
    pg_env = {e.split('=', 1)[0]: e.split('=', 1)[1] for e in prod_pg['Config']['Env'] if e.split('=', 1)[0].startswith(('POSTGRES', 'PGDATA', 'LANG', 'LC_'))}
    common = {'restart': 'unless-stopped', 'security_opt': ['no-new-privileges:true'], 'pids_limit': 256}
    net = lambda svc, aliases=(): {'backend': {'ipv4_address': IP[svc], 'aliases': list(aliases)}}
    app_sec = {'read_only': True, 'cap_drop': ['ALL']}
    return {
        'name': 'fastpay-staging-v1',
        'services': {
            'db': {**common, 'image': PG_IMAGE, 'container_name': 'fastpay-staging-postgres-v1', 'entrypoint': ['/bin/sh'],
                   'command': prod_pg['Config']['Cmd'], 'environment': pg_env, 'shm_size': '64m', 'mem_limit': '1g',
                   'volumes': ['fastpay-staging-postgres-v1-data:/var/lib/postgresql/data',
                               f'{ETC}/pg_hba.conf:/etc/fastpay/pg_hba.conf:ro,Z',
                               f'{ETC}/postgresql.conf:/etc/fastpay/postgresql.conf:ro,Z',
                               f'{ETC}/pgsodium_root.key:/etc/postgresql-custom/pgsodium_root.key:ro,Z',
                               f'{ETC}/pgsodium_getkey.sh:/usr/lib/postgresql/bin/pgsodium_getkey.sh:ro,Z'],
                   'networks': net('db', ['database-staging-v1'])},
            'realtime': {**common, 'image': RT_IMAGE, 'container_name': 'fastpay-staging-realtime-v1', 'command': ['/app/bin/server'],
                         'env_file': [{'path': f'{ETC}/realtime.env', 'format': 'raw'}], 'mem_limit': '768m',
                         'networks': net('realtime', ['realtime-dev'])},
            'kong': {**common, **app_sec, 'image': KONG_IMAGE, 'container_name': 'fastpay-staging-kong-v1',
                     'entrypoint': ['/docker-entrypoint.sh'], 'command': ['kong', 'docker-start'], 'user': 'kong',
                     'tmpfs': ['/tmp:uid=100,gid=65533'], 'env_file': [{'path': f'{ETC}/kong.env', 'format': 'raw'}],
                     'volumes': [f'{ETC}/kong.yml:/home/kong/kong.yml:ro,Z'], 'mem_limit': '256m', 'networks': net('kong')},
            'api': {**common, **app_sec, 'image': f'fastpay/api:{TAG}', 'container_name': 'fastpay-staging-api-v1',
                    'environment': {'NODE_ENV': 'production', 'PORT': '3001'}, 'tmpfs': ['/tmp'],
                    'env_file': [{'path': f'{ETC}/api.env', 'format': 'raw'}], 'mem_limit': '512m',
                    'networks': {**net('api', ['api']), 'egress': {}}},
            'customer': {**common, **app_sec, 'image': f'fastpay/customer:{TAG}', 'container_name': 'fastpay-staging-customer-v1',
                         'environment': {'NODE_ENV': 'production', 'PORT': '3000', 'HOSTNAME': '0.0.0.0', 'FLASH_API_INTERNAL_URL': 'http://api:3001'},
                         'tmpfs': ['/tmp', '/app/.next/cache:uid=1000,gid=1000'], 'mem_limit': '768m', 'networks': net('customer')},
            'driver': {**common, **app_sec, 'image': f'fastpay/driver:{TAG}', 'container_name': 'fastpay-staging-driver-v1',
                       'environment': {'NODE_ENV': 'production', 'PORT': '3000', 'HOSTNAME': '0.0.0.0', 'FLASH_API_INTERNAL_URL': 'http://api:3001'},
                       'tmpfs': ['/tmp', '/app/.next/cache:uid=1000,gid=1000'], 'mem_limit': '768m', 'networks': net('driver')},
        },
        'networks': {'backend': {'name': NET, 'internal': True, 'ipam': {'config': [{'subnet': SUBNET}]}},
                     'egress': {'external': True, 'name': 'fastpay-api-egress-v1'}},
        'volumes': {'fastpay-staging-postgres-v1-data': {'name': 'fastpay-staging-postgres-v1-data'}},
    }

def render_config(S):
    # Postgres config copied from prod; own pgsodium key.
    for f in ('pg_hba.conf', 'postgresql.conf', 'pgsodium_getkey.sh'):
        shutil.copy2(PROD_PG / f, ETC / f)
    (ETC / 'pgsodium_getkey.sh').chmod(0o755)
    write(ETC / 'pgsodium_root.key', S['pgsodium_key'] + '\n', 0o644)
    # Realtime: own secrets and DB; same image/flags as prod.
    rt = env_read(PROD_RT / 'realtime.env')
    rt.update(DB_HOST='database-staging-v1', DB_PASSWORD=S['pg_supabase_admin'], DB_ENC_KEY=S['rt_db_enc_key'],
              API_JWT_SECRET=S['rt_mgmt'], METRICS_JWT_SECRET=S['rt_metrics'], SECRET_KEY_BASE=S['rt_secret_key_base'],
              SLOT_NAME_SUFFIX='staging', SEED_SELF_HOST='false')
    write(ETC / 'realtime.env', env_text(rt))
    # Kong: prod routes; anon mapping re-signed with the staging client secret.
    shutil.copy2(PROD_RT / 'kong.env', ETC / 'kong.env'); (ETC / 'kong.env').chmod(0o600)
    kong = (PROD_RT / 'kong.yml').read_text()
    old_anon = re.search(r"apikey == '" + re.escape(PUBLISHABLE) + r"' and '([^']+)'", kong).group(1)
    anon = jwt(S['jwt_client'], {'iss': 'fastpay-staging', 'role': 'anon', 'iat': int(time.time()), 'exp': int(time.time()) + 5 * 365 * 86400})
    kong = kong.replace(old_anon, anon)
    assert 'sb_secret_' not in kong
    write(ETC / 'kong.yml', kong, 0o644)
    # API: no bank credentials, mock payments, own keys, staging DB and origins.
    api = env_read(PROD_RT / 'api.env')
    for k in list(api):
        if k.startswith('BCP_QR_') and k not in ('BCP_QR_ENVIRONMENT',): del api[k]
    api.update(DATABASE_URL=f"postgresql://postgres:{S['pg_postgres']}@database-staging-v1:5432/postgres",
               SUPABASE_JWT_SECRET=S['jwt_client'], PAYMENT_PROVIDER='MOCK', BCP_QR_ENVIRONMENT='sandbox',
               PAYMENT_DEV_TOOLS_ENABLED='true', ENABLE_MOCK_PAYMENT_CONFIRMATION='true',
               CASHIER_ACCESS_KEY=S['cashier_key'], OPS_ACCESS_KEY=S['ops_key'], PAYMENT_LAB_KEY=S['payment_lab_key'],
               FLASH_DELIVERY_POD_SECRET=S['pod_secret'],
               FLASH_ALLOWED_ORIGINS=f'http://localhost:{TUNNEL["customer"]},http://localhost:{TUNNEL["driver"]}',
               FLASH_CUSTOMER_URL=f'http://localhost:{TUNNEL["customer"]}')
    write(ETC / 'api.env', env_text(api))
    DEP.mkdir(mode=0o700, parents=True, exist_ok=True)
    write(DEP / 'compose.json', json.dumps(compose_doc(S), indent=2))
    run(['docker', 'compose', '-f', str(DEP / 'compose.json'), 'config', '--quiet'])

def enc(plain, key):  # Realtime field encryption (AES-128-ECB, base64), validated against prod round-trip.
    return run(['openssl', 'enc', '-aes-128-ecb', '-K', key.encode().hex(), '-base64', '-A'], input=plain).strip()

def phase_db():
    S = secrets_file()
    assert not exists('fastpay-staging-postgres-v1'), 'staging db exists (remove manually to rebuild)'
    used = run(['docker', 'network', 'ls', '--format', '{{.Name}}'])
    assert NET not in used
    render_config(S)
    run(['docker', 'compose', '-f', str(DEP / 'compose.json'), 'up', '-d', '--no-build', '--pull', 'never', 'db'])
    deadline = time.time() + 120
    while subprocess.run(['docker', 'exec', 'fastpay-staging-postgres-v1', 'pg_isready', '-U', 'supabase_admin'], capture_output=True).returncode:
        assert time.time() < deadline, 'db not ready'; time.sleep(3)
    backup = pathlib.Path(run(['readlink', '-f', '/var/backups/fastpay/db-daily/latest']).strip())
    emit('RESTORE_FROM=' + backup.name)
    # Roles, then databases (errors for objects pre-created by initdb/extensions are expected and ignored).
    psql((backup / 'globals.sql').read_text(), check=False)
    for db in ('_supabase', 'storage_vectors'):
        subprocess.run(['docker', 'exec', 'fastpay-staging-postgres-v1', 'createdb', '-U', 'supabase_admin', db], capture_output=True)
    for db in ('postgres', '_supabase', 'storage_vectors'):
        with open(backup / f'{db}.dump', 'rb') as f:
            subprocess.run(['docker', 'exec', '-i', 'fastpay-staging-postgres-v1', 'pg_restore', '-U', 'supabase_admin', '-d', db, '--no-password'],
                           stdin=f, capture_output=True)
    restored = int(psql('select count(*) from public.orders'))
    assert restored > 0, 'restore produced no orders'
    emit(f'RESTORED orders={restored}')
    # Fresh passwords for every login role (never reuse production hashes).
    roles = psql("select rolname from pg_roles where rolcanlogin").split()
    stmts = []
    for r in roles:
        pw = S['pg_supabase_admin'] if r == 'supabase_admin' else S['pg_postgres'] if r == 'postgres' else secrets.token_urlsafe(32)
        stmts.append(f"alter role \"{r}\" password '{pw}';")
    psql('\n'.join(stmts))
    # Anonymize (guarded by fastpay.staging=yes).
    hash_js = ('const c=require("crypto");const s=c.randomBytes(16);'
               'console.log("scrypt$"+s.toString("base64url")+"$"+c.scryptSync(process.env.P,s,64).toString("base64url"))')
    h = run(['docker', 'run', '--rm', '--network', 'none', '-e', 'P=' + S['staff_password'], '--entrypoint', 'node', f'fastpay/api:{TAG}', '-e', hash_js]).strip()
    anon_sql = (SRC / 'deploy/staging/anonymize.sql').read_text()
    out = run(['docker', 'exec', '-i', '-e', 'PGOPTIONS=-c fastpay.staging=yes', 'fastpay-staging-postgres-v1', 'psql',
               '-U', 'supabase_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-v', f'staging_password_hash={h}'], input=anon_sql)
    emit('ANONYMIZED ' + ' '.join(out.split()[-8:]))
    # Realtime tenant: own client secret + extension DB settings pointing to the STAGING database.
    key = S['rt_db_enc_key']
    psql(f"update _realtime.tenants set jwt_secret='{enc(S['jwt_client'], key)}' where external_id='realtime-dev';")
    settings = json.loads(psql("select settings::text from _realtime.extensions where tenant_external_id='realtime-dev' and type='postgres_cdc_rls'"))
    settings.update(db_host=enc('database-staging-v1', key), db_name=enc('postgres', key), db_port=enc('5432', key),
                    db_user=enc('supabase_admin', key), db_password=enc(S['pg_supabase_admin'], key))
    psql("update _realtime.extensions set settings='" + json.dumps(settings).replace("'", "''") + "'::jsonb where tenant_external_id='realtime-dev' and type='postgres_cdc_rls';")
    psql("select pg_drop_replication_slot(slot_name) from pg_replication_slots;", check=False)
    emit('DB=PASS orders=' + psql('select count(*) from public.orders'))

# ---------------------------------------------------------------- services / verify
def phase_services():
    for svc in ('realtime', 'kong', 'api', 'customer', 'driver'):
        run(['docker', 'compose', '-f', str(DEP / 'compose.json'), 'up', '-d', '--no-build', '--pull', 'never', svc])
    emit('SERVICES_STARTED')

def phase_verify():
    S = secrets_file()
    names = ['fastpay-staging-' + n for n in ('postgres-v1', 'realtime-v1', 'kong-v1', 'api-v1', 'customer-v1', 'driver-v1')]
    deadline = time.time() + 180
    while True:
        st = {n: json.loads(run(['docker', 'inspect', n]))[0]['State'] for n in names}
        bad = [n for n, s in st.items() if not s['Running'] or s.get('Health', {}).get('Status') == 'unhealthy']
        starting = [n for n, s in st.items() if s.get('Health', {}).get('Status') == 'starting']
        if not bad and not starting: break
        assert time.time() < deadline, f'not healthy: {bad or starting}'
        time.sleep(5)
    # Isolation: staging realtime/api must not reach production DB; staging DB must be anonymized.
    probe = ('const n=require("net");const s=n.connect(5432,"database-prod-v1");s.setTimeout(4000);'
             's.on("connect",()=>{console.log("PROD_DB_REACHABLE");process.exit(0)});'
             's.on("error",()=>{console.log("PROD_DB_UNREACHABLE");process.exit(0)});s.on("timeout",()=>{console.log("PROD_DB_UNREACHABLE");process.exit(0)})')
    iso = run(['docker', 'exec', 'fastpay-staging-api-v1', 'node', '-e', probe]).strip()
    assert iso == 'PROD_DB_UNREACHABLE', iso
    pii = psql("select count(*) from public.staff_users where email is not null")
    assert pii == '0'
    emit(f'VERIFY=PASS isolation={iso} ips={json.dumps(IP)}')

if __name__ == '__main__':
    {'images': phase_images, 'db': phase_db, 'services': phase_services, 'verify': phase_verify}[sys.argv[1]]()
