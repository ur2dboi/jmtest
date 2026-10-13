import { exec, one, q, scalar } from '../db';
import { phMonthKey, phToday, toDate } from '../time';
import { settingBool, settingInt, settingNum } from '../settings';
import type { AccountRow, Position, UserRow } from '../types';

/* =====================================================================
 * Account / member helpers (port of the plugin's free-account, hold,
 * rank-snapshot and depth utilities).
 *
 * HARD RULE (v9.6.119 structural parity): free vs paid and shallow vs
 * deep NEVER change genealogy. Structure is driven only by
 * accounts.account_type (MA/CA) + position (L/C/R). Free flags affect
 * EARNINGS only.
 * ===================================================================== */

const userCache = new Map<number, UserRow>();

export function invalidateUser(id: number): void {
  userCache.delete(Number(id));
}
export function invalidateAllUsers(): void {
  userCache.clear();
}

export async function userById(id: number): Promise<UserRow | null> {
  const key = Number(id);
  if (!key) return null;
  const cached = userCache.get(key);
  if (cached) return cached;
  const row = await one<UserRow>('SELECT * FROM users WHERE id = $1', [key]);
  if (row) userCache.set(key, row);
  return row;
}

export async function accountById(id: number): Promise<AccountRow | null> {
  return one<AccountRow>('SELECT * FROM accounts WHERE id = $1', [Number(id)]);
}

/** Prefer the MA row; fall back to any row (CA-only users). */
export async function primaryAccountForUser(userId: number): Promise<AccountRow | null> {
  return one<AccountRow>(
    `SELECT * FROM accounts WHERE user_id = $1
     ORDER BY CASE WHEN account_type = 'MA' THEN 0 ELSE 1 END, id ASC LIMIT 1`,
    [Number(userId)],
  );
}

export async function maAccountForUser(userId: number): Promise<AccountRow | null> {
  return one<AccountRow>(
    `SELECT * FROM accounts WHERE user_id = $1 AND account_type = 'MA' ORDER BY id ASC LIMIT 1`,
    [Number(userId)],
  );
}

/* ---------- rank helpers ---------- */

export function normRank(rank?: string | null): string {
  return String(rank ?? '').replace(/\s+/g, '').toLowerCase();
}

export function isCA(accountType?: string | null): boolean {
  return String(accountType ?? '').trim().toUpperCase() === 'CA';
}
export function isMA(accountType?: string | null): boolean {
  return !isCA(accountType);
}

export function isFreeAccountUser(user: UserRow | null): boolean {
  if (!user) return false;
  if (user.is_free_account) return true;
  return normRank(user.rank).includes('free');
}

export function freeCanReceivePairing(user: UserRow | null): boolean {
  if (!user || !isFreeAccountUser(user)) return true;
  return !!user.free_receive_pairing;
}
export function freeCanCountForUplinePairing(user: UserRow | null): boolean {
  if (!user || !isFreeAccountUser(user)) return true;
  return !!user.free_count_for_upline_pairing;
}
export function freeCanPayDirectReferral(user: UserRow | null): boolean {
  if (!user || !isFreeAccountUser(user)) return true;
  return !!user.free_pay_direct_referral;
}

/** Member-facing rank label: never leaks a "Free Account" tag. */
export function memberDisplayRank(user: UserRow | null, rank?: string | null): string {
  const raw = String(rank ?? user?.rank ?? '');
  if (user && isFreeAccountUser(user) && normRank(raw).includes('free')) {
    const display = String(user.free_display_rank || '').trim();
    if (!display || normRank(display).includes('free')) return 'Premium';
    return display;
  }
  if (!raw || normRank(raw).includes('free')) return 'Premium';
  return raw;
}

export async function displayRankForUser(userId: number): Promise<string> {
  const u = await userById(userId);
  return u ? memberDisplayRank(u, u.rank) : 'Premium';
}

export function isStarRank(rank: string): boolean {
  return normRank(rank).includes('starpremium');
}
export function isStarterRank(rank: string): boolean {
  return normRank(rank).includes('starter');
}
export function isPremiumOnlyRank(rank: string): boolean {
  const n = normRank(rank);
  return n.includes('premium') && !n.includes('starpremium');
}

/* ---------- hold / free kind ---------- */

export function isAccountOnHold(user: UserRow | null): boolean {
  return !!user?.account_held;
}

export async function syncFreeAccountKindMeta(userId: number, accountType?: string): Promise<void> {
  const user = await userById(userId);
  if (!user || !isFreeAccountUser(user)) return;
  let kind = String(accountType ?? '').trim().toUpperCase();
  if (kind !== 'MA' && kind !== 'CA') {
    kind = ((await scalar<string>(
      `SELECT account_type FROM accounts WHERE user_id = $1
       ORDER BY CASE WHEN account_type='MA' THEN 0 ELSE 1 END, id ASC LIMIT 1`,
      [userId],
    )) || 'MA').toUpperCase();
  }
  await exec(`UPDATE users SET free_account_kind = $1, is_free_account = TRUE WHERE id = $2`, [kind, userId]);
  invalidateUser(userId);
}

/* ---------- member ID (encashment gate) ---------- */

export function generateMemberIdNumber(userId: number, when: Date = new Date()): string {
  const id = Number(userId);
  if (id <= 0) return '';
  return `MJP-${phMonthKey(when).slice(0, 4)}-${String(id).padStart(6, '0')}`;
}

export async function ensureMemberIdNumber(userId: number): Promise<string> {
  const user = await userById(userId);
  if (!user) return '';
  if (user.member_id_number) return user.member_id_number;
  const generated = generateMemberIdNumber(userId, user.created_at);
  await exec('UPDATE users SET member_id_number = $1 WHERE id = $2', [generated, userId]);
  invalidateUser(userId);
  return generated;
}

export interface MemberIdStatus {
  valid: boolean;
  reason: string;
  id_number: string;
  expires: string;
}

export async function memberIdStatus(userId: number): Promise<MemberIdStatus> {
  const user = await userById(userId);
  const idNumber = user?.member_id_number ? await ensureMemberIdNumber(userId) : await ensureMemberIdNumber(userId);
  const expiresRaw = user?.member_id_expires;
  const expires = expiresRaw ? new Date(expiresRaw).toISOString().slice(0, 10) : '';
  const today = phToday();
  if (!idNumber)
    return { valid: false, reason: 'Member ID number is required before encashment.', id_number: idNumber, expires };
  if (!expires)
    return { valid: false, reason: 'Member ID expiration date is required before encashment.', id_number: idNumber, expires };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires))
    return { valid: false, reason: 'Member ID expiration date is invalid.', id_number: idNumber, expires };
  if (expires < today)
    return { valid: false, reason: 'Member ID is expired. Please contact admin to update your ID details.', id_number: idNumber, expires };
  return { valid: true, reason: 'ID verified for encashment.', id_number: idNumber, expires };
}

export async function memberCanEncash(userId: number): Promise<boolean> {
  const status = await memberIdStatus(userId);
  return status.valid;
}

/* ---------- rank snapshots + history ---------- */

export interface RankSnapshot {
  rank: string;
  time: Date;
}

export async function accountRankSnapshot(accountId: number): Promise<RankSnapshot> {
  const row = await one<{ user_id: number; rank_snapshot: string | null; activated_at: Date | null }>(
    'SELECT user_id, rank_snapshot, activated_at FROM accounts WHERE id = $1',
    [Number(accountId)],
  );
  if (!row) return { rank: 'Premium', time: new Date() };
  const user = await userById(row.user_id);
  const rank = row.rank_snapshot || user?.rank || 'Premium';
  return { rank, time: toDate(row.activated_at) ?? new Date() };
}

export async function setAccountRankSnapshot(accountId: number, rank?: string, time?: Date): Promise<void> {
  const acct = await accountById(Number(accountId));
  if (!acct) return;
  const user = await userById(acct.user_id);
  const finalRank = rank || user?.rank || 'Premium';
  await exec('UPDATE accounts SET rank_snapshot = $1, activated_at = $2 WHERE id = $3', [
    finalRank,
    time ?? new Date(),
    Number(accountId),
  ]);
}

interface RankHistoryEntry {
  old_rank: string;
  new_rank: string;
  upgraded_at: string;
}

export function parseRankHistory(user: UserRow | null): RankHistoryEntry[] {
  if (!user) return [];
  const raw = user.rank_history as unknown;
  let list: RankHistoryEntry[] = [];
  if (Array.isArray(raw)) list = raw as RankHistoryEntry[];
  else if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed as RankHistoryEntry[];
    } catch {
      list = [];
    }
  }
  return list.filter((e) => e && typeof e === 'object');
}

export async function addRankHistory(userId: number, oldRank: string, newRank: string, when = new Date()): Promise<void> {
  const user = await userById(userId);
  const history = parseRankHistory(user);
  history.push({ old_rank: oldRank, new_rank: newRank, upgraded_at: when.toISOString() });
  await exec('UPDATE users SET rank_history = $1::jsonb WHERE id = $2', [JSON.stringify(history), userId]);
  invalidateUser(userId);
}

/** Rank a member held at a past event time (rebuild/replay correctness). */
export async function getUserRankAt(userId: number, eventTime?: Date | string | null): Promise<string> {
  const user = await userById(userId);
  const current = user?.rank || 'Premium';
  const when = toDate(eventTime);
  if (!when) return current;
  const history = parseRankHistory(user)
    .slice()
    .sort((a, b) => new Date(a.upgraded_at).getTime() - new Date(b.upgraded_at).getTime());
  if (!history.length) return current;
  let rank = current;
  for (const h of history) {
    const at = new Date(h.upgraded_at).getTime();
    if (when.getTime() < at) return h.old_rank || rank;
    rank = h.new_rank || rank;
  }
  return rank;
}

/* ---------- depth ---------- */

export async function calculateNodeDepth(accountId: number): Promise<number> {
  let depth = 0;
  let current = Number(accountId);
  let safety = 0;
  while (current > 1 && safety++ < 200) {
    const up = await scalar<number>('SELECT upline_id FROM accounts WHERE id = $1', [current]);
    const upline = Number(up ?? 0);
    if (!upline || upline === current) break;
    depth++;
    current = upline;
  }
  return depth;
}

export async function setAccountDepth(accountId: number): Promise<number> {
  const depth = await calculateNodeDepth(accountId);
  await exec('UPDATE accounts SET depth = $1 WHERE id = $2', [depth, Number(accountId)]);
  return depth;
}

/* ---------- tree traversal helpers ---------- */

export async function legRoot(accountId: number, position: Position): Promise<number> {
  const id = await scalar<number>(
    'SELECT id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1',
    [Number(accountId), position],
  );
  return Number(id ?? 0);
}

/** Batch-per-level BFS of a subtree. Returns { relativeDepth: accountIds[] }. */
export async function subtreeByDepth(rootId: number, maxDepth = 25): Promise<Record<number, number[]>> {
  const result: Record<number, number[]> = { 0: [Number(rootId)] };
  if (!rootId) return result;
  let current = [Number(rootId)];
  for (let d = 1; d <= maxDepth && current.length; d++) {
    const rows = await q<{ id: number }>(
      `SELECT id FROM accounts WHERE upline_id = ANY($1::bigint[])`,
      [current],
    );
    if (!rows.length) break;
    current = rows.map((r) => Number(r.id));
    result[d] = current;
  }
  return result;
}

export async function liveDownlineCount(accountId: number): Promise<number> {
  const levels = await subtreeByDepth(Number(accountId), 40);
  let count = 0;
  for (const [depth, ids] of Object.entries(levels)) if (Number(depth) > 0) count += ids.length;
  return count;
}

export async function isAccountDescendant(rootId: number, targetId: number, includeSelf = true): Promise<boolean> {
  const root = Number(rootId);
  const target = Number(targetId);
  if (!root || !target) return false;
  if (includeSelf && root === target) return true;
  const queue = [root];
  const visited = new Set<number>();
  while (queue.length) {
    const current = Number(queue.shift());
    if (visited.has(current)) continue;
    visited.add(current);
    const kids = await q<{ id: number }>('SELECT id FROM accounts WHERE upline_id = $1', [current]);
    for (const k of kids) {
      const kid = Number(k.id);
      if (kid === target) return true;
      queue.push(kid);
    }
    if (visited.size > 20000) break;
  }
  return false;
}

export async function isInDownline(uplineAccountId: number, targetUserId: number): Promise<boolean> {
  const targetAccounts = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = $1', [Number(targetUserId)]);
  const ids = targetAccounts.map((r) => Number(r.id));
  if (!ids.length) return false;
  if (ids.includes(Number(uplineAccountId))) return true;
  const queue = [Number(uplineAccountId)];
  const visited = new Set<number>();
  while (queue.length) {
    const current = Number(queue.shift());
    if (visited.has(current)) continue;
    visited.add(current);
    const kids = await q<{ id: number }>('SELECT id FROM accounts WHERE upline_id = $1', [current]);
    for (const k of kids) {
      if (ids.includes(Number(k.id))) return true;
      queue.push(Number(k.id));
    }
  }
  return false;
}

/** Resolve the Mother Account that owns a Child Account node. */
export async function resolveParentMaForCa(ca: AccountRow | null): Promise<AccountRow | null> {
  if (!ca || !isCA(ca.account_type)) return null;
  let current: AccountRow | null = await accountById(ca.upline_id);
  let safety = 0;
  while (current && safety++ < 20) {
    if (isMA(current.account_type)) return current;
    current = await accountById(current.upline_id);
  }
  if (ca.sponsor_id > 0) return maAccountForUser(ca.sponsor_id);
  return null;
}

/* ---------- wallet / meta atomics ---------- */

/** mlm_atomic_meta_add(): race-safe balance increment, floored at 0. */
export async function addToWallet(userId: number, amount: number): Promise<void> {
  if (!userId || !amount) return;
  if (amount < 0) {
    await exec(
      `UPDATE users SET wallet_balance = GREATEST(0, wallet_balance + $1::numeric) WHERE id = $2`,
      [amount, Number(userId)],
    );
  } else {
    await exec(`UPDATE users SET wallet_balance = wallet_balance + $1::numeric WHERE id = $2`, [
      amount,
      Number(userId),
    ]);
  }
  invalidateUser(Number(userId));
}

/** Recompute one member's wallet straight from the ledger (source of truth). */
export async function resyncWallet(userId: number): Promise<number> {
  const earned = Number(
    (await scalar<string>(
      `SELECT COALESCE(SUM(amount),0) FROM ledger
       WHERE user_id = $1 AND type = 'cash' AND amount > 0 AND status <> 'hang'
         AND note NOT LIKE '%Encashment%'`,
      [userId],
    )) ?? 0,
  );
  const withdrawn = Number(
    (await scalar<string>(`SELECT COALESCE(SUM(ABS(amount)),0) FROM ledger WHERE user_id = $1 AND amount < 0`, [
      userId,
    ])) ?? 0,
  );
  const wallet = Math.max(0, earned - withdrawn);
  await exec('UPDATE users SET wallet_balance = $1 WHERE id = $2', [wallet, Number(userId)]);
  invalidateUser(Number(userId));
  return wallet;
}

export async function resyncAllWallets(): Promise<number> {
  await exec(`UPDATE users SET wallet_balance = 0`);
  const ids = await q<{ user_id: number }>('SELECT DISTINCT user_id FROM ledger');
  for (const r of ids) await resyncWallet(Number(r.user_id));
  return ids.length;
}

/* ---------- LP (unilevel eligibility) ---------- */

export function unilevelMonthlyResetOn(): boolean {
  return settingBool('mlm_sys_unilevel_monthly_reset', true);
}
export function unilevelCutoffHoldOn(): boolean {
  return settingBool('mlm_sys_unilevel_cutoff_hold', true);
}

export async function getMonthlyLp(userId: number): Promise<number> {
  const user = await userById(userId);
  if (!user) return 0;
  if (!unilevelMonthlyResetOn()) return Number(user.monthly_lp) || 0;
  const current = phMonthKey();
  if (user.monthly_lp_period !== current) {
    await exec('UPDATE users SET monthly_lp = 0, monthly_lp_period = $1 WHERE id = $2', [current, userId]);
    invalidateUser(userId);
    return 0;
  }
  return Number(user.monthly_lp) || 0;
}

export async function bumpMonthlyLp(userId: number, by = 1): Promise<number> {
  const user = await userById(userId);
  const current = phMonthKey();
  const resetOn = unilevelMonthlyResetOn();
  const base = !resetOn
    ? Number(user?.monthly_lp) || 0
    : user?.monthly_lp_period === current
      ? Number(user?.monthly_lp) || 0
      : 0;
  const next = Math.max(0, base + Number(by));
  await exec('UPDATE users SET monthly_lp = $1, monthly_lp_period = $2 WHERE id = $3', [
    next,
    resetOn ? current : (user?.monthly_lp_period || current),
    userId,
  ]);
  invalidateUser(userId);
  return next;
}

export async function getUsedProductLp(userId: number): Promise<number> {
  if (unilevelMonthlyResetOn()) {
    return Number(
      (await scalar<string>(
        `SELECT COUNT(*) FROM pins
         WHERE is_product = 1 AND status = 'used'
           AND COALESCE(used_by, purchaser_id) = $1
           AND to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $2`,
        [userId, phMonthKey()],
      )) ?? 0,
    );
  }
  return Number(
    (await scalar<string>(
      `SELECT COUNT(*) FROM pins
       WHERE is_product = 1 AND status = 'used' AND COALESCE(used_by, purchaser_id) = $1`,
      [userId],
    )) ?? 0,
  );
}

/** Effective LP = max(used product pins, manual/admin counter) — no double count. */
export async function getUnilevelLp(userId: number): Promise<number> {
  const [usedPin, manual] = await Promise.all([getUsedProductLp(userId), getMonthlyLp(userId)]);
  return Math.max(Number(usedPin) || 0, Number(manual) || 0);
}

export async function isActiveUnilevel(userId: number): Promise<boolean> {
  return (await getUnilevelLp(userId)) >= 5;
}

/* ---------- daily pairing limits ---------- */

export function dailyPairLimits(account: AccountRow | null, rank: string): { ab: number; tri: number } {
  const star = isStarRank(rank);
  const ca = isCA(account?.account_type);
  const maPremium = Math.max(1, settingInt('mlm_sys_limit_premium', 15));
  const maStar = Math.max(1, settingInt('mlm_sys_limit_starpremium', 30));
  const caPremium = Math.max(1, settingInt('mlm_sys_limit_ca_premium', 10));
  const caStar = Math.max(1, settingInt('mlm_sys_limit_ca_starpremium', 20));
  const limit = ca ? (star ? caStar : caPremium) : star ? maStar : maPremium;
  return { ab: limit, tri: limit };
}

export function maxChildDepth(): number {
  return Math.max(2, settingInt('mlm_sys_max_depth', 8));
}

/** Depth -> marketing level (1: rows 0-2, 2: rows 3-5, 3: rows 6-8). */
export function trinaryLevel(depth: number): number {
  const d = Number(depth);
  if (d <= 2) return 1;
  if (d <= 5) return 2;
  if (d <= 8) return 3;
  return Math.ceil((d + 1) / 3);
}

/* ---------- audit log ---------- */

export interface AuditInput {
  actorUserId?: number;
  actorUsername?: string;
  actorRole?: 'member' | 'admin' | 'system';
  category?: string;
  action: string;
  targetUserId?: number;
  targetUsername?: string;
  details?: unknown;
  ip?: string;
  userAgent?: string;
}

const BLOCKED_DETAIL_KEYS = ['pass', 'password', 'new_password', 'confirm_password', 'ca_pass', 'reg_pass', 'log_pass'];

export function sanitizeAuditDetails(data: unknown): unknown {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (BLOCKED_DETAIL_KEYS.includes(lower) || lower.includes('password') || lower.includes('pass')) out[k] = '[hidden]';
    else if (v && typeof v === 'object') out[k] = sanitizeAuditDetails(v);
    else out[k] = v;
  }
  return out;
}

export async function auditLog(input: AuditInput): Promise<void> {
  const details =
    typeof input.details === 'string' ? input.details : JSON.stringify(sanitizeAuditDetails(input.details ?? {}));
  await exec(
    `INSERT INTO audit_logs
       (actor_user_id, actor_username, actor_role, category, action, target_user_id, target_username, details, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      Number(input.actorUserId ?? 0),
      String(input.actorUsername ?? ''),
      String(input.actorRole ?? 'member'),
      String(input.category ?? 'system'),
      String(input.action ?? ''),
      Number(input.targetUserId ?? 0),
      String(input.targetUsername ?? ''),
      details.slice(0, 20000),
      String(input.ip ?? ''),
      String(input.userAgent ?? '').slice(0, 500),
    ],
  );
}

/* ---------- money formatting ---------- */

export function money(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export { settingNum };
