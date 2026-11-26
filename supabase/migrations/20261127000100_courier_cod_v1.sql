-- D1 COD: cash on delivery for courier requests.
-- The driver collects the amount from the recipient (existing DRIVER_COD payment + delivery_cash_collections),
-- hands the cash to the fleet (existing delivery_cash_settlements, now opened from Ops with a staff session),
-- and the client statement nets what was collected for the client against the delivery fees:
--   net_amount = collected_total - total_fee   (> 0: the fleet pays the client; < 0: the client pays the fleet)

alter table public.courier_client_statements
  add column collected_total numeric(12, 2) not null default 0,
  add column net_amount numeric(12, 2) not null default 0;
-- Statements issued before COD collected nothing: the client owes the fees.
update public.courier_client_statements set net_amount = collected_total - total_fee;
alter table public.courier_client_statements
  add constraint courier_statements_collected_check check (collected_total >= 0),
  add constraint courier_statements_net_check check (net_amount = collected_total - total_fee);

alter table public.courier_client_statement_items
  add column collected_amount numeric(12, 2) not null default 0,
  add constraint courier_statement_items_collected_check check (collected_amount >= 0);

-- Who opened/settled a remittance from Ops (the legacy cashier-key flow leaves it null).
alter table public.delivery_cash_settlements
  add column settled_by_staff_user_id uuid;
