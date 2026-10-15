import { exec, one, q, scalar } from '../db';
import { phFormat, phPairingDayWindow } from '../time';
import { settingInt, settingNum } from '../settings';
import type { AccountRow, LedgerStatus, LedgerType, Position } from '../types';
import {
  accountById,
  accountRankSnapshot,
  addToWallet,
  dailyPairLimits,
  getUserRankAt,
  isAccountOnHold,
  isCA,
  isFreeAccountUser,
  isStarRank,
  isStarterRank,
  memberDisplayRank,
  setAccountDepth,
  subtreeByDepth,
  syncFreeAccountKindMeta,
  userById,
} from './accounts';
import { legQualifyingDownlineCount, triLegStructuralCap } from './placement';

/* =====================================================================
 * KAMADA POINT UPFLOW + TRI-LEG MATRIX ENGINE
 * Port of mlm_process_point_upflow() and mlm_evaluate_pairs().
 *
 * PHASE 1 — A+B point matching (order independent)
 *   Premium = 1 point, StarPremium = 3 points on the A/B (Left/Center) side.
 *   Each matched point pays ₱200; every 5th matched pair gives 1 GC instead.
 *   Unmatched strong-leg points stay waiting (no total flush-out).
 *
 * PHASE 2 — Tri-Leg / Right-leg release
 *   Triggers on completed A+B pairs + right-leg points. Payout follows the
 *   RECEIVER rank and the RIGHT-SOURCE package:
 *     StarPremium receiver + StarPremium source = 2 × ₱300
 *     otherwise                                 = 1 × ₱300
 *   Every 5th Tri-Leg unit gives 1 GC instead of cash.
 *
 * Daily capacity (GC included), reset 12:01 AM Philippine time:
 *   MA Premium 15 · MA StarPremium 30 · CA Premium 10 · CA StarPremium 20
 * ===================================================================== */

export interface LedgerInsert {
  user_id: number;
  amount: number;
  tax_deducted?: number;
  fee_deducted?: number;
  type: LedgerType;
  status: LedgerStatus;
  note: string;
  created_at?: Date;
}

export async function insertLedger(row: LedgerInsert): Promise<number> {
  const res = await q<{ id: number }>(
    `INSERT INTO ledger (user_id, amount, tax_deducted, fee_deducted, type, status, note, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now())) RETURNING id`,
    [
      Number(row.user_id),
      row.amount,
      row.tax_deducted ?? 0,
      row.fee_deducted ?? 0,
      row.type,
      row.status,
      row.note,
      row.created_at ?? null,
    ],
  );
  return Number(res[0]?.id ?? 0);
}

/* =====================================================================
 * DR BONUS — single source of truth (v9.5.0 FIX-2: DIRECT SPONSOR ONLY)
 * ===================================================================== */
export async function calcDrBonus(sponsorId: number, packageType: string, eventTime?: Date): Promise<number> {
  const pkg = String(packageType ?? '').replace(/\s+/g, '').toLowerCase();
  const sponsorRank = (await getUserRankAt(sponsorId, eventTime)).replace(/\s+/g, '').toLowerCase();
  // Starter rule: ANY pairing that involves a Starter — Starter sponsor with
  // any package, or Premium/StarPremium sponsor with a Starter package —
  // pays the flat Starter DR (₱50 by default).
  if (sponsorRank.includes('starter') || pkg.includes('starter')) return settingNum('mlm_sys_dr_starter', 50);
  const sponsorCap = sponsorRank.includes('starpremium')
    ? settingNum('mlm_sys_dr_starpremium', 1000)
    : settingNum('mlm_sys_dr_premium', 300);
  const placedCap = pkg.includes('starpremium')
    ? settingNum('mlm_sys_dr_starpremium', 1000)
    : settingNum('mlm_sys_dr_premium', 300);
  return Math.min(sponsorCap, placedCap);
}

export async function payDirectReferral(
  sponsorId: number,
  newUsername: string,
  packageType: string,
  noteSuffix = '',
  placedUserId = 0,
  eventTime?: Date,
): Promise<number> {
  const sponsor = Number(sponsorId);
  if (sponsor <= 0) return 0;
  const sponsorUser = await userById(sponsor);
  if (isAccountOnHold(sponsorUser)) return 0;
  if (Number(placedUserId) > 0) {
    const placed = await userById(Number(placedUserId));
    if (placed && isFreeAccountUser(placed) && !(await freeCanPayDirectReferralSafe(placed))) return 0;
  }
  const dr = await calcDrBonus(sponsor, packageType, eventTime ?? new Date());
  if (dr <= 0) return 0;
  await insertLedger({
    user_id: sponsor,
    amount: dr,
    type: 'cash',
    status: 'active',
    note: `Direct Referral Bonus (${newUsername} - ${packageType})${noteSuffix}`,
    created_at: eventTime,
  });
  await addToWallet(sponsor, dr);
  return dr;
}

async function freeCanPayDirectReferralSafe(user: Awaited<ReturnType<typeof userById>>): Promise<boolean> {
  const { freeCanPayDirectReferral } = await import('./accounts');
  return freeCanPayDirectReferral(user);
}

/* =====================================================================
 * POINT UPFLOW
 * ===================================================================== */
export async function processPointUpflow(
  newNodeId: number,
  originUserId: number,
  eventTimeOverride?: Date,
  syncStructure = true,
): Promise<void> {
  const nodeId = Number(newNodeId);
  const origin = Number(originUserId);

  const originUser = await userById(origin);

  // Structure is always persisted (free or paid).
  if (syncStructure) {
    await setAccountDepth(nodeId);
    if (originUser && isFreeAccountUser(originUser)) await syncFreeAccountKindMeta(origin);
  }

  // Free accounts excluded from upline pairing contribute NO points,
  // but they stay in the genealogy.
  if (originUser && !(await freeFlag(originUser, 'count'))) return;

  const snap = await accountRankSnapshot(nodeId);
  const eventTime = eventTimeOverride ?? snap.time;
  const rank = memberDisplayRank(originUser, snap.rank);
  if (isStarterRank(rank)) return; // Starter: no points at all

  const pointsToAdd = isStarRank(rank) ? 3 : 1;
  // Final rule: 1 right-leg trigger per member regardless of package.
  const rPointsToAdd = isStarRank(rank)
    ? settingInt('mlm_sys_rpts_starpremium', 1)
    : settingInt('mlm_sys_rpts_premium', 1);

  let currentNodeId = nodeId;
  let safety = 0;
  while (currentNodeId > 1 && safety++ < 500) {
    const current = await one<{ upline_id: number; position: Position }>(
      'SELECT upline_id, position FROM accounts WHERE id = $1',
      [currentNodeId],
    );
    if (!current || !current.upline_id) break;
    const uplineId = Number(current.upline_id);
    const leg = current.position;
    const uplineOwnerId = Number(
      (await scalar<number>('SELECT user_id FROM accounts WHERE id = $1', [uplineId])) ?? 0,
    );
    const isDirectChild = nodeId === currentNodeId;

    if (uplineOwnerId !== origin) {
      if (!isDirectChild) {
        const column = leg === 'L' ? 'left_points' : leg === 'C' ? 'center_points' : 'right_points';
        const delta = leg === 'R' ? rPointsToAdd : pointsToAdd;
        await exec(`UPDATE accounts SET ${column} = ${column} + $1 WHERE id = $2`, [delta, uplineId]);
      }
      await evaluatePairs(uplineId, origin, eventTime);
    }
    currentNodeId = uplineId;
  }
}

async function freeFlag(user: NonNullable<Awaited<ReturnType<typeof userById>>>, which: 'receive' | 'count' | 'dr'): Promise<boolean> {
  if (!isFreeAccountUser(user)) return true;
  if (which === 'receive') return !!user.free_receive_pairing;
  if (which === 'count') return !!user.free_count_for_upline_pairing;
  return !!user.free_pay_direct_referral;
}

/** Always set depth + re-check parent pairs after placing any node. */
export async function finalizeNewAccountStructure(newAccountId: number, originUserId = 0): Promise<void> {
  const id = Number(newAccountId);
  if (id <= 0) return;
  await setAccountDepth(id);
  const row = await accountById(id);
  if (!row) return;
  const owner = await userById(row.user_id);
  if (owner && isFreeAccountUser(owner)) await syncFreeAccountKindMeta(row.user_id, row.account_type);

  const uplineId = Number(row.upline_id);
  if (uplineId > 0) {
    await evaluatePairs(uplineId, originUserId || row.user_id);
    const upline = await accountById(uplineId);
    if (upline && isCA(upline.account_type) && Number(upline.upline_id) > 0) {
      await evaluatePairs(Number(upline.upline_id), originUserId || row.user_id);
    }
  }
}

/* =====================================================================
 * PAIR EVALUATION
 * ===================================================================== */
export async function evaluatePairs(accountId: number, sourceUserId = 0, eventTimeInput?: Date): Promise<void> {
  const account = await accountById(Number(accountId));
  if (!account) return;

  const sourceId = Number(sourceUserId);
  if (sourceId > 0) {
    const sourceUser = await userById(sourceId);
    // Hard source guard: a free account not usable by uplines never triggers a release.
    if (sourceUser && !(await freeFlag(sourceUser, 'count'))) return;
  }

  const userId = Number(account.user_id);
  const owner = await userById(userId);
  if (isAccountOnHold(owner)) return; // held accounts keep waiting points, no releases
  if (owner && !(await freeFlag(owner, 'receive'))) return;

  const eventTime = eventTimeInput ?? new Date();
  const rank = await getUserRankAt(userId, eventTime);
  if (isStarterRank(rank)) return;

  const isStar = isStarRank(rank);
  const bpAmount = settingNum('mlm_sys_bp_amount', 200);
  const triPremiumAmt = settingNum('mlm_sys_tri_premium', 300);
  const gcEvery = Math.max(1, settingInt('mlm_sys_gc_every', 5));
  const limits = dailyPairLimits(account, rank);
  const dailyAbLimit = limits.ab;
  const dailyCLimit = limits.tri;

  const { start: dayStart, end: dayEnd } = phPairingDayWindow(eventTime);
  const nowTime = phFormat(eventTime, 'g:i A');

  let lPts = Math.max(0, Number(account.left_points));
  let cPts = Math.max(0, Number(account.center_points));
  let rPts = Math.max(0, Number(account.right_points));

  const sourceName = sourceId > 0 ? ((await userById(sourceId))?.username ?? '') : '';
  const fromNote = sourceName ? ` (from: @${sourceName})` : '';

  /* ---------------- PHASE 1: A+B POINT MATCHING ---------------- */
  const abDoneToday = Number(
    (await scalar<string>(
      `SELECT COUNT(*) FROM ledger
       WHERE user_id = $1 AND note LIKE '%A+B Pair%' AND note NOT LIKE '%Flush Out%'
         AND created_at >= $2 AND created_at < $3`,
      [userId, dayStart, dayEnd],
    )) ?? 0,
  );
  const existingAbCount = Number(
    (await scalar<string>(
      `SELECT COUNT(*) FROM ledger
       WHERE user_id = $1 AND note LIKE '%A+B Pair%' AND note NOT LIKE '%Flush Out%'`,
      [userId],
    )) ?? 0,
  );

  let abReleasedNow = 0;
  let abFlushedNow = 0;
  while (lPts >= 1 && cPts >= 1) {
    lPts--;
    cPts--;
    if (abDoneToday + abReleasedNow >= dailyAbLimit) {
      // Daily max reached: the matched pair is flushed (no bonus).
      await insertLedger({
        user_id: userId,
        amount: 0,
        type: 'cash',
        status: 'active',
        note: `Flush Out - A+B Pair exceeded daily limit (${dailyAbLimit}/day)${fromNote} [${account.account_type}]`,
        created_at: eventTime,
      });
      abFlushedNow++;
      continue;
    }
    const pairNo = existingAbCount + abReleasedNow + 1;
    if (pairNo % gcEvery === 0) {
      await insertLedger({
        user_id: userId,
        amount: 1,
        type: 'gc',
        status: 'active',
        note: `A+B Pair GC (5th) - Pair #${pairNo} (${nowTime})${fromNote} [${account.account_type}]`,
        created_at: eventTime,
      });
    } else {
      await insertLedger({
        user_id: userId,
        amount: bpAmount,
        type: 'cash',
        status: 'released',
        note: `A+B Pair #${pairNo} Released (P${bpAmount}) (${nowTime})${fromNote} [${account.account_type}]`,
        created_at: eventTime,
      });
      await addToWallet(userId, bpAmount);
    }
    abReleasedNow++;
  }
  if (abReleasedNow + abFlushedNow > 0) {
    await exec('UPDATE accounts SET left_points = $1, center_points = $2 WHERE id = $3', [
      Math.max(0, lPts),
      Math.max(0, cPts),
      Number(accountId),
    ]);
  }

  /* ---------------- PHASE 2: TRI-LEG / RIGHT-LEG MATCHING ---------------- */
  // Flushed A+B rows still count as consumed triggers for Tri-Leg eligibility.
  let completedAbCount = Number(
    (await scalar<string>(`SELECT COUNT(*) FROM ledger WHERE user_id = $1 AND note LIKE '%A+B Pair%'`, [userId])) ?? 0,
  );
  const structuralAbCap = Math.min(
    await legQualifyingDownlineCount(Number(accountId), 'L'),
    await legQualifyingDownlineCount(Number(accountId), 'C'),
  );
  completedAbCount = Math.max(completedAbCount, structuralAbCap);
  // Gated by real account-count balance across all three legs at all depths.
  completedAbCount = Math.min(completedAbCount, await triLegStructuralCap(Number(accountId)));

  let triDone = await freshPairingCount(Number(accountId));
  if (rPts < 1 || triDone >= completedAbCount) return;

  // Right-leg sources in placement order (the direct child gives no point).
  const rSourceNames: { name: string; star: boolean }[] = [];
  const rLegRoot = Number(
    (await scalar<number>(`SELECT id FROM accounts WHERE upline_id = $1 AND position = 'R' LIMIT 1`, [
      Number(accountId),
    ])) ?? 0,
  );
  if (rLegRoot) {
    const levels = await subtreeByDepth(rLegRoot, 50);
    const descendants: number[] = [];
    for (const [depth, ids] of Object.entries(levels)) {
      if (Number(depth) === 0) continue;
      descendants.push(...ids);
    }
    if (descendants.length) {
      const members = await q<{ id: number; user_id: number }>(
        'SELECT id, user_id FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id ASC',
        [descendants],
      );
      for (const m of members) {
        if (Number(m.user_id) === userId) continue;
        const mu = await userById(Number(m.user_id));
        if (!mu) continue;
        // Earnings-source filter only: disabled free accounts stay structural.
        if (!(await freeFlag(mu, 'count'))) continue;
        const mRank = mu.rank || 'Premium';
        if (isStarterRank(mRank)) continue;
        rSourceNames.push({ name: mu.username, star: isStarRank(mRank) });
      }
    }
  }

  const existingTriUnits = Number(
    (await scalar<string>(`SELECT COUNT(*) FROM ledger WHERE user_id = $1 AND note LIKE '%Tri-Leg Release%'`, [
      userId,
    ])) ?? 0,
  );
  const cDoneToday = Number(
    (await scalar<string>(
      `SELECT COUNT(*) FROM ledger
       WHERE user_id = $1 AND note LIKE '%Tri-Leg Release%' AND created_at >= $2 AND created_at < $3`,
      [userId, dayStart, dayEnd],
    )) ?? 0,
  );

  let triReleasedNow = 0;
  let flushedC = 0;
  let triUnitsInserted = 0;

  while (rPts >= 1) {
    triDone = await freshPairingCount(Number(accountId));
    if (triDone + triReleasedNow + flushedC >= completedAbCount) break;
    const srcIdx = triDone + triReleasedNow + flushedC;
    const src = rSourceNames[srcIdx] ?? null;
    const rFrom = src && src.name ? ` (from: @${src.name})` : '';
    const srcLbl = src && src.star ? 'StarPremium Source' : 'Premium Source';
    const maLbl = isStar ? 'StarPremium' : 'Premium';
    const unitCount = isStar && src && src.star ? 2 : 1;

    for (let unitI = 1; unitI <= unitCount; unitI++) {
      const unitNo = existingTriUnits + triUnitsInserted + 1;
      const unitNote = unitCount > 1 ? ` Unit ${unitI}/${unitCount}` : '';
      if (cDoneToday + triUnitsInserted >= dailyCLimit) {
        await insertLedger({
          user_id: userId,
          amount: 0,
          type: 'cash',
          status: 'active',
          note: `Flush Out - Tri-Leg Release Pair #${unitNo} exceeded daily limit (${dailyCLimit}/day) [${account.account_type}]`,
          created_at: eventTime,
        });
      } else if (unitNo % gcEvery === 0) {
        await insertLedger({
          user_id: userId,
          amount: 1,
          type: 'gc',
          status: 'active',
          note: `Tri-Leg Release GC (5th)${rFrom} [${maLbl}${unitNote}; ${srcLbl}] - ${account.account_type} | Pair #${unitNo}`,
          created_at: eventTime,
        });
      } else {
        await insertLedger({
          user_id: userId,
          amount: triPremiumAmt,
          tax_deducted: 0,
          type: 'cash',
          status: 'active',
          note: `Tri-Leg Release Bonus${rFrom} [${maLbl}${unitNote}; ${srcLbl}] - ${account.account_type} | Pair #${unitNo} | P${triPremiumAmt}`,
          created_at: eventTime,
        });
        await addToWallet(userId, triPremiumAmt);
      }
      triUnitsInserted++;
    }
    rPts--;
    triReleasedNow++;
  }

  // Structural flush catch-up (e.g. A=17, B=17, C=16 with a 15/day cap).
  while (
    triDone + triReleasedNow + flushedC < completedAbCount &&
    cDoneToday + triUnitsInserted >= dailyCLimit
  ) {
    const unitNo = existingTriUnits + triUnitsInserted + 1;
    await insertLedger({
      user_id: userId,
      amount: 0,
      type: 'cash',
      status: 'active',
      note: `Flush Out - Tri-Leg Release Pair #${unitNo} exceeded daily limit (${dailyCLimit}/day) [${account.account_type}]`,
      created_at: eventTime,
    });
    triUnitsInserted++;
    flushedC++;
    if (rPts > 0) rPts--;
  }

  if (triReleasedNow + flushedC > 0) {
    await exec('UPDATE accounts SET right_points = $1, pairing_count = pairing_count + $2 WHERE id = $3', [
      Math.max(0, rPts),
      triReleasedNow + flushedC,
      Number(accountId),
    ]);
  }
}

async function freshPairingCount(accountId: number): Promise<number> {
  return Number((await scalar<number>('SELECT pairing_count FROM accounts WHERE id = $1', [accountId])) ?? 0);
}

/** Re-evaluate an account and, when it is a CA gate, its parent MA + siblings. */
export async function evaluatePairsCascade(accountId: number, sourceUserId = 0): Promise<void> {
  await evaluatePairs(Number(accountId), sourceUserId);
  const row = await accountById(Number(accountId));
  if (!row) return;
  if (isCA(row.account_type) && Number(row.upline_id) > 0) {
    await evaluatePairs(Number(row.upline_id), sourceUserId);
    const siblings = await q<{ id: number }>(
      `SELECT id FROM accounts WHERE upline_id = $1 AND account_type = 'CA' ORDER BY id ASC`,
      [row.upline_id],
    );
    for (const s of siblings) await evaluatePairs(Number(s.id), sourceUserId);
  }
}


