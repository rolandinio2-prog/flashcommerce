// LOCAL CANDIDATE ONLY. No live installation, navigation, fetch or auth mutation.
export const markerKey='__flashB10InitialDiagnosticArmV1';
const origin='https://s2-acceptance.fastpay.com.bo';
const lifetime=120000;
function validRun(v){return typeof v==='string'&&/^[a-zA-Z0-9-]{12,80}$/.test(v);}
function validBuild(v){return typeof v==='string'&&/^[a-zA-Z0-9-]{12,80}$/.test(v);}
export function createEarlyArm({enabled,build,location,storage,now,start}){
 let attempted=false,bootConsumed=false;
 function scope(path){return enabled===true&&validBuild(build)&&location.origin===origin&&location.pathname===path&&!location.hash;}
 return {
  arm(runId){
   if(attempted) return {ok:false,reason:'ARM_ONCE'};
   attempted=true;
   if(!scope('/ops')||!validRun(runId))return {ok:false,reason:'ARM_SCOPE'};
   try{
    if(storage.getItem(markerKey)!==null)return {ok:false,reason:'PRIOR_MARKER'};
    const at=now();if(!Number.isSafeInteger(at)||at<0)return {ok:false,reason:'CLOCK_INVALID'};
    storage.setItem(markerKey,JSON.stringify({version:1,runId,build,at}));
    return {ok:true,armed:true,expiresInMs:lifetime};
   }catch{return {ok:false,reason:'STORAGE_UNAVAILABLE'};}
  },
  consumeBeforeRequests(){
   if(bootConsumed)return {active:false,reason:'BOOT_ONCE'};
   bootConsumed=true;
   if(!scope('/ops/delivery-monitor')||location.search)return {active:false,reason:'BOOT_SCOPE'};
   let raw;
   try{raw=storage.getItem(markerKey);if(raw===null)return {active:false,reason:'NOT_ARMED'};storage.removeItem(markerKey);}
   catch{return {active:false,reason:'STORAGE_UNAVAILABLE'};}
   try{
    if(typeof raw!=='string'||raw.length>320)return {active:false,reason:'MARKER_INVALID'};
    const m=JSON.parse(raw),keys=Object.keys(m).sort().join(',');
    if(keys!=='at,build,runId,version'||m.version!==1||!validRun(m.runId)||m.build!==build||!Number.isSafeInteger(m.at))return {active:false,reason:'MARKER_INVALID'};
    const t=now(),age=t-m.at;
    if(!Number.isSafeInteger(t)||age<0||age>lifetime)return {active:false,reason:'MARKER_EXPIRED'};
    // Synchronous invocation; caller must place boot before all instrumented reads.
    // Ownership is adopted by the document endpoint so STOP can use the same run.
    start();return {active:true,owner:m.runId,armedBeforeRequests:true};
   }catch{return {active:false,reason:'BOOT_EXCEPTION',cleanupRequired:true};}
  }
 };
}
