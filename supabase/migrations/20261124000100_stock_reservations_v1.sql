-- =========================================================
-- STOCK RESERVATIONS V1
--
-- branch_products.available_quantity pasa a significar
-- "unidades libres" (no reservadas ni vendidas). NULL sigue
-- significando que el producto no controla inventario.
--
-- Ciclo de una reserva (una fila por pedido y producto):
--   HELD       checkout descontó unidades; pedido PENDING sin pagar
--   COMMITTED  pedido pagado o aceptado por el local (sale de PENDING)
--   RELEASED   unidades devueltas (cancelación o reserva vencida)
--   SHORTAGE   el pedido se pagó/aceptó después de vencer la reserva
--              y ya no había unidades: requiere atención del local
--
-- El descuento es un UPDATE condicionado sobre la fila de
-- branch_products: el bloqueo de fila serializa a compradores
-- simultáneos, por lo que dos pedidos no pueden tomar la
-- misma última unidad.
-- =========================================================

create table public.stock_reservations (
  tenant_id uuid not null,
  branch_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  quantity integer not null,
  status text not null default 'HELD',
  expires_at timestamptz not null,
  released_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (tenant_id, order_id, product_id),

  constraint fk_stock_reservation_order
    foreign key (tenant_id, order_id)
    references public.orders(tenant_id, id)
    on delete cascade,

  constraint fk_stock_reservation_branch_product
    foreign key (tenant_id, branch_id, product_id)
    references public.branch_products(tenant_id, branch_id, product_id),

  constraint chk_stock_reservation_quantity check (quantity > 0),
  constraint chk_stock_reservation_status
    check (status in ('HELD', 'COMMITTED', 'RELEASED', 'SHORTAGE')),
  constraint chk_stock_reservation_released_reason
    check (
      released_reason is null
      or released_reason in ('ORDER_CANCELLED', 'HOLD_EXPIRED')
    )
);

create index idx_stock_reservations_held_expiry
  on public.stock_reservations(expires_at)
  where status = 'HELD';

create index idx_stock_reservations_shortage
  on public.stock_reservations(tenant_id, branch_id)
  where status = 'SHORTAGE';

create trigger trg_stock_reservations_updated_at
  before update on public.stock_reservations
  for each row execute function public.set_updated_at();

alter table public.stock_reservations enable row level security;
revoke all on public.stock_reservations from public, anon, authenticated;

-- ---------------------------------------------------------
-- Reservar unidades durante el checkout (misma transacción
-- que crea el pedido). Devuelve:
--   UNTRACKED     el producto no controla cantidad
--   RESERVED      unidades descontadas y reserva HELD creada
--   INSUFFICIENT  no hay unidades libres suficientes
-- ---------------------------------------------------------
create or replace function public.stock_reserve_v1(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_order_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_hold interval
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_tracked boolean;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'stock_reserve_v1: invalid quantity %', p_quantity;
  end if;

  update public.branch_products
     set available_quantity = available_quantity - p_quantity
   where tenant_id = p_tenant_id
     and branch_id = p_branch_id
     and product_id = p_product_id
     and available_quantity is not null
     and available_quantity >= p_quantity;

  if not found then
    select available_quantity is not null
      into v_tracked
      from public.branch_products
     where tenant_id = p_tenant_id
       and branch_id = p_branch_id
       and product_id = p_product_id;
    return case when coalesce(v_tracked, false) then 'INSUFFICIENT' else 'UNTRACKED' end;
  end if;

  insert into public.stock_reservations (
    tenant_id, branch_id, order_id, product_id, quantity, status, expires_at
  ) values (
    p_tenant_id, p_branch_id, p_order_id, p_product_id, p_quantity, 'HELD', now() + p_hold
  );
  return 'RESERVED';
end;
$$;

-- ---------------------------------------------------------
-- Devolver las unidades de un pedido (HELD o COMMITTED).
-- ---------------------------------------------------------
create or replace function public.stock_release_order_v1(
  p_tenant_id uuid,
  p_order_id uuid,
  p_reason text
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select branch_id, product_id, quantity
      from public.stock_reservations
     where tenant_id = p_tenant_id
       and order_id = p_order_id
       and status in ('HELD', 'COMMITTED')
     order by product_id
     for update
  loop
    update public.branch_products
       set available_quantity = available_quantity + r.quantity
     where tenant_id = p_tenant_id
       and branch_id = r.branch_id
       and product_id = r.product_id
       and available_quantity is not null;
    v_count := v_count + 1;
  end loop;

  update public.stock_reservations
     set status = 'RELEASED', released_reason = p_reason
   where tenant_id = p_tenant_id
     and order_id = p_order_id
     and status in ('HELD', 'COMMITTED');
  return v_count;
end;
$$;

-- ---------------------------------------------------------
-- Confirmar las unidades de un pedido (pagado o aceptado).
-- Una reserva vencida se vuelve a tomar si hay unidades;
-- si no, queda en SHORTAGE para que el local la resuelva.
-- ---------------------------------------------------------
create or replace function public.stock_commit_order_v1(
  p_tenant_id uuid,
  p_order_id uuid
) returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  update public.stock_reservations
     set status = 'COMMITTED'
   where tenant_id = p_tenant_id
     and order_id = p_order_id
     and status = 'HELD';

  for r in
    select branch_id, product_id, quantity
      from public.stock_reservations
     where tenant_id = p_tenant_id
       and order_id = p_order_id
       and status = 'RELEASED'
       and released_reason = 'HOLD_EXPIRED'
     order by product_id
     for update
  loop
    update public.branch_products
       set available_quantity = available_quantity - r.quantity
     where tenant_id = p_tenant_id
       and branch_id = r.branch_id
       and product_id = r.product_id
       and available_quantity is not null
       and available_quantity >= r.quantity;

    update public.stock_reservations
       set status = case when found then 'COMMITTED' else 'SHORTAGE' end,
           released_reason = null
     where tenant_id = p_tenant_id
       and order_id = p_order_id
       and product_id = r.product_id;
  end loop;
end;
$$;

-- ---------------------------------------------------------
-- Liberar reservas vencidas de pedidos que siguen PENDING
-- y sin pagar. Lo ejecuta periódicamente la API.
-- ---------------------------------------------------------
create or replace function public.stock_release_expired_v1(p_limit integer default 100)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_orders integer := 0;
begin
  for r in
    select distinct s.tenant_id, s.order_id
      from public.stock_reservations s
      join public.orders o
        on o.tenant_id = s.tenant_id and o.id = s.order_id
     where s.status = 'HELD'
       and s.expires_at <= now()
       and o.status = 'PENDING'
       and o.payment_status is distinct from 'PAID'
     limit p_limit
  loop
    -- Bloquear el pedido para no competir con su pago o aceptación.
    perform 1 from public.orders
      where tenant_id = r.tenant_id and id = r.order_id
        and status = 'PENDING' and payment_status is distinct from 'PAID'
      for update skip locked;
    if found then
      perform public.stock_release_order_v1(r.tenant_id, r.order_id, 'HOLD_EXPIRED');
      v_orders := v_orders + 1;
    end if;
  end loop;
  return v_orders;
end;
$$;

-- ---------------------------------------------------------
-- Trigger: cualquier camino que cancele, pague o acepte un
-- pedido mueve sus reservas (no depende de cada servicio).
-- ---------------------------------------------------------
create or replace function public.stock_reservations_on_order_change_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'CANCELLED' and old.status is distinct from 'CANCELLED' then
    perform public.stock_release_order_v1(new.tenant_id, new.id, 'ORDER_CANCELLED');
  elsif new.status <> 'CANCELLED'
    and (
      (new.payment_status = 'PAID' and old.payment_status is distinct from 'PAID')
      or (old.status = 'PENDING' and new.status <> 'PENDING')
    ) then
    perform public.stock_commit_order_v1(new.tenant_id, new.id);
  end if;
  return new;
end;
$$;

create trigger trg_stock_reservations_on_order_change_v1
  after update of status, payment_status on public.orders
  for each row
  when (old.status is distinct from new.status
        or old.payment_status is distinct from new.payment_status)
  execute function public.stock_reservations_on_order_change_v1();

revoke all on function public.stock_reserve_v1(uuid, uuid, uuid, uuid, integer, interval) from public, anon, authenticated;
revoke all on function public.stock_release_order_v1(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.stock_commit_order_v1(uuid, uuid) from public, anon, authenticated;
revoke all on function public.stock_release_expired_v1(integer) from public, anon, authenticated;
