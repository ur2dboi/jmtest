-- Experimental zero-site-shutdown pairing fence. Install only after bridge
-- promotion/drain, backup, validation and explicit approval of request retries.
-- A failed old request MUST roll back completely; old non-atomic admin routes
-- must not still run. Trigger function is not a privilege boundary.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.mjp_pairing_version_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('mjp.pairing_version', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Pairing system is updating. Please retry this operation shortly.' USING ERRCODE='40001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mjp_pairing_version_fence() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER mjp_fence_account_insert BEFORE INSERT OR DELETE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_account_update BEFORE UPDATE OF upline_id,position,rank_snapshot,left_points,center_points,right_points,pairing_count ON public.accounts
  FOR EACH ROW WHEN (OLD.upline_id IS DISTINCT FROM NEW.upline_id OR OLD.position IS DISTINCT FROM NEW.position OR OLD.rank_snapshot IS DISTINCT FROM NEW.rank_snapshot OR OLD.left_points IS DISTINCT FROM NEW.left_points OR OLD.center_points IS DISTINCT FROM NEW.center_points OR OLD.right_points IS DISTINCT FROM NEW.right_points OR OLD.pairing_count IS DISTINCT FROM NEW.pairing_count)
  EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_user_rank BEFORE UPDATE OF rank,account_held ON public.users
  FOR EACH ROW WHEN (OLD.rank IS DISTINCT FROM NEW.rank OR OLD.account_held IS DISTINCT FROM NEW.account_held) EXECUTE FUNCTION public.mjp_pairing_version_fence();
-- Old deletion handler is non-atomic. Block before its first affected row,
-- including records belonging to members who have no account row.
CREATE TRIGGER mjp_fence_user_delete BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_ledger_delete BEFORE DELETE ON public.ledger FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_encash_update BEFORE UPDATE OF note,status ON public.ledger FOR EACH ROW WHEN (OLD.note ILIKE '%Encashment%') EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_order_delete BEFORE DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_pin_delete BEFORE DELETE ON public.pins FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_contributions BEFORE INSERT OR UPDATE OR DELETE ON public.pairing_contributions
  FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
CREATE TRIGGER mjp_fence_allocations BEFORE INSERT OR UPDATE OR DELETE ON public.pairing_allocations
  FOR EACH ROW EXECUTE FUNCTION public.mjp_pairing_version_fence();
COMMIT;
