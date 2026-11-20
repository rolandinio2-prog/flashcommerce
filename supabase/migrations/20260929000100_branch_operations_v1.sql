-- Additive S2 migration: requires a separate authorized migration gate.
BEGIN;
CREATE TABLE public.branch_service_settings (
 tenant_id uuid NOT NULL, branch_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 states jsonb NOT NULL CHECK(
   jsonb_typeof(states)='object' AND
   states ?& ARRAY['ORDERING','DELIVERY','TAKEAWAY','PICKUP','DINE_IN','RESERVATIONS'] AND
   states - ARRAY['ORDERING','DELIVERY','TAKEAWAY','PICKUP','DINE_IN','RESERVATIONS']='{}'::jsonb AND
   states->>'ORDERING' IN ('ENABLED','DRAINING','DISABLED') AND
   states->>'DELIVERY' IN ('ENABLED','DRAINING','DISABLED') AND
   states->>'TAKEAWAY' IN ('ENABLED','DRAINING','DISABLED') AND
   states->>'PICKUP' IN ('ENABLED','DRAINING','DISABLED') AND
   states->>'DINE_IN' IN ('ENABLED','DRAINING','DISABLED') AND
   states->>'RESERVATIONS' IN ('ENABLED','DRAINING','DISABLED') AND
   NOT states @> '{"ORDERING":null}'::jsonb AND NOT states @> '{"DELIVERY":null}'::jsonb AND
   NOT states @> '{"TAKEAWAY":null}'::jsonb AND NOT states @> '{"PICKUP":null}'::jsonb AND
   NOT states @> '{"DINE_IN":null}'::jsonb AND NOT states @> '{"RESERVATIONS":null}'::jsonb
 ),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,branch_id),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES public.branches(tenant_id,id)
);
CREATE TABLE public.branch_operations_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL, branch_id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('SERVICES_UPDATED','PRODUCT_UPDATED')),
 target_id uuid, reason varchar(200) NOT NULL,
 before_value jsonb NOT NULL, after_value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES public.branches(tenant_id,id)
);
CREATE INDEX branch_operations_audit_scope ON public.branch_operations_audit(tenant_id,branch_id,id DESC);
ALTER TABLE public.branch_service_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_operations_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.branch_service_settings,public.branch_operations_audit FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.branch_operations_audit_id_seq FROM PUBLIC,anon,authenticated;
-- Verify the existing API role at deployment. Never grant browser roles access.
COMMIT;
