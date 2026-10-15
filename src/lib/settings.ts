import { q } from './db';

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
  mlm_sys_rpts_starpremium: 1,
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
export async function ensureSettings(force = false): Promise<Record<string, string>> {
  const fresh = cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache as Record<string, string>;
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
