import { exec, one, q, scalar } from '../db';
import { phMonthKey } from '../time';
import { settingNum, unilevelMatrix } from '../settings';
import {
  addToWallet,
  bumpMonthlyLp,
  getMonthlyLp,
  isActiveUnilevel,
  invalidateUser,
  isAccountOnHold,
  isStarterRank,
  resyncAllWallets,
  unilevelCutoffHoldOn,
  unilevelMonthlyResetOn,
  userById,
} from './accounts';
import { insertLedger } from './pairing';

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

/**
 * Starter Product Commission — flat ₱20 per bottle (setting
 * `mlm_sys_product_comm_starter`) paid to the DIRECT sponsor of a Starter
 * buyer on that Starter's repeat product orders. The sponsor must be
 * Premium/StarPremium AND meet the 5-LP maintenance requirement
 * (isActiveUnilevel). Credited exactly like Unilevel: held until the
 * monthly cutoff when Cutoff Hold is ON, otherwise straight to wallet.
 * Returns 1 when a commission was credited, else 0.
 */
async function payStarterDirectProductComm(
  buyerRow: { id: number; sponsor_id?: number | null },
  qty: number,
  when: Date,
): Promise<number> {
  const sponsorId = Number(buyerRow.sponsor_id ?? 0);
  if (sponsorId <= 0) return 0;
  const sponsor = await userById(sponsorId);
  if (!sponsor || isAccountOnHold(sponsor)) return 0;
  const sponsorRank = String(sponsor.rank ?? '').replace(/\s+/g, '').toLowerCase();
  // Premium AND StarPremium both contain "premium" once spaces are removed;
  // Starter (or anything else) never qualifies.
  if (!sponsorRank.includes('premium')) return 0;
  if (!(await isActiveUnilevel(sponsorId))) return 0; // 5 LP maintenance gate

  const perBottle = settingNum('mlm_sys_product_comm_starter', 20);
  if (perBottle <= 0) return 0;
  const total = perBottle * qty;
  const holdUntilCutoff = unilevelCutoffHoldOn();
  await insertLedger({
    user_id: sponsorId,
    amount: total,
    type: 'cash',
    status: holdUntilCutoff ? 'hang' : 'active',
    note:
      `Product Comm (Direct Starter Repeat Order | Qty: ${qty})` +
      (holdUntilCutoff ? ' - Floating (LP)' : ''),
    created_at: when,
  });
  if (!holdUntilCutoff) await addToWallet(sponsorId, total);
  return 1;
}

export async function processUnilevelCommission(
  buyerUserId: number,
  qty = 1,
  eventTime?: Date | string | null,
  kind?: 'UNI' | 'PCC' | null,
): Promise<number> {
  const buyer = Number(buyerUserId);
  const amount = Math.max(1, Number(qty) || 1);
  const when = eventTime ? new Date(eventTime) : new Date();

  const buyerRow = await userById(buyer);
  if (!buyerRow) return 0;
  // Unilevel and Product Commission follow SEPARATE rules, decided by the
  // code type the admin issued (pin series), with rank eligibility:
  //  - PCC (Product) codes pay the Product Commission only for Starter
  //    activations: per-bottle to their DIRECT Premium/StarPremium sponsor
  //    once that sponsor meets 5 LP (payStarterDirectProductComm).
  //  - UNI (Unilevel) codes pay Unilevel compression only for
  //    Premium/StarPremium activations; a Starter activating a UNI code
  //    earns the LP credit only, no commissions.
  //  - Plain (legacy, no-series) codes keep the rank-based rule below.
  const buyerIsStarter = isStarterRank(buyerRow.rank);
  if (kind === 'PCC') {
    return buyerIsStarter ? payStarterDirectProductComm(buyerRow, amount, when) : 0;
  }
  if (kind === 'UNI') {
    if (buyerIsStarter) return 0;
  } else if (buyerIsStarter) {
    return payStarterDirectProductComm(buyerRow, amount, when);
  }

  const matrix = unilevelMatrix();
  const uplines = await getStructuralUnilevelUplines(buyer, 100);
  const maxPaidTiers = 10;
  let paidTier = 0;
  let paid = 0;

  for (const upline of uplines) {
    if (paidTier >= maxPaidTiers) break;
    const sponsorId = Number(upline.user_id);
    if (sponsorId <= 0) continue;

    const sponsor = await userById(sponsorId);
    if (!sponsor) continue;
    if (isAccountOnHold(sponsor)) continue; // paused recipients do not receive
    if (isStarterRank(sponsor.rank)) continue; // compressed out, no tier consumed
    if (!(await isActiveUnilevel(sponsorId))) continue; // < 5 LP, compressed out

    paidTier++;
    const commPerBottle = matrix[paidTier - 1] ?? 0;
    if (commPerBottle <= 0) continue;
    const total = commPerBottle * amount;

    const holdUntilCutoff = unilevelCutoffHoldOn();
    await insertLedger({
      user_id: sponsorId,
      amount: total,
      type: 'cash',
      status: holdUntilCutoff ? 'hang' : 'active',
      note:
        `Unilevel Comm (Compressed Level ${paidTier} | Structural Level ${upline.level} | Qty: ${amount})` +
        (holdUntilCutoff ? ' - Floating (LP)' : ''),
      created_at: when,
    });
    if (!holdUntilCutoff) await addToWallet(sponsorId, total);
    paid++;
  }
  return paid;
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
  currentPeriod: string,
): Promise<void> {
  {
    const uid = Number(g.user_id);
    const amt = Number(g.total);
    if (uid <= 0) return;
    const u = await userById(uid);
    if (isAccountOnHold(u)) return; // retried on a later run

    const maintained = (await lpActivatedInMonth(uid, g.accrual_month)) >= 5;
    if (maintained) {
      if (amt > 0) await addToWallet(uid, amt);
      await exec(
        `UPDATE ledger SET status = 'released'
         WHERE user_id = $1 AND (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%')
           AND type = 'cash' AND status = 'hang'
           AND to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $2`,
        [uid, g.accrual_month],
      );
    } else {
      // No active maintenance in the accrual month: floating resets to zero.
      await exec(
        `UPDATE ledger SET status = 'forfeited',
             note = regexp_replace(note, ' - (Floating \\(LP\\)|Pending Cutoff)$', '') || ' - Forfeited (No Maintenance)'
         WHERE user_id = $1 AND (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%')
           AND type = 'cash' AND status = 'hang'
           AND to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $2`,
        [uid, g.accrual_month],
      );
    }
  }
}

/** Rebuild unilevel rows from used product pins (scope-aware). */
export async function rebuildUnilevelCommissionsScope(currentPeriodOnly?: boolean): Promise<number> {
  const periodScoped = currentPeriodOnly ?? unilevelMonthlyResetOn();
  let count = 0;

  if (periodScoped) {
    const period = phMonthKey();
    await exec(
      `DELETE FROM ledger WHERE (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%')
         AND to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $1`,
      [period],
    );
    const rows = await q<{ activator_id: number; event_date: string; qty: string; kind: string }>(
      `SELECT COALESCE(used_by, purchaser_id) AS activator_id,
              to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS event_date,
              CASE WHEN pin_code LIKE 'UNI-%' THEN 'UNI' WHEN pin_code LIKE 'PCC-%' THEN 'PCC' ELSE '' END AS kind,
              COUNT(*)::text AS qty
       FROM pins
       WHERE is_product = 1 AND status = 'used'
         AND to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $1
       GROUP BY activator_id, event_date, kind`,
      [period],
    );
    for (const r of rows) {
      await processUnilevelCommission(Number(r.activator_id), Number(r.qty), `${r.event_date}T00:00:00+08:00`, r.kind === 'UNI' || r.kind === 'PCC' ? r.kind : null);
      count += Number(r.qty);
    }
  } else {
    await exec(`DELETE FROM ledger WHERE note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%'`);
    const rows = await q<{ activator_id: number; event_date: string; qty: string; kind: string }>(
      `SELECT COALESCE(used_by, purchaser_id) AS activator_id,
              to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS event_date,
              CASE WHEN pin_code LIKE 'UNI-%' THEN 'UNI' WHEN pin_code LIKE 'PCC-%' THEN 'PCC' ELSE '' END AS kind,
              COUNT(*)::text AS qty
       FROM pins
       WHERE is_product = 1 AND status = 'used'
       GROUP BY activator_id, event_date, kind`,
    );
    for (const r of rows) {
      await processUnilevelCommission(Number(r.activator_id), Number(r.qty), `${r.event_date}T00:00:00+08:00`, r.kind === 'UNI' || r.kind === 'PCC' ? r.kind : null);
      count += Number(r.qty);
    }
  }

  await releaseMaturedUnilevelCommissions();
  await resyncAllWallets();
  return count;
}

/**
 * Product activation entry point. If a member crosses the 5-LP threshold
 * AFTER downlines already activated products, their previously skipped
 * commissions are caught up with a scoped rebuild.
 */
export async function handleProductActivationUnilevel(activatorId: number, qty = 1, kind?: 'UNI' | 'PCC' | null): Promise<void> {
  const id = Number(activatorId);
  const amount = Math.max(1, Number(qty) || 1);
  if (id <= 0) return;
  const oldLp = await getMonthlyLp(id);
  const newLp = await bumpMonthlyLp(id, amount);
  if (oldLp < 5 && newLp >= 5) await rebuildUnilevelCommissionsScope(unilevelMonthlyResetOn());
  else await processUnilevelCommission(id, amount, undefined, kind);
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

  const affected = await exec(
    `UPDATE pins SET status = 'used', used_by = $1, used_at = now(),
        activation_source = $2, activated_by_user_id = NULLIF($3, 0)
     WHERE id = $4`,
    [usedBy, src, actor, id],
  );
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


