import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
export const SERVICE_KEYS = ['ORDERING','DELIVERY','TAKEAWAY','PICKUP','DINE_IN','RESERVATIONS'] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];
export type ServiceState = 'ENABLED' | 'DRAINING' | 'DISABLED';
export type ServiceStates = Record<ServiceKey, ServiceState>;
export const SERVICE_LABELS: Record<ServiceKey,string> = {ORDERING:'Nuevos pedidos',DELIVERY:'Delivery',TAKEAWAY:'Retiro en local',PICKUP:'Retiro programado',DINE_IN:'Consumo en local',RESERVATIONS:'Reservas de mesas'};
export const defaultStates = ():ServiceStates => Object.fromEntries(SERVICE_KEYS.map(k=>[k,'ENABLED'])) as ServiceStates;
export function parseStates(value:unknown):ServiceStates {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BadRequestException('Configuración de servicios inválida.');
  const record=value as Record<string,unknown>;
  if(Object.keys(record).length!==SERVICE_KEYS.length||SERVICE_KEYS.some(k=>typeof record[k]!=='string'||!['ENABLED','DRAINING','DISABLED'].includes(record[k] as string)))throw new BadRequestException('Indica el estado de cada servicio.');
  return {...record} as ServiceStates;
}
export function validateTransition(before:ServiceStates,after:ServiceStates,active:Record<ServiceKey,number>) {
  if(after.RESERVATIONS==='ENABLED'&&after.DINE_IN!=='ENABLED')throw new ConflictException('Pausa las nuevas reservas antes de cerrar el consumo en local.');
  for(const key of SERVICE_KEYS){
    if(after[key]==='DISABLED'&&before[key]==='ENABLED')throw new ConflictException('Primero pausa las nuevas solicitudes y termina las operaciones pendientes.');
    if(after[key]==='DISABLED'&&active[key]>0)throw new ConflictException(`${SERVICE_LABELS[key]} tiene operaciones pendientes.`);
  }
}
// Shared branch lock serializes new admissions with configuration/price edits
// until the caller commits. Missing settings preserve existing behavior;
// database errors must never silently enable services.
export async function lockBranchAdmission(client:PoolClient,tenantId:string,branchId:string,required:ServiceKey[]) {
  const branch=await client.query<{delivery_enabled:boolean}>(`select b.delivery_enabled from public.branches b join public.tenants t on t.id=b.tenant_id
    where b.tenant_id=$1::uuid and b.id=$2::uuid and b.status='ACTIVE' and t.status='ACTIVE' for share of b,t`,[tenantId,branchId]);
  if(!branch.rows[0])throw new ConflictException('La sucursal no está disponible.');
  const r=await client.query<{states:ServiceStates}>('select states from public.branch_service_settings where tenant_id=$1::uuid and branch_id=$2::uuid',[tenantId,branchId]);
  const states=r.rows[0]?parseStates(r.rows[0].states):defaultStates();
  for(const key of required)if(states[key]!=='ENABLED'||(key==='DELIVERY'&&!branch.rows[0].delivery_enabled))throw new ConflictException(`${SERVICE_LABELS[key]} no acepta nuevas solicitudes. Tus pedidos existentes se conservan.`);
}
