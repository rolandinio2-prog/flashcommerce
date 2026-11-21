// Production build: validates public (browser) configuration before 'next build'.
// Public values come from the BuildKit secret public_env and are frozen into the bundle.
const fs=require('node:fs');
const {parseEnv}=require('node:util');
const {spawnSync}=require('node:child_process');
const values=parseEnv(fs.readFileSync('/run/secrets/public_env','utf8'));
const allowed=new Set(['NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_FLASH_API_URL','NEXT_PUBLIC_FLASH_TENANT_CODE','NEXT_PUBLIC_FLASH_OPEN_STANDARD_MAP_STYLE_URL','NEXT_PUBLIC_FLASH_DEPLOYMENT']);
for(const key of Object.keys(values))if(!allowed.has(key))throw new Error('NON_PUBLIC_BUILD_VARIABLE');
if(!values.NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY)throw new Error('MAPS_BROWSER_KEY_REQUIRED');
// Production must use the public Realtime endpoint; staging (explicit flag) may only use a localhost tunnel.
const staging=values.NEXT_PUBLIC_FLASH_DEPLOYMENT==='staging';
if(values.NEXT_PUBLIC_FLASH_DEPLOYMENT && !staging)throw new Error('UNKNOWN_DEPLOYMENT');
if(values.NEXT_PUBLIC_SUPABASE_URL && !(values.NEXT_PUBLIC_SUPABASE_URL==='https://realtime.fastpay.com.bo' || (staging && /^http:\/\/localhost:[0-9]{2,5}$/.test(values.NEXT_PUBLIC_SUPABASE_URL))))throw new Error('REALTIME_ENDPOINT_MISMATCH');
if(values.NEXT_PUBLIC_FLASH_API_URL && values.NEXT_PUBLIC_FLASH_API_URL!=='/api/v1')throw new Error('BROWSER_API_MUST_BE_SAME_ORIGIN');
const key=values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if(key && !key.startsWith('sb_publishable_')){
 let role;try{role=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role}catch{}
 if(role!=='anon')throw new Error('PUBLIC_SUPABASE_KEY_MUST_BE_ANON');
}
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
if(pkg.name==='customer' && (!key || !values.NEXT_PUBLIC_SUPABASE_URL))throw new Error('CUSTOMER_REALTIME_BUILD_CONFIG_REQUIRED');
const result=spawnSync('pnpm',['run','build'],{stdio:'inherit',env:{...process.env,...values,FLASH_API_INTERNAL_URL:'http://api:3001',FLASH_API_URL:'http://api:3001',NEXT_TELEMETRY_DISABLED:'1'}});
if(result.error || result.status!==0)process.exit(result.status||1);
if(!fs.existsSync('.next/standalone/server.js'))throw new Error('STANDALONE_SERVER_MISSING');
