// Isolated candidate. Disabled by default; memory only. Never expose raw errors.
type Scope='STAFF_ME'|'WATCHER';
type Stage='FETCH'|'HTTP'|'ERROR_BODY'|'BODY_READ'|'JSON_PARSE'|'READ'|'ACCEPT'|'LOGOUT';
type Outcome='OK'|'REJECTED'|'THREW';
type RecordValue={ordinal:number;scope:Scope;stage:Stage;outcome:Outcome;exceptionClass:string|null;status:number|null};
let active=false,epoch=0,ordinal=0,dropped=0;
let records:RecordValue[]=[];
const classes=new Set(['AbortError','TimeoutError','SyntaxError','TypeError','Error','FlashApiError']);
const scopes=new Set(['STAFF_ME','WATCHER']);
const stages=new Set(['FETCH','HTTP','ERROR_BODY','BODY_READ','JSON_PARSE','READ','ACCEPT','LOGOUT']);
const outcomes=new Set(['OK','REJECTED','THREW']);
function classify(error:unknown):string|null {
  if(error===undefined)return null;
  try {const name=(error as {name?:unknown})?.name;return typeof name==='string'&&classes.has(name)?name:'OTHER';}
  catch{return 'UNREADABLE';}
}
export type StaffDiagnostic={record:(stage:Stage,outcome:Outcome,error?:unknown,status?:number)=>void};
export function newStaffDiagnostic(scope:Scope):StaffDiagnostic {
  const ownedEpoch=epoch,id=active?++ordinal:0;
  return {record(stage,outcome,error,status){
    try {
      if(!active||!id||ownedEpoch!==epoch)return;
      if(!scopes.has(scope)||!stages.has(stage)||!outcomes.has(outcome)){dropped++;return;}
      if(records.length>=128){dropped++;return;}
      records.push({ordinal:id,scope,stage,outcome,exceptionClass:classify(error),
        status:typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:null});
    }catch{/* Diagnostics must never change an access decision. */}
  }};
}
export function startStaffDiagnostics():void {epoch++;records=[];ordinal=0;dropped=0;active=true;}
export function snapshotStaffDiagnostics(){return {active,dropped,coverageComplete:dropped===0,records:records.map(r=>({...r}))};}
export function stopStaffDiagnostics():void {active=false;epoch++;records=[];ordinal=0;dropped=0;}
