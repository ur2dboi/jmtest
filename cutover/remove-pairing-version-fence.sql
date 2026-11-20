-- DANGER: after removal old deployments may resume incorrect/duplicate payouts.
BEGIN;
DROP TRIGGER IF EXISTS mjp_fence_account_insert ON public.accounts;
DROP TRIGGER IF EXISTS mjp_fence_account_update ON public.accounts;
DROP TRIGGER IF EXISTS mjp_fence_user_rank ON public.users;
DROP TRIGGER IF EXISTS mjp_fence_user_delete ON public.users;
DROP TRIGGER IF EXISTS mjp_fence_ledger_delete ON public.ledger;
DROP TRIGGER IF EXISTS mjp_fence_encash_update ON public.ledger;
DROP TRIGGER IF EXISTS mjp_fence_order_delete ON public.orders;
DROP TRIGGER IF EXISTS mjp_fence_pin_delete ON public.pins;
DROP TRIGGER IF EXISTS mjp_fence_contributions ON public.pairing_contributions;
DROP TRIGGER IF EXISTS mjp_fence_allocations ON public.pairing_allocations;
DROP FUNCTION IF EXISTS public.mjp_pairing_version_fence();
COMMIT;
