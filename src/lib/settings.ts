import { exec, q, tx, inTransaction } from './db';

/**
 * Port of MLM_Settings_Cache (plugin v9.6.109).
 *
 * All mlm_sys_* options are loaded in ONE batch per request and cached in
 * memory instead of issuing dozens of get_option() calls. Call
 * `await ensureSettings()` at the top of a request handler, then use the
 * synchronous `setting()` accessors exactly like `mlm_setting()` in PHP.
 */
export const SETTING_DEFAULTS = {
  mlm_sys_dr_starter: 50,
  mlm_sys_product_comm_starter: 20,
  mlm_sys_dr_premium: 300,
  mlm_sys_dr_starpremium: 1000,
  mlm_sys_bp_amount: 200,
  mlm_sys_tri_premium: 300,
  mlm_sys_tri_starpremium: 600,
  mlm_sys_limit_premium: 15,
  mlm_sys_limit_starpremium: 30,
  mlm_sys_limit_ca_premium: 10,
  mlm_sys_limit_ca_starpremium: 20,
  mlm_sys_gc_every: 5,
  mlm_sys_max_depth: 8,
  mlm_sys_rpts_premium: 1,
  mlm_sys_rpts_starpremium: 2,
  mlm_sys_tax: 10,
  mlm_sys_fee: 20,
  mlm_sys_fund_transfer_fee: 25,
  mlm_sys_min_encash: 1000,
  mlm_sys_unilevel_monthly_reset: 1,
  mlm_sys_unilevel_cutoff_hold: 1,
  mlm_sys_unilevel_level_mode: 'compressed',
  mlm_sys_auto_approve_products: 0,
  mlm_maintenance_mode: 0,
  mlm_sys_uni_l1: 5,
  mlm_sys_uni_l2: 4,
  mlm_sys_uni_l3: 3,
  mlm_sys_uni_l4: 2,
  mlm_sys_uni_l5: 1,
  mlm_sys_uni_l6: 1,
  mlm_sys_uni_l7: 1,
  mlm_sys_uni_l8: 1,
  mlm_sys_uni_l9: 1,
  mlm_sys_uni_l10: 1,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS | string;

let cache: Record<string, string> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5_000;

async function loadAll(): Promise<Record<string, string>> {
  const keys = Object.keys(SETTING_DEFAULTS);
  const rows = await q<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  // Persist any brand-new keys so the admin panel always shows current values.
  const missing = keys.filter((k) => !(k in out));
  if (missing.length) {
    const values = missing.map((k) => [k, String((SETTING_DEFAULTS as Record<string, unknown>)[k])]);
    const placeholders = values.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
    await q(
      `INSERT INTO settings (key, value) VALUES ${placeholders} ON CONFLICT (key) DO NOTHING`,
      values.flat(),
    );
    for (const [k, v] of values) out[k] = v;
  }
  return out;
}

/** Batch-load settings once per request (cached, 5s TTL). */
let schemaUpgraded = false;

/**
 * Idempotent runtime schema upgrades for databases created before a change
 * shipped (deploys do not re-run sql/schema.sql). Memoized per process;
 * retried on the next call if the ALTER fails.
 */
export async function ensureSchemaUpgrades(): Promise<void> {
  if (schemaUpgraded) return;
  const alreadyInTransaction = inTransaction();
  await tx(async () => {
    // FLOATING Commission (LP) monthly reset stores 'forfeited' ledger rows.
    await exec(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_status_check') THEN
          ALTER TABLE ledger DROP CONSTRAINT ledger_status_check;
        END IF;
        ALTER TABLE ledger ADD CONSTRAINT ledger_status_check
          CHECK (status IN ('active','hang','released','forfeited'));
      END $$;
    `);
    await exec(`ALTER TABLE pins ADD COLUMN IF NOT EXISTS commission_tracked BOOLEAN NOT NULL DEFAULT FALSE`);
    await exec(`ALTER TABLE pins ADD COLUMN IF NOT EXISTS commission_snapshot JSONB`);
    await exec(`ALTER TABLE ledger ADD COLUMN IF NOT EXISTS source_product_pin_id BIGINT`);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_product_source_user ON ledger(source_product_pin_id,user_id) WHERE source_product_pin_id IS NOT NULL`);
    await exec(`CREATE TABLE IF NOT EXISTS commission_review (
      id BIGSERIAL PRIMARY KEY,
      pin_id BIGINT NOT NULL,
      beneficiary_id BIGINT NOT NULL,
      noted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reason TEXT NOT NULL,
      UNIQUE(pin_id,beneficiary_id)
    )`);
    await exec(`CREATE TABLE IF NOT EXISTS commission_event_targets (
      pin_id BIGINT NOT NULL,
      recipient_id BIGINT NOT NULL,
      PRIMARY KEY(pin_id,recipient_id)
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_commission_target_recipient ON commission_event_targets(recipient_id,pin_id)`);
    await exec(`CREATE TABLE IF NOT EXISTS pairing_tracking_meta (
      id SMALLINT PRIMARY KEY CHECK(id=1), started_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await exec(`INSERT INTO pairing_tracking_meta(id) VALUES(1) ON CONFLICT(id) DO NOTHING`);
    await exec(`CREATE TABLE IF NOT EXISTS pairing_contributions (
      recipient_account_id BIGINT NOT NULL, source_account_id BIGINT NOT NULL,
      source_user_id BIGINT NOT NULL, leg VARCHAR(1) NOT NULL,
      source_rank TEXT NOT NULL, ab_points INTEGER NOT NULL, right_points INTEGER NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      ab_consumed INTEGER NOT NULL DEFAULT 0, right_consumed INTEGER NOT NULL DEFAULT 0,
      review_required BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(recipient_account_id,source_account_id)
    )`);
    await exec(`ALTER TABLE pairing_contributions ADD COLUMN IF NOT EXISTS ab_consumed INTEGER NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE pairing_contributions ADD COLUMN IF NOT EXISTS right_consumed INTEGER NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE pairing_contributions ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT FALSE`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_pair_contribution_leg ON pairing_contributions(recipient_account_id,leg,occurred_at,source_account_id)`);
    await exec(`CREATE TABLE IF NOT EXISTS pairing_allocations (
      id BIGSERIAL PRIMARY KEY, recipient_account_id BIGINT NOT NULL, kind TEXT NOT NULL,
      left_source_account_id BIGINT, center_source_account_id BIGINT, right_source_account_id BIGINT,
      ledger_ids JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_pair_alloc_recipient ON pairing_allocations(recipient_account_id,kind,id)`);
    await exec(`CREATE TABLE IF NOT EXISTS pairing_review (
      id BIGSERIAL PRIMARY KEY,
      account_id BIGINT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      noted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Surface pre-migration waiting balances immediately. Do not mislabel new
    // source-linked units: subtract each recipient's recorded remaining units.
    await exec(`INSERT INTO pairing_review(account_id,reason)
      SELECT a.id,'Legacy pairing points lack immutable source records; held for review while new verified points are processed separately.'
      FROM accounts a CROSS JOIN pairing_tracking_meta m
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(CASE WHEN c.leg='L' THEN c.ab_points-c.ab_consumed ELSE 0 END),0) l,
               COALESCE(SUM(CASE WHEN c.leg='C' THEN c.ab_points-c.ab_consumed ELSE 0 END),0) c,
               COALESCE(SUM(CASE WHEN c.leg='R' THEN c.right_points-c.right_consumed ELSE 0 END),0) r
        FROM pairing_contributions c WHERE c.recipient_account_id=a.id
      ) tracked ON TRUE
      WHERE m.id=1 AND a.account_type='MA' AND a.created_at<m.started_at
        AND (a.left_points>tracked.l OR a.center_points>tracked.c OR a.right_points>tracked.r)
      ON CONFLICT(account_id) DO NOTHING`);
    // Supabase's public-schema defaults can grant anon/authenticated full
    // access to newly created tables. Revoke before this transaction commits,
    // so financial metadata is never exposed between creation and protection.
    await exec(`DO $$
      DECLARE role_name text;
      BEGIN
        REVOKE ALL ON TABLE public.commission_review, public.commission_event_targets,
          public.pairing_tracking_meta, public.pairing_contributions,
          public.pairing_allocations, public.pairing_review FROM PUBLIC;
        REVOKE ALL ON SEQUENCE public.commission_review_id_seq,
          public.pairing_allocations_id_seq, public.pairing_review_id_seq FROM PUBLIC;
        FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
          EXECUTE format('REVOKE ALL ON TABLE public.commission_review, public.commission_event_targets, public.pairing_tracking_meta, public.pairing_contributions, public.pairing_allocations, public.pairing_review FROM %I', role_name);
          EXECUTE format('REVOKE ALL ON SEQUENCE public.commission_review_id_seq, public.pairing_allocations_id_seq, public.pairing_review_id_seq FROM %I', role_name);
        END LOOP;
      END $$`);
  });
  // A nested migration can still be rolled back by its caller; never memoize it
  // as committed until a standalone transaction has completed successfully.
  if (!alreadyInTransaction) schemaUpgraded = true;
}

export async function ensureSettings(force = false): Promise<Record<string, string>> {
  const fresh = cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache as Record<string, string>;
  await ensureSchemaUpgrades();
  cache = await loadAll();
  cacheLoadedAt = Date.now();
  return cache;
}

export function invalidateSettings(): void {
  cache = null;
  cacheLoadedAt = 0;
}

function raw(key: SettingKey, fallback?: string | number | boolean): string {
  const stored = cache?.[key];
  if (stored !== undefined && stored !== '') return stored;
  const def = (SETTING_DEFAULTS as Record<string, unknown>)[key as string];
  if (def !== undefined) return String(def);
  return fallback === undefined ? '' : String(fallback);
}

export function setting(key: SettingKey, fallback?: string): string {
  return raw(key, fallback ?? '');
}

export function settingNum(key: SettingKey, fallback?: number): number {
  const n = Number(raw(key, fallback ?? 0));
  return Number.isFinite(n) ? n : Number(fallback ?? 0);
}

export function settingInt(key: SettingKey, fallback?: number): number {
  return Math.trunc(settingNum(key, fallback));
}

export function settingBool(key: SettingKey, fallback?: boolean): boolean {
  const v = raw(key, fallback ? '1' : '0');
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'on';
}

export async function saveSettings(values: Record<string, string | number | boolean>): Promise<void> {
  const entries = Object.entries(values);
  if (!entries.length) return;
  const placeholders = entries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, now())`).join(',');
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ${placeholders}
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    entries.flatMap(([k, v]) => [k, String(v)]),
  );
  invalidateSettings();
}

/** Unilevel matrix L1..L10 (₱ per bottle). */
export function unilevelMatrix(): number[] {
  const out: number[] = [];
  for (let i = 1; i <= 10; i++) out.push(settingNum(`mlm_sys_uni_l${i}` as SettingKey, 1));
  return out;
}
