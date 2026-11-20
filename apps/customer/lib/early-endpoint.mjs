import {createEarlyArm,markerKey} from './early-arm.mjs';
export const version='STAFF_ME_EARLY_V1';
export function install(w,env,d){
 if(!w||env.NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTICS!=='B10_EARLY_V1'||w.location.origin!=='https://s2-acceptance.fastpay.com.bo')return;
 const build=env.NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTIC_BUILD;
 if(!/^[-a-zA-Z0-9]{12,80}$/.test(build||'')||Object.hasOwn(w,'__flashStaffEarlyV1'))return;
 const doc=w.document,id=w.crypto.randomUUID();
 let owner=null,adopted=false,closed=false,boot={active:false};
 const arm=createEarlyArm({enabled:true,build,location:w.location,storage:w.sessionStorage,now:()=>Date.now(),start:()=>{
  const s=d.snapshotStaffDiagnostics();
  if(s.active||s.records.length||s.dropped)throw Error('PRIOR_REGISTRY');
  d.startStaffDiagnostics();
 }});
 const execute=(action,expected,run)=>{
  if(w.document!==doc||w.location.origin!=='https://s2-acceptance.fastpay.com.bo'||w.location.hash)return {error:'DOCUMENT_SCOPE'};
  const path=w.location.pathname;
  if(path!=='/ops'&&(path!=='/ops/delivery-monitor'||w.location.search))return {error:'DOCUMENT_SCOPE'};
  if(action==='PROOF')return {version,build,documentId:id,early:boot.active===true,bootReason:boot.reason??null};
  if(expected!==id)return {error:'DOCUMENT_CHANGED'};
  if(!/^[-a-zA-Z0-9]{12,80}$/.test(run||''))return {error:'RUN_BINDING'};
  if(action==='ARM'&&path==='/ops'&&!closed){const r=arm.arm(run);if(r.ok)owner=run;return r;}
  if(owner!==run||closed)return {error:'OWNER_REQUIRED'};
  if(action==='DISARM'&&path==='/ops'){
   try {const raw=w.sessionStorage.getItem(markerKey);if(raw!==null&&JSON.parse(raw).runId!==run)return {error:'MARKER_OWNER'};
    w.sessionStorage.removeItem(markerKey);closed=true;return {cleanupConfirmed:w.sessionStorage.getItem(markerKey)===null};
   }catch{return {error:'STORAGE_UNAVAILABLE'};}
  }
  if(action==='ADOPT'&&path==='/ops/delivery-monitor'&&boot.active&&!adopted){adopted=true;return {active:true,early:true};}
  if(action==='READ'&&adopted)return d.snapshotStaffDiagnostics();
  if(action==='STOP'&&path==='/ops/delivery-monitor'){
   d.stopStaffDiagnostics();closed=true;
   const s=d.snapshotStaffDiagnostics();
   try{return {cleanupConfirmed:!s.active&&!s.records.length&&!s.dropped&&w.sessionStorage.getItem(markerKey)===null};}
   catch{return {cleanupConfirmed:false,error:'STORAGE_UNAVAILABLE'};}
  }
  return {error:'ACTION_INVALID'};
 };
 Object.defineProperty(w,'__flashStaffEarlyV1',{value:Object.freeze({execute}),configurable:false,writable:false});
 // Synchronous module initialization: no await, timer, or effect before consumption.
 boot=arm.consumeBeforeRequests();
 if(boot.active)owner=boot.owner;
}
