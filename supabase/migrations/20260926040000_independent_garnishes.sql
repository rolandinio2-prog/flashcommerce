-- Apply once with catalog backup and explicit migration authorization.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$
declare target record; side record; new_id uuid; affected integer;
begin
 select p.tenant_id,p.category_id,bp.branch_id,bp.currency,bp.preparation_minutes
 into strict target
 from public.products p
 join public.tenants t on t.id=p.tenant_id
 join public.branch_products bp on bp.tenant_id=p.tenant_id and bp.product_id=p.id
 join public.branches b on b.id=bp.branch_id and b.tenant_id=bp.tenant_id
 where t.code='POLLO001' and b.code='SUC001' and p.sku='GUAR-ARROZ'
 and p.active and bp.is_available and bp.price=10 and bp.currency='BOB'
 for update of p,bp;

 if not exists(select 1 from public.products p join public.branch_products bp on bp.product_id=p.id and bp.tenant_id=p.tenant_id
 where p.tenant_id=target.tenant_id and bp.branch_id=target.branch_id and p.sku='GUAR-PAPAS' and bp.price=15 and bp.currency='BOB' and p.active and bp.is_available)
 then raise exception 'SIDE_PRICE_BASELINE_MISMATCH'; end if;
 if exists(select 1 from public.products where tenant_id=target.tenant_id and sku in ('GUAR-CHAUFA','GUAR-PLATANO'))
 then raise exception 'NEW_SIDE_SKU_ALREADY_EXISTS'; end if;

 update public.products set name='Arroz blanco',image_url='/images/menu/arroz-blanco-v2.webp'
 where tenant_id=target.tenant_id and sku='GUAR-ARROZ';
 update public.products set name='Papas fritas',image_url='/images/menu/papas-fritas-v2.webp'
 where tenant_id=target.tenant_id and sku='GUAR-PAPAS';

 for side in select * from (values
 ('GUAR-CHAUFA','Arroz chaufa','arroz-chaufa-v2.webp',10),
 ('GUAR-PLATANO','Plátano frito','platano-frito-v2.webp',5)
 ) as sides(sku,label,image,price)
 loop
  insert into public.products(tenant_id,category_id,sku,name,description,image_url,active)
  values(target.tenant_id,target.category_id,side.sku,side.label,null,'/images/menu/'||side.image,true)
  returning id into new_id;
  insert into public.branch_products(tenant_id,branch_id,product_id,price,currency,is_available,available_quantity,preparation_minutes)
  values(target.tenant_id,target.branch_id,new_id,side.price,'BOB',true,null,target.preparation_minutes);
 end loop;

 -- Rename live catalog names, including legacy combinations. Order snapshots are untouched.
 update public.products set name=regexp_replace(name,'^Pollo Broaster','Pollo a la Broaster')
 where tenant_id=target.tenant_id and (sku='POL-BROASTER' or sku like 'POL-BROASTER-%') and name like 'Pollo Broaster%';
 get diagnostics affected=row_count;
 if affected<>21 then raise exception 'BROASTER_NAME_BASELINE_MISMATCH'; end if;
 -- Keep the 48 historical combinations and their prices for existing carts/orders.
 -- The API blocks new adds of these combinations; menu exposes only independent products.
end $$;
commit;
