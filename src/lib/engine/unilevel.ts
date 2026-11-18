import { exec, one, q, scalar, tx } from '../db';
import { phMonthKey } from '../time';
import { settingNum, unilevelMatrix } from '../settings';
import {
  addToWallet,
  bumpMonthlyLp,
  getMonthlyLp,
  getUserRankAt,
  isActiveUnilevel,
  invalidateUser,
  isAccountOnHold,
  isStarterRank,
  unilevelCutoffHoldOn,
  unilevelMonthlyResetOn,
  userById,
} from './accounts';

/* =====================================================================
 * UNILEVEL — DYNAMIC COMPRESSION (v9.6.110)
 *
 * Eligibility = ">= 5 product units (LP)" in the current month (or lifetime
 * when the monthly-reset switch is OFF).
 *
 * Level rule (SPONSOR chain, not the placement tree):
 *   - A product activation pays the activator's direct sponsor chain upward.
 *   - CA1/CA2/CA3 are connector nodes only: skipped, never a paid level.
 *   - Ineligible / Starter uplines are COMPRESSED OUT and do not consume a
 *     paid tier, so the next eligible upline takes the next tier (L1..L10).
 * ===================================================================== */

export interface UnilevelUpline {
  level: number;
  account_id: number;
  user_id: number;
}

export async function getStructuralUnilevelUplines(
  buyerUserId: number,
  maxLevels = 100,
): Promise<UnilevelUpline[]> {
  const uplines: UnilevelUpline[] = [];
  if (Number(buyerUserId) <= 0) return uplines;

  let currentUserId = Number(buyerUserId);
  const seen = new Set<number>([currentUserId]);
  let safety = 0;

  while (uplines.length < maxLevels && safety++ < 300) {
    const currentAcc = await one<{ id: number; user_id: number; sponsor_id: number; account_type: string }>(
      `SELECT id, user_id, sponsor_id, account_type FROM accounts
       WHERE user_id = $1 AND status = 1
       ORDER BY CASE WHEN account_type = 'MA' THEN 0 ELSE 1 END, id ASC LIMIT 1`,
      [currentUserId],
    );
    if (!currentAcc) break;

    let candidate = Number(currentAcc.sponsor_id);
    if (candidate <= 0) break;

    let connectorSafety = 0;
    let added = false;

    while (candidate > 0 && connectorSafety++ < 20) {
      if (seen.has(candidate)) {
        candidate = 0;
        break;
      }
      const candidateMa = await one<{ id: number; user_id: number; sponsor_id: number }>(
        `SELECT id, user_id, sponsor_id FROM accounts
         WHERE user_id = $1 AND account_type = 'MA' AND status = 1 ORDER BY id ASC LIMIT 1`,
        [candidate],
      );
      if (candidateMa) {
        uplines.push({
          level: uplines.length + 1,
          account_id: Number(candidateMa.id),
          user_id: Number(candidateMa.user_id),
        });
        seen.add(candidate);
        currentUserId = candidate;
        added = true;
        break;
      }
      // No MA for this user: if it is a CA connector, hop to its owner/sponsor
      // WITHOUT consuming a unilevel level.
      const candidateCa = await one<{ id: number; user_id: number; sponsor_id: number }>(
        `SELECT id, user_id, sponsor_id FROM accounts
         WHERE user_id = $1 AND account_type = 'CA' AND status = 1 ORDER BY id ASC LIMIT 1`,
        [candidate],
      );
      if (candidateCa && Number(candidateCa.sponsor_id) > 0) {
        seen.add(candidate);
        candidate = Number(candidateCa.sponsor_id);
        continue;
      }
      candidate = 0;
      break;
    }

    if (!added) break;
  }

  return uplines;
}

/** Atomically insert one source-linked payout and update wallet at most once. */
async function creditTracked(sourcePinId: number, userId: number, total: number, hold: boolean, note: string, when: Date): Promise<number> {
  if (!sourcePinId) throw new Error('Product payout requires a tracked activation.');
  const inserted = await tx(async (client) => {
    const row = await client.query(
      `INSERT INTO ledger(user_id,amount,type,status,note,created_at,source_product_pin_id)
       VALUES ($1,$2,'cash',$3,$4,$5,$6)
       ON CONFLICT (source_product_pin_id,user_id) WHERE source_product_pin_id IS NOT NULL DO NOTHING RETURNING id`,
      [userId, total, hold ? 'hang' : 'active', note, when, sourcePinId],
    );
    if (row.rowCount && !hold) await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [total, userId]);
    return Number(row.rowCount || 0);
  });
  if (inserted && !hold) invalidateUser(userId);
  return inserted;
}

interface CommissionSnapshot {
  version: 1;
  buyerId: number;
  buyerStarter: boolean;
  codeKind: 'UNI' | 'PCC' | 'legacy';
  sponsorId: number;
  sponsorRank: string;
  sponsorHeld: boolean;
  uplines: { level: number; userId: number; rank: string; held: boolean }[];
  rates: number[];
  productRate: number;
  hold: boolean;
}

/** Capture the rule inputs at activation; a later rank, network, or rate change
 * cannot silently rewrite the historical transaction. Caller must be in tx. */
async function makeCommissionSnapshot(pinId: number, buyerId: number): Promise<CommissionSnapshot> {
  const buyer = await one<{rank: string; sponsor_id: number}>('SELECT rank,sponsor_id FROM users WHERE id=$1', [buyerId]);
  const pin = await one<{pin_code: string}>('SELECT pin_code FROM pins WHERE id=$1 AND status=\'unused\' AND is_product=1', [pinId]);
  if (!buyer || !pin) throw new Error('Unable to snapshot product activation.');
  const chain = await getStructuralUnilevelUplines(buyerId, 100);
  const ids = Array.from(new Set([buyerId, Number(buyer.sponsor_id || 0), ...chain.map(x => Number(x.user_id))].filter(Boolean))).sort((a,b)=>a-b);
  // Lock in deterministic order so ranks cannot change during the snapshot.
  const users = await q<{id: number; rank: string; account_held: boolean}>('SELECT id,rank,account_held FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
  const byId = new Map(users.map(u => [Number(u.id),u]));
  const lockedBuyer = byId.get(buyerId);
  if (!lockedBuyer) throw new Error('Unable to snapshot buyer rank.');
  const sponsor = byId.get(Number(buyer.sponsor_id || 0));
  return {
    version: 1, buyerId, buyerStarter: isStarterRank(lockedBuyer.rank),
    codeKind: /^PCC-/i.test(pin.pin_code) ? 'PCC' : /^UNI-/i.test(pin.pin_code) ? 'UNI' : 'legacy',
    sponsorId: Number(buyer.sponsor_id || 0), sponsorRank: sponsor?.rank || '', sponsorHeld: !!sponsor?.account_held,
    uplines: chain.map(u => ({ level: u.level, userId: Number(u.user_id), rank: byId.get(Number(u.user_id))?.rank || '', held: !!byId.get(Number(u.user_id))?.account_held })),
    rates: unilevelMatrix(), productRate: settingNum('mlm_sys_product_comm_starter',20), hold: unilevelCutoffHoldOn(),
  };
}

async function processUnilevelCommissionLocked(
  buyerUserId: number, qty = 1, eventTime?: Date | string | null,
  _kind?: 'UNI' | 'PCC' | null, sourcePinId = 0, targetRecipient?: number,
): Promise<number> {
  if (!sourcePinId || qty !== 1) throw new Error('Unattributed historical activation requires review.');
  const pin = await one<{commission_snapshot: CommissionSnapshot | null; used_at: Date}>('SELECT commission_snapshot,used_at FROM pins WHERE id=$1 AND status=\'used\' AND commission_tracked FOR UPDATE', [sourcePinId]);
  const event = pin?.commission_snapshot;
  if (!event || event.version !== 1 || Number(event.buyerId) !== Number(buyerUserId)) throw new Error('Activation snapshot missing; review required.');
  const when = eventTime ? new Date(eventTime) : new Date(pin!.used_at);
  const product = event.buyerStarter && event.codeKind !== 'UNI';
  if ((event.codeKind === 'PCC' && !event.buyerStarter) || (event.codeKind === 'UNI' && event.buyerStarter)) return 0;
  if (product) {
    const uid = Number(event.sponsorId);
    if (!uid || (targetRecipient && uid !== targetRecipient) || event.sponsorHeld || !String(event.sponsorRank).replace(/\s+/g,'').toLowerCase().includes('premium')) return 0;
    const recipient = await userById(uid);
    if (!recipient || isAccountOnHold(recipient) || !(await isActiveUnilevel(uid)) || event.productRate <= 0) return 0;
    return creditTracked(sourcePinId, uid, event.productRate, event.hold,
      `Product Comm (Direct Starter Repeat Order | Qty: 1)` + (event.hold ? ' - Floating (LP)' : ''), when);
  }
  // Compute the currently proposed allocation without mutating it. Later
  // qualification can move an already paid upline to a different compressed
  // level; preserving that payout AND paying another user at its original
  // level would pay the same tier twice. Never make that guess silently.
  const eligible: { uid: number; tier: number; structuralLevel: number; rate: number }[] = [];
  for (const up of event.uplines) {
    if (eligible.length >= 10) break;
    const uid = Number(up.userId);
    if (!uid || up.held || isStarterRank(up.rank)) continue;
    const recipient = await userById(uid);
    if (!recipient || isAccountOnHold(recipient) || !(await isActiveUnilevel(uid))) continue;
    const tier = eligible.length + 1;
    eligible.push({uid, tier, structuralLevel: up.level, rate: Number(event.rates[tier-1] || 0)});
  }
  const candidates = eligible.filter(x => x.rate > 0 && (!targetRecipient || x.uid === targetRecipient));
  if (!candidates.length) return 0;
  const prior = await q<{user_id: number; amount: string; note: string}>(
    'SELECT user_id,amount,note FROM ledger WHERE source_product_pin_id=$1 ORDER BY id', [sourcePinId]);
  const existingUsers = new Set<number>();
  const existingTiers = new Set<number>();
  let inconsistent = false;
  for (const row of prior) {
    const uid = Number(row.user_id);
    const match = /^Unilevel Comm \(Compressed Level (\d+) \| Structural Level (\d+) \| Qty: 1\)/.exec(row.note);
    const current = eligible.find(x => x.uid === uid);
    const tier = match ? Number(match[1]) : 0;
    if (!match || !current || current.tier !== tier || current.structuralLevel !== Number(match[2]) ||
        Math.abs(Number(row.amount)-Number(event.rates[tier-1] || 0)) > 0.001 ||
        existingUsers.has(uid) || existingTiers.has(tier)) inconsistent = true;
    existingUsers.add(uid); existingTiers.add(tier);
  }
  let paid = 0;
  for (const item of candidates) {
    if (existingUsers.has(item.uid)) continue; // retry of an already-paid source
    if (inconsistent || existingTiers.has(item.tier)) {
      await exec(`INSERT INTO commission_review(pin_id,beneficiary_id,reason)
        VALUES($1,$2,'Compressed tier conflicts with an existing source-linked payment; preserve prior payout and review allocation.')
        ON CONFLICT(pin_id,beneficiary_id) DO NOTHING`, [sourcePinId,item.uid]);
      continue;
    }
    paid += await creditTracked(sourcePinId, item.uid, item.rate, event.hold,
      `Unilevel Comm (Compressed Level ${item.tier} | Structural Level ${item.structuralLevel} | Qty: 1)` + (event.hold ? ' - Floating (LP)' : ''), when);
    existingUsers.add(item.uid); existingTiers.add(item.tier);
  }
  return paid;
}

/** Serialize all allocation decisions for a source activation. */
export async function processUnilevelCommission(
  buyerUserId: number, qty = 1, eventTime?: Date | string | null,
  kind?: 'UNI' | 'PCC' | null, sourcePinId = 0, targetRecipient?: number,
): Promise<number> {
  return tx(() => processUnilevelCommissionLocked(buyerUserId, qty, eventTime, kind, sourcePinId, targetRecipient));
}

/** Release last month's held unilevel commissions once the cutoff passes. */
/**
 * Monthly settlement (FLOATING Commission (LP) -> earnings).
 *
 * On the 1st of the following month, each member's held (FLOATING) Unilevel +
 * Product Comm rows from a prior month settle PER ACCRUAL MONTH:
 *  - Maintained that month (5+ LP activated): amount is credited to the
 *    wallet (Total Earnings / Available Balance) and rows become 'released'.
 *  - Not maintained: the floating commission resets to zero — rows become
 *    'forfeited' (kept in history, never paid out).
 * Accounts on hold are skipped and retried on a later settlement run.
 */
async function lpActivatedInMonth(userId: number, monthKey: string): Promise<number> {
  if (!unilevelMonthlyResetOn()) return getMonthlyLp(userId); // lifetime counter
  const n = await scalar<string>(
    `SELECT COUNT(*) FROM pins
     WHERE is_product = 1 AND status = 'used'
       AND COALESCE(used_by, purchaser_id) = $1
       AND to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $2`,
    [userId, monthKey],
  );
  return Number(n ?? 0);
}

export async function releaseMaturedUnilevelCommissions(): Promise<number> {
  if (!unilevelCutoffHoldOn()) return 0;
  const currentPeriod = phMonthKey();

  const groups = await q<{ user_id: number; accrual_month: string; total: string }>(
    `SELECT user_id,
            to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') AS accrual_month,
            COALESCE(SUM(amount),0)::text AS total
     FROM ledger
     WHERE (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%') AND type = 'cash' AND status = 'hang'
       AND to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') < $1
     GROUP BY user_id, accrual_month`,
    [currentPeriod],
  );

  let settled = 0;
  for (const g of groups) {
    // One bad group must never break a dashboard load; it is retried next run.
    try {
      await settleFloatingGroup(g, currentPeriod);
      settled++;
    } catch (e) {
      console.error('FLOATING settlement failed for group', g, e);
    }
  }
  return settled;
}

async function settleFloatingGroup(
  g: { user_id: number; accrual_month: string; total: string },
  _currentPeriod: string,
): Promise<void> {
  const uid = Number(g.user_id);
  if (uid <= 0) return;
  await tx(async (client) => {
    const locked = await client.query('SELECT account_held FROM users WHERE id=$1 FOR UPDATE', [uid]);
    if (!locked.rowCount || locked.rows[0].account_held) return;
    const maintained = (await lpActivatedInMonth(uid, g.accrual_month)) >= 5;
    if (maintained) {
      // Sum only rows this transaction actually transitions; a concurrent
      // settlement can never credit the same FLOATING entry twice.
      const released = await client.query(
        `UPDATE ledger SET status='released'
         WHERE user_id=$1 AND (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%')
           AND type='cash' AND status='hang'
           AND to_char(created_at AT TIME ZONE 'Asia/Manila','YYYY-MM')=$2
         RETURNING amount`, [uid,g.accrual_month]);
      const amount = released.rows.reduce((sum, r) => sum + Number(r.amount), 0);
      if (amount > 0) await client.query('UPDATE users SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,uid]);
    } else {
      await client.query(
        `UPDATE ledger SET status='forfeited',
          note=regexp_replace(note, ' - (Floating \\(LP\\)|Pending Cutoff)$', '') || ' - Forfeited (No Maintenance)'
         WHERE user_id=$1 AND (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%')
           AND type='cash' AND status='hang'
           AND to_char(created_at AT TIME ZONE 'Asia/Manila','YYYY-MM')=$2`, [uid,g.accrual_month]);
    }
  });
  invalidateUser(uid);
}

/** Preserve existing earnings. New source-linked activations can be caught up
 * idempotently; untracked legacy activations are queued for review instead. */
async function catchUpForMember(userId: number): Promise<void> {
  const period = unilevelMonthlyResetOn() ? phMonthKey() : null;
  // New activations have indexed, immutable recipient candidates.
  const tracked = await q<{id: number; activator_id: number; used_at: Date}>(
    `SELECT p.id, p.used_by AS activator_id, p.used_at
     FROM commission_event_targets t JOIN pins p ON p.id=t.pin_id
     WHERE t.recipient_id=$1 AND p.is_product=1 AND p.status='used'
       AND p.commission_tracked AND p.commission_snapshot IS NOT NULL
       AND ($2::text IS NULL OR to_char(p.used_at AT TIME ZONE 'Asia/Manila','YYYY-MM')=$2)
     ORDER BY p.used_at,p.id`, [userId,period]);
  for (const row of tracked) {
    if (Number(row.activator_id) !== userId)
      await processUnilevelCommission(Number(row.activator_id), 1, row.used_at, null, Number(row.id), userId);
  }
  // Existing rows lack immutable provenance. Conservatively flag potentially
  // related legacy events, never credit them or delete an existing ledger row.
  await exec(`WITH RECURSIVE descendants(user_id) AS (
      SELECT $1::bigint
      UNION
      SELECT a.user_id FROM accounts a JOIN descendants d ON a.sponsor_id=d.user_id
      WHERE a.user_id<>d.user_id
    )
    INSERT INTO commission_review(pin_id,beneficiary_id,reason)
    SELECT p.id,$1,'Legacy activation without reliable payout provenance; check before crediting.'
    FROM pins p LEFT JOIN users u ON u.id=COALESCE(p.used_by,p.purchaser_id)
    WHERE p.is_product=1 AND p.status='used' AND (NOT p.commission_tracked OR p.commission_snapshot IS NULL)
      AND COALESCE(p.used_by,p.purchaser_id)<>$1
      AND ($2::text IS NULL OR to_char(COALESCE(p.used_at,p.created_at) AT TIME ZONE 'Asia/Manila','YYYY-MM')=$2)
      AND (u.sponsor_id=$1 OR COALESCE(p.used_by,p.purchaser_id) IN (SELECT user_id FROM descendants))
    ON CONFLICT(pin_id,beneficiary_id) DO NOTHING`, [userId,period]);
}

/** Legacy destructive rebuild is deliberately unavailable. */
export async function rebuildUnilevelCommissionsScope(_currentPeriodOnly?: boolean): Promise<number> {
  throw new Error('Destructive commission rebuild disabled to protect earnings.');
}

/** Normal payout plus non-destructive, source-linked catch-up. */
export async function handleProductActivationUnilevel(activatorId: number, qty = 1, kind?: 'UNI' | 'PCC' | null, sourcePinId = 0): Promise<void> {
  const id = Number(activatorId);
  if (id <= 0 || !sourcePinId || qty !== 1) throw new Error('A single tracked product activation is required.');
  const pin = await one<{used_at: Date}>("SELECT used_at FROM pins WHERE id=$1 AND commission_tracked AND status='used' AND used_by=$2", [sourcePinId,id]);
  if (!pin) throw new Error('Tracked product activation not found.');
  const newLp = await bumpMonthlyLp(id, qty);
  await processUnilevelCommission(id, 1, pin.used_at, kind, sourcePinId);
  if (newLp >= 5 || await isActiveUnilevel(id)) await catchUpForMember(id);
}

/**
 * mlm_mark_product_pin_used() — records status, recipient, activation source
 * (member/admin) and the actor who performed the activation. Does NOT trigger
 * unilevel; the caller decides.
 */
export async function markProductPinUsed(
  pinId: number,
  usedByUserId: number,
  source: 'member' | 'admin' = 'member',
  activatedByUserId = 0,
): Promise<boolean> {
  const id = Number(pinId);
  const usedBy = Number(usedByUserId);
  const src = source === 'admin' ? 'admin' : 'member';
  let actor = Number(activatedByUserId);
  if (src === 'member' && actor <= 0) actor = usedBy;
  if (id <= 0 || usedBy <= 0) return false;

  const snapshot = await makeCommissionSnapshot(id, usedBy);
  const affected = await exec(
    `UPDATE pins SET status = 'used', used_by = $1, used_at = now(),
        activation_source = $2, activated_by_user_id = NULLIF($3, 0), commission_tracked = TRUE, commission_snapshot = $5::jsonb
     WHERE id = $4 AND status='unused' AND is_product=1`,
    [usedBy, src, actor, id, JSON.stringify(snapshot)],
  );
  if (affected > 0) {
    const targets = Array.from(new Set([snapshot.sponsorId, ...snapshot.uplines.map(u => u.userId)].filter(n => n > 0 && n !== usedBy)));
    if (targets.length) await exec(`INSERT INTO commission_event_targets(pin_id,recipient_id)
      SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, [id, targets]);
  }
  invalidateUser(usedBy);
  return affected > 0;
}

/** LP contribution summary used by admin alerts + member dashboards. */
export async function unilevelEligibilitySnapshot(userId: number): Promise<{
  lp: number;
  eligible: boolean;
  period: string;
  mode: 'monthly' | 'lifetime';
}> {
  const { getUnilevelLp } = await import('./accounts');
  const lp = await getUnilevelLp(userId);
  return {
    lp,
    eligible: lp >= 5,
    period: phMonthKey(),
    mode: unilevelMonthlyResetOn() ? 'monthly' : 'lifetime',
  };
}

export async function usedProductPinCount(userId: number): Promise<number> {
  return Number(
    (await scalar<string>(
      `SELECT COUNT(*) FROM pins WHERE is_product = 1 AND status = 'used' AND COALESCE(used_by, purchaser_id) = $1`,
      [userId],
    )) ?? 0,
  );
}


