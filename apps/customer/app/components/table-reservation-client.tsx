"use client";
import { useResetOnChange } from '../../lib/use-reset-on-change';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {createTableReservation,getReservationAvailability,getTableReservationTracking,type ReservationAvailabilityResponse,type TableReservation} from "../../lib/flash-api";
import CheckoutContact from "./checkout-contact";
import {FlashApiError,getCustomerRecoveryProfile,registerCustomerRecovery,loginCustomerRecovery,updateCustomerRecoveryName,normalizeRecoveryContactPhone,recoveryAccessError,type CustomerRecoveryProfile} from "../../lib/flash-api";
import styles from "./reservation-design.module.css";

interface TableReservationClientProps {tenantCode:string;branchCode:string;timeZone:string;restaurantName?:string;branchName?:string;onStartPreorder?:(reservation:TableReservation)=>void;onProfileSaved?:(profile:CustomerRecoveryProfile)=>void;}
type Step="welcome"|"schedule"|"table"|"contact"|"review"|"result";
const steps:Step[]=["schedule","table","contact","review"];
const titles:Record<Step,string>={welcome:"Reserva tu mesa",schedule:"Fecha y horario",table:"Zona y mesa",contact:"Tus datos",review:"Resumen de reserva",result:"Mi reserva"};
const terminal=(status:string)=>["COMPLETED","CANCELLED","NO_SHOW"].includes(status);
const labels:Record<string,string>={PENDING:"Pendiente de confirmación",CONFIRMED:"Confirmada",SEATED:"En el local",COMPLETED:"Completada",CANCELLED:"Cancelada",NO_SHOW:"No se presentó"};
function localParts(date:Date,timeZone:string){const values=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);const p=Object.fromEntries(values.map(v=>[v.type,v.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};}
export function reservationInstant(date:string,time:string,timeZone:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time))throw Error("Selecciona una fecha y hora válidas.");
 const wall=Date.parse(`${date}T${time}:00Z`);let stamp=wall;
 for(let i=0;i<4;i++){const p=localParts(new Date(stamp),timeZone);const diff=wall-Date.parse(`${p.date}T${p.time}:00Z`);if(!diff)break;stamp+=diff;}
 const check=localParts(new Date(stamp),timeZone);if(check.date!==date||check.time!==time)throw Error("Ese horario no existe en la zona horaria de la sucursal.");
 return new Date(stamp).toISOString();
}
export default function TableReservationClient({tenantCode,branchCode,timeZone,restaurantName,branchName,onStartPreorder,onProfileSaved}:TableReservationClientProps){
 const storageKey=`flashcommerce.tableReservation:${tenantCode}:${branchCode}`;
 const [open,setOpen]=useState(false),[step,setStep]=useState<Step>("welcome");
 const [date,setDate]=useState(""),[time,setTime]=useState(""),[duration,setDuration]=useState(90),[party,setParty]=useState(2);
 const [availability,setAvailability]=useState<ReservationAvailabilityResponse|null>(null),[tableId,setTableId]=useState(""),[zone,setZone]=useState("");
 const [name,setName]=useState(""),[phone,setPhone]=useState(""),[notes,setNotes]=useState("");
 const [active,setActive]=useState<TableReservation|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [uncertain,setUncertain]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),flight=useRef(false),request=useRef(0),alive=useRef(true);
 // eslint-disable-next-line react-hooks/set-state-in-effect -- initial slot uses the browser clock/localStorage after mount (avoids SSR hydration mismatch)
 useEffect(()=>{alive.current=true;const initial=localParts(new Date(Math.ceil((Date.now()+90*60000)/900000)*900000),timeZone);setDate(initial.date);setTime(initial.time);
 let disposed=false;let token:string|null=null;try{token=localStorage.getItem(storageKey);}catch{/* Optional browser storage. */}
 if(token)void getTableReservationTracking(token).then(r=>{if(!disposed&&r.tenant===tenantCode&&r.branch===branchCode)setActive(r.reservation);}).catch(()=>{/* Keep access on temporary network failure. */});
 return()=>{disposed=true;alive.current=false;request.current++;};},[storageKey,tenantCode,branchCode,timeZone]);
 useEffect(()=>{if(!active||terminal(active.status))return;let disposed=false,polling=false;
 const timer=setInterval(()=>{if(polling)return;polling=true;void getTableReservationTracking(active.trackingToken).then(r=>{if(!disposed&&r.tenant===tenantCode&&r.branch===branchCode)setActive(r.reservation);}).catch(()=>{}).finally(()=>{polling=false;});},5000);
 return()=>{disposed=true;clearInterval(timer);};},[active?.trackingToken,active?.status,tenantCode,branchCode]);
 useEffect(()=>{const el=dialog.current;if(!el)return;if(open&&!el.open)el.showModal();else if(!open&&el.open)el.close();},[open]);
 useEffect(()=>{if(open){heading.current?.focus();dialog.current?.querySelector('[data-scroll-body]')?.scrollTo(0,0);}},[step,open]);
 const [profile,setProfile]=useState<CustomerRecoveryProfile|null>(null),[pin,setPin]=useState("");
 const [contactMode,setContactMode]=useState<"recover"|"register">("recover"),[editingContact,setEditingContact]=useState(false);
 const [contactLoading,setContactLoading]=useState(false),[contactBusy,setContactBusy]=useState(false),[contactError,setContactError]=useState<string|null>(null);
 const contactFlight=useRef(false),contactEdited=useRef(false);
 const contactName=name.trim().replace(/\s+/g," "),contactPhone=normalizeRecoveryContactPhone(phone);
 const samePhone=Boolean(profile&&profile.tenantCode===tenantCode&&profile.phone===contactPhone);
 const nameValid=contactName.length>=2&&contactName.length<=120,phoneValid=/^[0-9]{7,15}$/.test(contactPhone);
 const contactReady=phoneValid&&(samePhone?nameValid&&(!editingContact||/^[0-9]{6}$/.test(pin)):/^[0-9]{6}$/.test(pin)&&(contactMode==="recover"||nameValid));
 const contactSaved=!editingContact&&contactReady&&samePhone&&profile?.fullName===contactName&&!contactBusy&&!contactLoading&&!contactError;
 const contactEnabled=open&&step==="contact"&&!busy;
 const contactKey=JSON.stringify([tenantCode,name,phone,pin,contactMode,editingContact,open,step]);
 // Bumps whenever contact inputs change; an in-flight save compares it to drop stale responses.
 const contactVersion=useRef(0);
 useLayoutEffect(()=>{contactVersion.current++;},[contactKey]);
 const contactMessage=contactLoading?"Verificando tus datos guardados…":(contactMode==="register"||samePhone)&&!nameValid?"Completa tu nombre completo.":!phoneValid?"Ingresa un teléfono válido.":!contactReady?"Completa tu código de recuperación de 6 dígitos.":"Tus datos se guardarán automáticamente.";
 useResetOnChange([open,tenantCode],()=>{if(open)setContactLoading(true);});
 useEffect(()=>{
  if(!open)return;let disposed=false;
  void getCustomerRecoveryProfile(tenantCode).then(p=>{
   if(disposed||p.tenantCode!==tenantCode)return;setProfile(p);setPin("");setContactError(null);
   if(!contactEdited.current){setName(p.fullName);setPhone(p.phone);setEditingContact(!p.fullName);}
  }).catch(()=>{if(!disposed)setProfile(null);})
    .finally(()=>{if(!disposed)setContactLoading(false);});
  return()=>{disposed=true;};
 },[open,tenantCode]);
 async function saveContact(){
  if(contactFlight.current||contactLoading||!contactEnabled||!contactReady)return;
  const version=contactVersion.current;
  contactFlight.current=true;setContactBusy(true);setContactError(null);
  try{
   if(editingContact&&samePhone)await updateCustomerRecoveryName(tenantCode,contactName,contactPhone,pin);
   else if(!samePhone&&contactMode==="recover")await loginCustomerRecovery(tenantCode,contactPhone,pin);
   else if(!samePhone)await registerCustomerRecovery(tenantCode,contactName,contactPhone,pin);
   const p=await getCustomerRecoveryProfile(tenantCode);
   if(!alive.current)return;
   if(version!==contactVersion.current)throw Error("Stale profile response");
   if(p.tenantCode!==tenantCode||p.phone!==contactPhone||(editingContact&&p.fullName!==contactName))throw Error("Profile mismatch");
   setProfile(p);setName(p.fullName);setPhone(p.phone);setPin("");setEditingContact(!p.fullName);onProfileSaved?.(p);
  }catch(e){
   if(!alive.current)return;
   if(e instanceof FlashApiError&&e.status===401)setProfile(null);
   setContactError(recoveryAccessError(e));
  }finally{contactFlight.current=false;if(alive.current)setContactBusy(false);}
 }
 useEffect(()=>{
  if(editingContact||!contactEnabled||!contactReady||contactSaved||contactBusy||contactLoading||contactError)return;
  const timer=window.setTimeout(()=>void saveContact(),900);
  return()=>window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[editingContact,contactKey,contactEnabled,contactReady,contactSaved,contactBusy,contactLoading,contactError]);

 // The dialog follows the visible viewport, not page scaling. Only its body scrolls.
 useEffect(()=>{
  if(!open)return;const el=dialog.current;if(!el)return;
  const y=window.scrollY,x=window.scrollX;
  const previous={overflow:document.body.style.overflow,position:document.body.style.position,top:document.body.style.top,width:document.body.style.width};
  Object.assign(document.body.style,{overflow:"hidden",position:"fixed",top:`-${y}px`,width:"100%"});
  const viewport=window.visualViewport;
  const resize=()=>{if(viewport&&Math.abs(viewport.scale-1)>.01)return;el.style.setProperty("--reservation-visible-height",`${viewport?.height??window.innerHeight}px`);el.style.setProperty("--reservation-visible-top",`${viewport?.offsetTop??0}px`);};
  const cancel=(event:Event)=>{if(event.cancelable)event.preventDefault();};
  const touch=(event:TouchEvent)=>{if(event.touches.length>1)cancel(event);};
  resize();viewport?.addEventListener("resize",resize);viewport?.addEventListener("scroll",resize);window.addEventListener("resize",resize);
  for(const event of ["gesturestart","gesturechange","gestureend"])el.addEventListener(event,cancel,{capture:true,passive:false});
  el.addEventListener("touchstart",touch,{capture:true,passive:false});el.addEventListener("touchmove",touch,{capture:true,passive:false});
  return()=>{
   viewport?.removeEventListener("resize",resize);viewport?.removeEventListener("scroll",resize);window.removeEventListener("resize",resize);
   for(const event of ["gesturestart","gesturechange","gestureend"])el.removeEventListener(event,cancel,true);
   el.removeEventListener("touchstart",touch,true);el.removeEventListener("touchmove",touch,true);
   Object.assign(document.body.style,previous);window.scrollTo(x,y);
  };
 },[open]);

 const selected=availability?.tables.find(t=>t.id===tableId&&t.available)||null;
 const zones=useMemo(()=>Array.from(new Set((availability?.tables||[]).filter(t=>t.available).map(t=>t.zone||"Salón"))),[availability]);
 const today=localParts(new Date(),timeZone).date;
 const dates=Array.from({length:7},(_,i)=>{const value=new Date(`${today}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+i);return value.toISOString().slice(0,10);});
 const dateLabel=(value:string)=>new Intl.DateTimeFormat("es-BO",{weekday:"short",day:"numeric",month:"short",timeZone:"UTC"}).format(new Date(`${value}T12:00:00Z`));
 const format=(value:string)=>new Date(value).toLocaleString("es-BO",{timeZone,day:"numeric",month:"long",hour:"2-digit",minute:"2-digit",hour12:false});
 const displayName=restaurantName||tenantCode,displayBranch=branchName||branchCode;
 function reset(){request.current++;setAvailability(null);setTableId("");setZone("");setError("");}
 function close(){if(flight.current||contactFlight.current)return;setOpen(false);}
 function contactValid(){if(contactSaved)return true;setError("Completa tus datos y espera a que se confirme el guardado automático.");return false;} async function load(){if(flight.current)return;flight.current=true;setBusy(true);setError("");const seq=++request.current;
 try{const when=reservationInstant(date,time,timeZone);if(Date.parse(when)<=Date.now())throw Error("Elige una fecha y hora futuras.");const result=await getReservationAvailability(tenantCode,branchCode,when,duration,party);
 if(seq!==request.current||!alive.current)return;if(result.tenant!==tenantCode||result.branch!==branchCode)throw Error("No pudimos validar la sucursal.");setAvailability(result);setTableId("");setZone("");setStep("table");
 }catch(e){if(alive.current)setError(e instanceof Error?e.message:"No pudimos consultar las mesas. Intenta otra hora.");}finally{flight.current=false;if(alive.current)setBusy(false);}}
 async function confirm(){if(flight.current||contactFlight.current||uncertain)return;if(!selected){setError("Selecciona una mesa disponible.");setStep("table");return;}if(!contactValid()){setStep("contact");return;}
 flight.current=true;setBusy(true);setError("");let submitted=false;
 try{let verified:CustomerRecoveryProfile;
 try{verified=await getCustomerRecoveryProfile(tenantCode);if(verified.tenantCode!==tenantCode||verified.phone!==contactPhone||verified.fullName!==contactName)throw Error("Profile mismatch");}
 catch(e){setProfile(null);setContactError(recoveryAccessError(e));setStep("contact");throw Error("Verifica tus datos de recuperación antes de confirmar la reserva.");}
 const when=reservationInstant(date,time,timeZone);const latest=await getReservationAvailability(tenantCode,branchCode,when,duration,party);
 if(latest.tenant!==tenantCode||latest.branch!==branchCode)throw Error("No pudimos validar la sucursal.");setAvailability(latest);
 if(!latest.tables.some(t=>t.id===tableId&&t.available)){setTableId("");setStep("table");throw Error("La mesa ya no está disponible. Elige otra mesa u otro horario.");}
 submitted=true;const result=await createTableReservation({tenantCode,branchCode,tableId,reservedFor:when,durationMinutes:duration,partySize:party,customerName:contactName,customerPhone:contactPhone,customerNotes:notes.trim()||undefined});
 if(result.tenant!==tenantCode||result.branch!==branchCode)throw Error("No pudimos validar el resultado de la reserva.");
 setActive(result.reservation);setStep("result");try{localStorage.setItem(storageKey,result.reservation.trackingToken);}catch{setError("Conserva el código de tu reserva; este navegador no permite guardar el acceso.");}
 }catch(e){if(submitted){setUncertain(true);setError("No pudimos confirmar el resultado. Consulta con el restaurante antes de volver a reservar para evitar duplicados.");}else setError(e instanceof Error?e.message:"No pudimos comprobar la disponibilidad.");}finally{flight.current=false;if(alive.current)setBusy(false);}}
 function next(){if(contactFlight.current)return;setError("");if(step==="welcome")setStep("schedule");else if(step==="schedule")void load();else if(step==="table"){if(selected)setStep("contact");}else if(step==="contact"){if(contactValid())setStep("review");}else if(step==="review")void confirm();}
 function back(){if(busy||contactBusy)return;setError("");if(step==="welcome"||step==="result")close();else {const n=steps.indexOf(step);setStep(n>0?steps[n-1]:"welcome");}}
 const validResult=active&&["CONFIRMED","SEATED"].includes(active.status);
 return <>
  <div className={styles.entry}><button type="button" className={styles.primary} onClick={()=>{setOpen(true);setError("");}}>Reservar una mesa</button>{active&&<button type="button" className={styles.secondary} onClick={()=>{setStep("result");setOpen(true);}}>Ver mi reserva</button>}</div>
  <dialog ref={dialog} className={styles.dialog} aria-labelledby="reservation-title" onCancel={e=>{e.preventDefault();close();}} onClose={()=>setOpen(false)}>
   <div className={styles.frame}>
    <header className={styles.header}><button type="button" className={styles.iconButton} aria-label="Volver" disabled={busy||contactBusy} onClick={back}>←</button><h2 ref={heading} tabIndex={-1} id="reservation-title">{titles[step]}</h2><button type="button" className={styles.iconButton} aria-label="Cerrar reservas" disabled={busy||contactBusy} onClick={close}>×</button></header>
    {steps.includes(step)&&<div className={styles.progress} aria-label={`Paso ${steps.indexOf(step)+1} de 4`}>{steps.map((s,i)=><span key={s} data-active={i<=steps.indexOf(step)}/>)}</div>}
    <fieldset className={styles.body} data-scroll-body disabled={busy||contactBusy}>
     {step!=="welcome"&&<p className={styles.branchLine}>{displayName} · {displayBranch}</p>}
     {step==="welcome"&&<><div className={styles.hero}>{tenantCode==="POLLO001"&&<img src="/images/menu/pollo-broaster-v2.webp" alt="Pollo para disfrutar en el restaurante"/>}<div><span>BUENA COMIDA, MEJORES MOMENTOS</span><h3>Tu próxima visita<br/>empieza aquí.</h3></div></div><div className={styles.branchCard}>{tenantCode==="POLLO001"&&<img src="/images/menu/mr-pollo-logo-v1.png" alt="Mr. Pollo"/>}<h3>{displayName}</h3><p>{displayBranch}</p><span className={styles.tag}>Sucursal de este menú</span></div><p className={styles.muted}>Elige la fecha, consulta las mesas disponibles y envía tu reserva en pocos pasos.</p></>}
     {step==="schedule"&&<><h3>¿Cuántas personas?</h3><div className={styles.stepper}><button aria-label="Quitar una persona" disabled={party<=1||busy} onClick={()=>{setParty(p=>p-1);reset();}}>−</button><output aria-live="polite">{party}</output><button aria-label="Agregar una persona" disabled={party>=50||busy} onClick={()=>{setParty(p=>p+1);reset();}}>+</button></div><h3>Selecciona la fecha</h3><div className={styles.dateStrip}>{dates.map(d=><button key={d} disabled={busy} aria-pressed={date===d} onClick={()=>{setDate(d);reset();}}>{dateLabel(d)}</button>)}</div><label className={styles.field}>Otra fecha<input type="date" value={date} min={today} disabled={busy} onChange={e=>{setDate(e.target.value);reset();}}/></label><div className={styles.columns}><label className={styles.field}>Horario<input type="time" step="900" value={time} disabled={busy} onChange={e=>{setTime(e.target.value);reset();}}/></label><label className={styles.field}>Duración<select value={duration} disabled={busy} onChange={e=>{setDuration(Number(e.target.value));reset();}}>{[60,90,120,150,180].map(n=><option key={n} value={n}>{n} minutos</option>)}</select></label></div><p className={styles.info}>Hora local de la sucursal. Consultaremos disponibilidad para {party} {party===1?"persona":"personas"} durante {duration} minutos.</p></>}
     {step==="table"&&<><h3>Elige dónde disfrutar</h3><p className={styles.muted}>{availability?.available||0} mesas disponibles para tu grupo.</p><div className={styles.zones}><button aria-pressed={!zone} onClick={()=>setZone("")}>Todas las zonas</button>{zones.map(z=><button key={z} aria-pressed={zone===z} onClick={()=>{setZone(z);setTableId("");}}>{z}</button>)}</div><div className={styles.tables}>{availability?.tables.filter(t=>!zone||(t.zone||"Salón")===zone).map(t=><button key={t.id} className={styles.tableCard} disabled={!t.available} aria-pressed={tableId===t.id} onClick={()=>{setTableId(t.id);setError("");}}><span className={styles.tableIcon} aria-hidden="true">▤</span><strong>{t.name}</strong><span>{t.zone||"Salón"} · Hasta {t.capacity} personas</span><small>{!t.available?(t.slotAvailability==="CAPACITY"?"Capacidad insuficiente":"No disponible"):tableId===t.id?"✓ Seleccionada":"Disponible"}</small></button>)}</div>{!availability?.available&&<div className={styles.info}><p>No hay mesas disponibles para ese horario.</p><button className={styles.secondary} onClick={()=>setStep("schedule")}>Elegir otro horario</button></div>}<p className={styles.info}>La disponibilidad se comprueba otra vez antes de registrar tu reserva.</p></>}
     {step==="contact"&&<><CheckoutContact name={name} phone={phone} pin={pin}
 mode={contactMode} onMode={v=>{contactEdited.current=true;setContactMode(v);setName("");setPin("");setContactError(null);setEditingContact(false);}}
 editing={editingContact} onEdit={()=>{setEditingContact(true);setPin("");setContactError(null);}} onCancelEdit={()=>{setName(profile?.fullName??"");setEditingContact(false);setPin("");setContactError(null);}} onSaveEdit={()=>void saveContact()} onName={v=>{contactEdited.current=true;setName(v);}} onPhone={v=>{contactEdited.current=true;if(profile){setName("");setProfile(null);setEditingContact(false);}setPhone(v);setPin("");}} onPin={setPin}
 disabled={busy||contactBusy||contactLoading} saved={contactSaved} samePhone={samePhone} saving={contactBusy} error={contactError}
 onRetry={()=>void saveContact()} retryDisabled={!contactReady||contactLoading} pending={!editingContact&&contactReady&&!contactSaved&&!contactBusy&&!contactLoading&&!contactError} message={contactMessage}
 savedHint="Recuperación activada · Tus datos también sirven para hacer pedidos." namePlaceholder="¿A nombre de quién reservamos?"/><label className={styles.field}>Comentarios (opcional)<textarea maxLength={200} placeholder="Celebración, silla para bebé o alguna indicación…" value={notes} onChange={e=>setNotes(e.target.value)}/><small className={styles.counter}>{notes.length}/200</small></label></>}
     {step==="review"&&<><h3>Todo listo para tu visita</h3><p className={styles.muted}>Revisa los datos antes de enviar tu solicitud.</p><div className={styles.summary}><button onClick={()=>setStep("schedule")}><span>Fecha y horario</span><strong>{dateLabel(date)} · {time}</strong><small>{duration} minutos · {party} personas · Editar</small></button><button onClick={()=>setStep("table")}><span>Zona y mesa</span><strong>{selected?.zone||"Salón"} · {selected?.name}</strong><small>Editar</small></button><button onClick={()=>setStep("contact")}><span>A nombre de</span><strong>{name}</strong><small>{phone} · Editar</small></button>{notes&&<p><span>Comentarios</span><strong>{notes}</strong></p>}</div><p className={styles.info}>El restaurante revisará tu solicitud. Podrás consultar su estado en «Ver mi reserva».</p></>}
     {step==="result"&&active&&<><div className={styles.result} data-success={!!validResult}><div className={styles.resultIcon} aria-hidden="true">{validResult?"✓":active.status==="PENDING"?"◷":"•"}</div><h3>{validResult?"¡Reserva confirmada!":active.status==="PENDING"?"¡Solicitud recibida!":labels[active.status]}</h3><p>{active.status==="PENDING"?"Esperamos la confirmación del restaurante.":validResult?"Te esperamos para disfrutar.":"Consulta los detalles de tu reserva."}</p></div><div className={styles.code}><span>Código de reserva</span><strong>{active.reservationCode}</strong></div><dl className={styles.details}><div><dt>Estado</dt><dd>{labels[active.status]}</dd></div><div><dt>Fecha y hora</dt><dd>{format(active.reservedFor)}</dd></div><div><dt>Duración</dt><dd>{active.durationMinutes} minutos</dd></div><div><dt>Personas</dt><dd>{active.partySize}</dd></div><div><dt>Mesa</dt><dd>{active.table.name} · {active.table.zone||"Salón"}</dd></div><div><dt>Responsable</dt><dd>{active.customerName}</dd></div></dl><section className={styles.whatsappNotice} aria-label="Información de WhatsApp"><div><h3>Tus datos por WhatsApp</h3><span>Pendiente de habilitar</span></div><p>Cuando habilitemos el servicio, el envío incluirá:</p><ul><li><strong>Enlace del pedido</strong><small>{active.preorder?"Tu pedido ya está vinculado a esta reserva.":"Disponible cuando agregues un pedido a tu reserva."}</small></li><li><strong>Código de recuperación</strong><small>El código que elegiste al guardar tus datos.</small></li><li><strong>Código de reserva</strong><small>{active.reservationCode}</small></li></ul><p className={styles.whatsappPending}>Por ahora no se envían mensajes automáticos. Conserva tu código y consulta «Ver mi reserva».</p></section>{active.preorder?<p className={styles.info}>Pedido anticipado #{active.preorder.orderNumber} · {active.preorder.currency} {active.preorder.total.toFixed(2)}</p>:onStartPreorder&&["PENDING","CONFIRMED"].includes(active.status)&&<div className={styles.preorder}><h3>¿Quieres pedir por adelantado?</h3><p>Es opcional. Tu pedido quedará vinculado a esta reserva.</p><button className={styles.secondary} onClick={()=>{onStartPreorder(active);setOpen(false);}}>Agregar pedido ahora</button></div>}<p className={styles.muted}>Conserva tu código. El estado se actualiza automáticamente.</p></>}
     {error&&<p className={styles.error} role="alert">{error}</p>}
    </fieldset>
    <footer className={styles.footer}>{step==="result"?<><button className={styles.primary} onClick={close}>Volver al menú</button>{active&&terminal(active.status)&&<button className={styles.secondary} onClick={()=>{setStep("welcome");reset();setUncertain(false);}}>Crear otra reserva</button>}</>:<button className={styles.primary} disabled={busy||contactBusy||uncertain||((step==="contact"||step==="review")&&!contactSaved)||(step==="table"&&!selected)||(step==="schedule"&&(!date||!time))} onClick={next}>{contactBusy?"Guardando tus datos…":busy?(step==="review"?"Confirmando…":"Consultando mesas…"):step==="welcome"?"Reservar ahora →":step==="review"?"Confirmar reserva":"Continuar →"}</button>}</footer>
   </div>
  </dialog>
 </>;
}
