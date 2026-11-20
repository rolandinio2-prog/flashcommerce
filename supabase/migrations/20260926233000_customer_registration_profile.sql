BEGIN;
ALTER TABLE public.customer_accounts ADD COLUMN full_name varchar(120);
COMMIT;
