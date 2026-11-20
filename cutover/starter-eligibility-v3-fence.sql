-- Replace the existing v2 fence with the v3 fence in a single transaction.
-- Before this: deploy the additive recipient_eligible columns, verify backups,
-- and ensure all reachable old deployments use transactional guard-safe code.
-- Do not roll the site back to a v2 deployment after this transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.accounts, public.users, public.ledger, public.orders, public.pins,
  public.pairing_contributions, public.pairing_allocations IN SHARE ROW EXCLUSIVE MODE;
CREATE OR REPLACE FUNCTION public.mjp_pairing_version_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('mjp.pairing_version', true) IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'Pairing system is updating. Please retry this operation shortly.' USING ERRCODE='40001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mjp_pairing_version_fence() FROM PUBLIC, anon, authenticated;
COMMIT;
