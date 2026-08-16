select
    column_name,
    data_type,
    is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'orders'
  and column_name in (
      'order_type',
      'scheduled_for',
      'customer_notes',
      'customer_name',
      'customer_phone',
      'table_code',
      'delivery_address'
  )
order by
    case column_name
        when 'order_type' then 1
        when 'scheduled_for' then 2
        when 'customer_notes' then 3
        when 'customer_name' then 4
        when 'customer_phone' then 5
        when 'table_code' then 6
        when 'delivery_address' then 7
        else 99
    end;