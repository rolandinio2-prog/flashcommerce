BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.branch_operations_audit DROP CONSTRAINT branch_operations_audit_action_check;
ALTER TABLE public.branch_operations_audit ADD CONSTRAINT branch_operations_audit_action_check
 CHECK(action IN ('SERVICES_UPDATED','PRODUCT_UPDATED','PRODUCT_CREATED','PRODUCT_DELETED'));
CREATE TABLE public.branch_product_commands (
 tenant_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL,
 payload_hash char(64) NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES public.branches(tenant_id,id)
);
ALTER TABLE public.branch_product_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.branch_product_commands FROM PUBLIC,anon,authenticated;
COMMIT;
