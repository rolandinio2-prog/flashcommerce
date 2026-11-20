// Only installed in the new private release; public values frozen by Next build.
const fs=require('node:fs'),{parseEnv}=require('node:util'),{spawnSync}=require('node:child_process');
function validate(values){
 const allowed=new Set(['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_FLASH_API_URL','NEXT_PUBLIC_FLASH_TENANT_CODE','NEXT_PUBLIC_FLASH_OPEN_STANDARD_MAP_STYLE_URL']);
 if(Object.keys(values).length!==allowed.size||Object.keys(values).some(k=>!allowed.has(k)))throw Error('PUBLIC_BUILD_KEYS_INVALID');
 if(values.NEXT_PUBLIC_SUPABASE_URL!=='https://s2-acceptance.fastpay.com.bo'||values.NEXT_PUBLIC_FLASH_API_URL!=='/api/v1'||values.NEXT_PUBLIC_FLASH_TENANT_CODE!=='S4BRW002'||values.NEXT_PUBLIC_FLASH_OPEN_STANDARD_MAP_STYLE_URL!=='/__stage/map-style.json')throw Error('PRIVATE_PUBLIC_CONFIG_REQUIRED');
 let claims;try{claims=JSON.parse(Buffer.from(values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.split('.')[1],'base64url').toString());}catch{throw Error('PUBLIC_KEY_INVALID');}
 if(claims.role!=='anon'||!Number.isFinite(claims.exp)||claims.exp*1000<=Date.now())throw Error('ONLY_PUBLIC_ANON_KEY_ALLOWED');
 return values;
}
function main(){const values=validate(parseEnv(fs.readFileSync('/run/secrets/public_env','utf8')));const result=spawnSync('pnpm',['run','build'],{stdio:'inherit',env:{...process.env,...values,NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTICS:'B10_EARLY_V1',NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTIC_BUILD:'b10-early-local-candidate',FLASH_API_INTERNAL_URL:'http://s4-browser-api-v2:3001',FLASH_API_URL:'http://s4-browser-api-v2:3001',NEXT_TELEMETRY_DISABLED:'1'}});if(result.error||result.status!==0)process.exit(result.status||1);if(!fs.existsSync('.next/standalone/server.js'))throw Error('STANDALONE_SERVER_MISSING');}
if(require.main===module)main();module.exports={validate};
