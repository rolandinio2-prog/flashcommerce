-- Single execution, after approved backup. Existing orders and cart lines are preserved.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter table public.products
  add column garnish_parent_id uuid,
  add column garnish_label varchar(60),
  add column garnish_image_url text,
  add column garnish_sort_order integer not null default 0,
  add constraint fk_garnish_parent foreign key(tenant_id,garnish_parent_id) references public.products(tenant_id,id),
  add constraint ck_garnish_shape check((garnish_parent_id is null and garnish_label is null and garnish_image_url is null) or (garnish_parent_id is not null and garnish_label is not null and length(trim(garnish_label))>0 and garnish_image_url is not null and garnish_parent_id<>id and presentation_parent_id is null)),
  add constraint uq_garnish_label unique(tenant_id,garnish_parent_id,garnish_label);
create index idx_products_garnish_parent on public.products(tenant_id,garnish_parent_id);
do $$
declare target record; side record; child_id uuid; found_count integer:=0;
begin
  for target in
    select p.*,bp.branch_id,bp.currency,bp.price,bp.preparation_minutes
    from public.products p
    join public.products parent on parent.id=p.presentation_parent_id and parent.tenant_id=p.tenant_id
    join public.tenants t on t.id=p.tenant_id
    join public.branch_products bp on bp.tenant_id=p.tenant_id and bp.product_id=p.id
    join public.branches b on b.id=bp.branch_id and b.tenant_id=bp.tenant_id
    where t.code='POLLO001' and b.code='SUC001'
      and parent.sku in ('POL-PARRILLA','POL-ESPIEDO','POL-BROASTER')
      and p.active and parent.active and bp.is_available and bp.currency='BOB' and bp.available_quantity is null
      and ((p.presentation_label='Económico' and bp.price=21) or (p.presentation_label='Cuarto' and bp.price=30) or (p.presentation_label='Medio' and bp.price=55) or (p.presentation_label='Entero' and bp.price=110))
    for update of p,bp
  loop
    found_count:=found_count+1;
    for side in select * from (values
      ('ARROZ-BLANCO','Arroz blanco','arroz-blanco-v2.webp',1),
      ('PAPAS-FRITAS','Papas fritas','papas-fritas-v2.webp',2),
      ('ARROZ-CHAUFA','Arroz chaufa','arroz-chaufa-v2.webp',3),
      ('PLATANO-FRITO','Plátano frito','platano-frito-v2.webp',4)
    ) as sides(code,label,image,ordinal)
    loop
      insert into public.products(tenant_id,category_id,sku,name,description,image_url,active,garnish_parent_id,garnish_label,garnish_image_url,garnish_sort_order)
      values(target.tenant_id,target.category_id,target.sku||'-G-'||side.code,target.name||' · '||side.label||' (incluido)',target.description,target.image_url,true,target.id,side.label,'/images/menu/'||side.image,side.ordinal)
      returning id into child_id;
      insert into public.branch_products(tenant_id,branch_id,product_id,price,currency,is_available,available_quantity,preparation_minutes)
      values(target.tenant_id,target.branch_id,child_id,target.price,target.currency,true,null,target.preparation_minutes);
    end loop;
  end loop;
  if found_count<>12 then raise exception 'GARNISH_PARENT_BASELINE_MISMATCH'; end if;
end $$;
commit;
