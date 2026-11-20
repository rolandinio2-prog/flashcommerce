-- Applied once by the approved gate in one transaction. Historical orders remain unchanged.
ALTER TABLE public.cart_items ADD COLUMN rice_choice text NOT NULL DEFAULT '' CONSTRAINT chk_cart_rice_choice CHECK (rice_choice IN ('','WHITE','CHAUFA'));
ALTER TABLE public.cart_items DROP CONSTRAINT uq_cart_product;
ALTER TABLE public.cart_items ADD CONSTRAINT uq_cart_product_rice UNIQUE (cart_id,product_id,rice_choice);
ALTER TABLE public.order_items ADD COLUMN rice_choice text NOT NULL DEFAULT '' CONSTRAINT chk_order_rice_choice CHECK (rice_choice IN ('','WHITE','CHAUFA'));
