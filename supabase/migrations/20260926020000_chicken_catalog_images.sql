-- Apply once after backup and explicit catalog-image authorization.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$
declare item record; changed integer;
begin
  for item in select * from (values
    ('POL-BROASTER','/images/menu/pollo-broaster-v2.webp'),
    ('POL-ESPIEDO','/images/menu/pollo-espiedo-v2.webp'),
    ('POL-PARRILLA','/images/menu/pollo-parrilla-v2.webp')
  ) as images(sku,url)
  loop
    update public.products p set image_url=item.url
    from public.tenants t
    where p.tenant_id=t.id and t.code='POLLO001'
      and (p.sku=item.sku or p.presentation_parent_id=(select parent.id from public.products parent where parent.tenant_id=t.id and parent.sku=item.sku))
      and nullif(trim(p.image_url),'') is null;
    get diagnostics changed = row_count;
    if changed<>5 then raise exception 'IMAGE_BASELINE_CHANGED'; end if;
  end loop;
end $$;
commit;
