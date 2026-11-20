-- Prepared only. Apply once with explicit schema/catalog-write authorization.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table public.products
  add column presentation_parent_id uuid,
  add column presentation_label varchar(60),
  add column presentation_sort_order integer not null default 0,
  add constraint fk_presentation_parent foreign key (tenant_id,presentation_parent_id) references public.products(tenant_id,id),
  add constraint ck_presentation_shape check ((presentation_parent_id is null and presentation_label is null) or (presentation_parent_id is not null and presentation_label is not null and length(trim(presentation_label))>0 and presentation_parent_id<>id)),
  add constraint uq_presentation_label unique(tenant_id,presentation_parent_id,presentation_label);
create index idx_products_presentation_parent on public.products(tenant_id,presentation_parent_id);
do $$
declare target record; option record; child_id uuid; found_count integer:=0;
begin
  for target in
    select p.*,bp.branch_id,bp.currency,bp.available_quantity,bp.is_available,bp.preparation_minutes
    from public.products p
    join public.tenants t on t.id=p.tenant_id
    join public.branch_products bp on bp.tenant_id=p.tenant_id and bp.product_id=p.id
    join public.branches b on b.tenant_id=bp.tenant_id and b.id=bp.branch_id
    where t.code='POLLO001' and b.code='SUC001'
      and p.sku in ('POL-PARRILLA','POL-ESPIEDO','POL-BROASTER')
      and p.active and bp.is_available and bp.currency='BOB' and bp.available_quantity is null
    for update of p,bp
  loop
    found_count:=found_count+1;
    for option in select * from (values ('ECO','Económico',21,1),('CUARTO','Cuarto',30,2),('MEDIO','Medio',55,3),('ENTERO','Entero',110,4)) as sizes(code,label,price,ordinal)
    loop
      insert into public.products(tenant_id,category_id,sku,name,description,image_url,active,presentation_parent_id,presentation_label,presentation_sort_order)
      values(target.tenant_id,target.category_id,target.sku||'-'||option.code,target.name||' · '||option.label,target.description,target.image_url,true,target.id,option.label,option.ordinal)
      returning id into child_id;
      insert into public.branch_products(tenant_id,branch_id,product_id,price,currency,is_available,available_quantity,preparation_minutes)
      values(target.tenant_id,target.branch_id,child_id,option.price,'BOB',true,null,target.preparation_minutes);
    end loop;
  end loop;
  if found_count<>3 then raise exception 'PRESENTATION_PARENT_BASELINE_MISMATCH';end if;
end $$;
commit;
