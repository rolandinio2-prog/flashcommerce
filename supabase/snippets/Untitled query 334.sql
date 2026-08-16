select
    dt.code,
    dt.name,

    ts.id as table_session_id,
    ts.status,

    o.order_number,
    o.order_type,
    o.table_code,
    o.table_session_id as order_table_session_id

from public.table_sessions ts

inner join public.dining_tables dt
    on dt.tenant_id = ts.tenant_id
   and dt.branch_id = ts.branch_id
   and dt.id = ts.table_id

left join public.orders o
    on o.tenant_id = ts.tenant_id
   and o.branch_id = ts.branch_id
   and o.table_session_id = ts.id

where ts.status = 'OPEN'

order by
    ts.opened_at;