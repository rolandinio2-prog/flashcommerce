begin;

alter table public.order_payments
    add column qr_content_type varchar(20),
    add column qr_mime_type varchar(20);

comment on column public.order_payments.qr_content_type is
    'Representation of qr_payload: TEXT or IMAGE_BASE64.';

comment on column public.order_payments.qr_mime_type is
    'MIME type for IMAGE_BASE64 QR payloads; null for TEXT.';

-- Existing QR payloads were created by the MOCK provider
-- and therefore contain text to be encoded by the frontend.
update public.order_payments
set qr_content_type = 'TEXT'
where method = 'QR'
  and qr_payload is not null
  and qr_content_type is null;

alter table public.order_payments
    add constraint order_payments_qr_content_type_check
        check (
            qr_content_type is null
            or qr_content_type in (
                'TEXT',
                'IMAGE_BASE64'
            )
        ),

    add constraint order_payments_qr_mime_type_check
        check (
            qr_mime_type is null
            or qr_mime_type in (
                'image/png',
                'image/jpeg'
            )
        ),

    add constraint order_payments_qr_content_metadata_check
        check (
            (
                qr_payload is null
                and qr_content_type is null
                and qr_mime_type is null
            )
            or
            (
                method = 'QR'
                and qr_payload is not null
                and (
                    (
                        qr_content_type = 'TEXT'
                        and qr_mime_type is null
                    )
                    or
                    (
                        qr_content_type = 'IMAGE_BASE64'
                        and qr_mime_type in (
                            'image/png',
                            'image/jpeg'
                        )
                    )
                )
            )
        );

commit;
