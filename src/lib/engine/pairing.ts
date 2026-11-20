import { exec, one, q, scalar, tx } from '../db';
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

/** An out-of-order event can be processed at the later event time only if
 * it is the same pairing day and rank, and no subsequent pairing output has
 * already been issued. Otherwise ordering could change a cap or GC decision. */
async function safelyAdvancePairingTime(userId: number, earlier: Date, later: Date): Promise<boolean> {
  if (phPairingDayWindow(earlier).start.getTime() !== phPairingDayWindow(later).start.getTime()) return false;
  if ((await getUserRankAt(userId,earlier)) !== (await getUserRankAt(userId,later))) return false;
  const alreadyIssued = await scalar<boolean>(`SELECT EXISTS(SELECT 1 FROM ledger WHERE user_id=$1
    AND (note LIKE '%A+B Pair%' OR note LIKE '%Tri-Leg Release%') AND created_at>$2)`,[userId,earlier]);
  return !alreadyIssued;
}

/* =====================================================================
 * POINT UPFLOW
 * ===================================================================== */
async function processPointUpflowInternal(
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
  // PHP final rule: one Right trigger per qualifying source, regardless of rank.
  // An old database setting of 2 must not resurrect duplicate triggers.
  const rPointsToAdd = 1;

  let currentNodeId = nodeId;
  let safety = 0;
  while (currentNodeId > 1 && safety++ < 500) {
    const current = await one<{ upline_id: number; position: Position }>(
      'SELECT upline_id, position FROM accounts WHERE id = $1',
      [currentNodeId],
    );
    if (!current || Number(current.upline_id) <= 0) break;
    const uplineId = Number(current.upline_id);
    const leg = current.position;
    const uplineOwnerId = Number(
      (await scalar<number>('SELECT user_id FROM accounts WHERE id = $1', [uplineId])) ?? 0,
    );
    const isDirectChild = nodeId === currentNodeId;

    // As in the supplied PHP, points can accumulate while a recipient is
    // Starter; evaluatePairs does not pay it until it has an eligible rank.
    if (uplineOwnerId !== origin) {
      if (!isDirectChild) {
        const column = leg === 'L' ? 'left_points' : leg === 'C' ? 'center_points' : 'right_points';
        const delta = leg === 'R' ? rPointsToAdd : pointsToAdd;
        // Serialize against other source events before checking event order.
        // A delayed older event cannot safely spend newer contributions or be
        // backdated into a different daily capacity window.
        await one('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[uplineId]);
        const latest = await one<{when: Date | null}>('SELECT MAX(occurred_at) AS "when" FROM (SELECT occurred_at FROM pairing_contributions WHERE recipient_account_id=$1 UNION ALL SELECT occurred_at FROM pairing_upgrade_contributions WHERE recipient_account_id=$1) events',[uplineId]);
        const latestTime = latest?.when ? new Date(latest.when) : null;
        const outOfOrder = !!latestTime && latestTime.getTime()>eventTime.getTime() &&
          !(await safelyAdvancePairingTime(uplineOwnerId,eventTime,latestTime));
        const recorded = await one<{ source_account_id: number }>(
          `INSERT INTO pairing_contributions(recipient_account_id,source_account_id,source_user_id,leg,source_rank,ab_points,right_points,occurred_at,review_required)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(recipient_account_id,source_account_id) DO NOTHING RETURNING source_account_id`,
          [uplineId,nodeId,origin,leg,rank,pointsToAdd,rPointsToAdd,eventTime,outOfOrder]);
        if (recorded) await exec(`UPDATE accounts SET ${column} = ${column} + $1 WHERE id = $2`, [delta, uplineId]);
        if (recorded && outOfOrder) await exec(`INSERT INTO pairing_review(account_id,reason)
          VALUES($1,'An out-of-order source event requires review before its points can be consumed.') ON CONFLICT(account_id) DO NOTHING`,[uplineId]);
      }
      await evaluatePairs(uplineId, origin, eventTime);
    }
    currentNodeId = uplineId;
  }
}

export async function processPointUpflow(newNodeId: number, originUserId: number, eventTimeOverride?: Date, syncStructure = true): Promise<void> {
  return tx(() => processPointUpflowInternal(newNodeId, originUserId, eventTimeOverride, syncStructure));
}

/** Record the Premium->Star two-point L/C differential as a separate event.
 * Never turn an existing Premium source into a second structural member. */
export async function processUpgradeDifferential(nodeId: number, originUserId: number, eventTime: Date): Promise<void> {
  return tx(async () => {
    const origin = await userById(originUserId);
    if (!origin || !(await freeFlag(origin, 'count'))) return;
    let cursor = Number(nodeId), safety = 0;
    while (cursor > 1 && safety++ < 500) {
      const current = await one<{upline_id:number;position:Position}>('SELECT upline_id,position FROM accounts WHERE id=$1',[cursor]);
      if (!current || Number(current.upline_id) <= 0) break;
      const recipient = Number(current.upline_id);
      const owner = Number((await scalar<number>('SELECT user_id FROM accounts WHERE id=$1',[recipient])) ?? 0);
      const leg = current.position;
      if (owner !== Number(originUserId) && cursor !== Number(nodeId) && (leg === 'L' || leg === 'C')) {
        await one('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[recipient]);
        const base = await one<{leg:Position;review_required:boolean}>(
          'SELECT leg,review_required FROM pairing_contributions WHERE recipient_account_id=$1 AND source_account_id=$2',[recipient,nodeId]);
        const latest = await one<{when:Date|null}>(`SELECT MAX(occurred_at) AS "when" FROM (
          SELECT occurred_at FROM pairing_contributions WHERE recipient_account_id=$1
          UNION ALL SELECT occurred_at FROM pairing_upgrade_contributions WHERE recipient_account_id=$1) events`,[recipient]);
        const later = latest?.when ? new Date(latest.when) : null;
        const outOfOrder = !!later && later.getTime()>eventTime.getTime() && !(await safelyAdvancePairingTime(owner,eventTime,later));
        // Missing/changed base history or an order ambiguity must be reviewed,
        // not silently credited. The aggregate points are still preserved.
        const held = !base || base.leg !== leg || base.review_required || outOfOrder;
        const added = await one<{source_account_id:number}>(`INSERT INTO pairing_upgrade_contributions
          (recipient_account_id,source_account_id,source_user_id,leg,ab_points,occurred_at,review_required)
          VALUES($1,$2,$3,$4,2,$5,$6) ON CONFLICT(recipient_account_id,source_account_id) DO NOTHING RETURNING source_account_id`,
          [recipient,nodeId,originUserId,leg,eventTime,held]);
        if (added) {
          await exec(`UPDATE accounts SET ${leg === 'L' ? 'left_points' : 'center_points'} = ${leg === 'L' ? 'left_points' : 'center_points'} + 2 WHERE id=$1`,[recipient]);
          if (held) await exec(`INSERT INTO pairing_review(account_id,reason) VALUES($1,'Upgrade differential requires review: source history or event ordering is not verifiable.') ON CONFLICT(account_id) DO NOTHING`,[recipient]);
          await evaluatePairs(recipient,originUserId,eventTime);
        }
      }
      cursor=recipient;
    }
  });
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
  return tx(async (client) => {
    // The row lock serializes accrual, payout, point consumption and GC.
    const locked = await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[Number(accountId)]);
    if (!locked.rowCount) return;
    await evaluatePairsLocked(accountId, sourceUserId, eventTimeInput);
  });
}

async function evaluatePairsLocked(accountId: number, sourceUserId = 0, eventTimeInput?: Date): Promise<void> {
  const account = await accountById(Number(accountId));
  if (!account) return; // PHP allows both Mother and Child Accounts to earn pairing.

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

  let eventTime = eventTimeInput ?? new Date();
  const latest = await one<{when: Date | null}>('SELECT MAX(occurred_at) AS "when" FROM (SELECT occurred_at FROM pairing_contributions WHERE recipient_account_id=$1 UNION ALL SELECT occurred_at FROM pairing_upgrade_contributions WHERE recipient_account_id=$1) events',[accountId]);
  const latestTime = latest?.when ? new Date(latest.when) : null;
  if (latestTime && latestTime.getTime()>eventTime.getTime()) {
    if (!(await safelyAdvancePairingTime(userId,eventTime,latestTime))) {
      await exec(`INSERT INTO pairing_review(account_id,reason) VALUES($1,'An earlier event arrived after a later contribution; hold it for review to avoid backdated payouts.') ON CONFLICT(account_id) DO NOTHING`,[accountId]);
      return;
    }
    eventTime = latestTime;
  }
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

  // Contributions recorded before the provenance migration cannot safely be
  // reconstructed from aggregate points or ledger prose. Keep them untouched,
  // flag them, and spend only point units with immutable new source records.
  type Contribution = { source_account_id: number; source_user_id: number; leg: Position; source_rank: string;
    ab_points: number; right_points: number; ab_consumed: number; right_consumed: number; review_required: boolean; occurred_at: Date; event_kind: 'base'|'upgrade' };
  const contributions = await q<Contribution>(
    `SELECT source_account_id,source_user_id,leg,source_rank,ab_points,right_points,ab_consumed,right_consumed,review_required,occurred_at,'base'::text AS event_kind
     FROM pairing_contributions WHERE recipient_account_id=$1
     UNION ALL SELECT source_account_id,source_user_id,leg,'StarPremium',ab_points,0,ab_consumed,0,review_required,occurred_at,'upgrade'::text
     FROM pairing_upgrade_contributions WHERE recipient_account_id=$1
     ORDER BY occurred_at,source_account_id,event_kind`, [accountId]);
  const legRows = (leg: Position) => contributions.filter(x => x.leg === leg && !x.review_required);
  const remainingAb = (x: Contribution) => Number(x.ab_points) - Number(x.ab_consumed);
  const remainingR = (x: Contribution) => Number(x.right_points) - Number(x.right_consumed);
  const sumRemainingAb = (leg: Position) => legRows(leg).reduce((sum,x) => sum+remainingAb(x),0);
  const availableL = sumRemainingAb('L'), availableC = sumRemainingAb('C');
  const availableR = legRows('R').reduce((sum,x) => sum+remainingR(x),0);
  const totalL = contributions.filter(x => x.leg==='L').reduce((sum,x)=>sum+remainingAb(x),0);
  const totalC = contributions.filter(x => x.leg==='C').reduce((sum,x)=>sum+remainingAb(x),0);
  const totalR = contributions.filter(x => x.leg==='R').reduce((sum,x)=>sum+remainingR(x),0);
  const invalid = contributions.some(x => Number(x.ab_consumed)<0 || Number(x.right_consumed)<0 ||
    Number(x.ab_consumed)>Number(x.ab_points) || Number(x.right_consumed)>Number(x.right_points));
  if (invalid || totalL>lPts || totalC>cPts || totalR>rPts) {
    await exec(`INSERT INTO pairing_review(account_id,reason) VALUES($1,'Recorded source points disagree with account totals; preserve balances and investigate.') ON CONFLICT(account_id) DO NOTHING`, [accountId]);
    return;
  }
  if (lPts>totalL || cPts>totalC || rPts>totalR) {
    await exec(`INSERT INTO pairing_review(account_id,reason) VALUES($1,'Legacy pairing points lack immutable source records; held for review while new verified points are processed separately.') ON CONFLICT(account_id) DO NOTHING`, [accountId]);
  }
  const abDoneToday = Number((await scalar<string>(
    `SELECT COUNT(*) FROM ledger WHERE user_id=$1 AND note LIKE '%A+B Pair%' AND note NOT LIKE '%Flush Out%'
     AND created_at >= $2 AND created_at < $3`, [userId,dayStart,dayEnd])) ?? 0);
  const existingAbCount = Number((await scalar<string>(
    `SELECT COUNT(*) FROM ledger WHERE user_id=$1 AND note LIKE '%A+B Pair%' AND note NOT LIKE '%Flush Out%'`, [userId])) ?? 0);
  let abReleasedNow = 0;
  let abFlushedNow = 0;
  while (true) {
    const left = legRows('L').find(x => remainingAb(x)>0);
    const center = legRows('C').find(x => remainingAb(x)>0);
    if (!left || !center) break;
    let ledgerId: number;
    if (abDoneToday + abReleasedNow >= dailyAbLimit) {
      ledgerId = await insertLedger({user_id:userId,amount:0,type:'cash',status:'active',
        note:`Flush Out - A+B Pair exceeded daily limit (${dailyAbLimit}/day)${fromNote} [${account.account_type}]`,created_at:eventTime});
      abFlushedNow++;
    } else {
      const pairNo = existingAbCount + abReleasedNow + 1;
      if (pairNo % gcEvery === 0) {
        ledgerId = await insertLedger({user_id:userId,amount:1,type:'gc',status:'active',
          note:`A+B Pair GC (5th) - Pair #${pairNo} (${nowTime})${fromNote} [${account.account_type}]`,created_at:eventTime});
      } else {
        ledgerId = await insertLedger({user_id:userId,amount:bpAmount,type:'cash',status:'released',
          note:`A+B Pair #${pairNo} Released (P${bpAmount}) (${nowTime})${fromNote} [${account.account_type}]`,created_at:eventTime});
        await addToWallet(userId,bpAmount);
      }
      abReleasedNow++;
    }
    left.ab_consumed++; center.ab_consumed++;
    for (const source of [left,center]) {
      const table = source.event_kind === 'upgrade' ? 'pairing_upgrade_contributions' : 'pairing_contributions';
      await exec(`UPDATE ${table} SET ab_consumed=ab_consumed+1 WHERE recipient_account_id=$1 AND source_account_id=$2`,[accountId,source.source_account_id]);
    }
    await exec(`INSERT INTO pairing_allocations(recipient_account_id,kind,left_source_account_id,center_source_account_id,ledger_ids,occurred_at,left_event_kind,center_event_kind)
      VALUES($1,'AB',$2,$3,$4::jsonb,$5,$6,$7)`,[accountId,left.source_account_id,center.source_account_id,JSON.stringify([ledgerId]),eventTime,left.event_kind,center.event_kind]);
    lPts--; cPts--;
  }
  if (abReleasedNow+abFlushedNow) await exec('UPDATE accounts SET left_points=$1,center_points=$2 WHERE id=$3',[lPts,cPts,accountId]);

  // One source can trigger Tri-Leg only once per recipient, even when a
  // StarPremium source contributes two right-leg points. The source's rank
  // and recipient's rank decide whether that single trigger emits one or two
  // ledger units. Existing allocations remain authoritative, including old
  // duplicate/partially consumed data: never pay that source again.
  const rightSources = legRows('R');
  const prior = await q<{ right_source_account_id: number }>(
    `SELECT DISTINCT right_source_account_id FROM pairing_allocations
     WHERE recipient_account_id=$1 AND kind='TRI' AND right_source_account_id IS NOT NULL`, [accountId]);
  const usedSourceIds = new Set(prior.map(x => Number(x.right_source_account_id)));
  const inconsistent = rightSources.some(x => Number(x.right_consumed)>0 && !usedSourceIds.has(Number(x.source_account_id)));
  if (inconsistent) {
    await exec(`INSERT INTO pairing_review(account_id,reason) VALUES($1,'A right-leg source has consumed points without a Tri-Leg allocation; preserve and investigate.') ON CONFLICT(account_id) DO NOTHING`, [accountId]);
    return;
  }
  if (rightSources.some(x => usedSourceIds.has(Number(x.source_account_id)) && remainingR(x)>0)) {
    await exec(`INSERT INTO pairing_review(account_id,reason) VALUES($1,'Previously allocated right-leg source retains points; prevent a second bonus and review its balance.')
      ON CONFLICT(account_id) DO UPDATE SET reason=CASE WHEN pairing_review.reason LIKE '%Previously allocated right-leg source retains points%' THEN pairing_review.reason ELSE pairing_review.reason || ' Previously allocated right-leg source retains points; prevent a second bonus and review its balance.' END`,[accountId]);
  }
  const unusedSources = rightSources.filter(x => !usedSourceIds.has(Number(x.source_account_id)) && remainingR(x)>0);
  // Upgrade events add points, not structural members.
  const cap = Math.min(legRows('L').filter(x=>x.event_kind==='base').length, legRows('C').filter(x=>x.event_kind==='base').length, rightSources.length);
  let trackedDone = rightSources.filter(x => usedSourceIds.has(Number(x.source_account_id))).length;
  if (unusedSources.length>0 && trackedDone + unusedSources.length > cap) {
    const preBoundary = await scalar<boolean>(`SELECT a.created_at < m.started_at FROM accounts a CROSS JOIN pairing_tracking_meta m WHERE a.id=$1 AND m.id=1`,[accountId]);
    if (preBoundary) await exec(`INSERT INTO pairing_review(account_id,reason)
      VALUES($1,'New right-leg points may rely on legacy A/B structural history; verify before using pre-migration sources.')
      ON CONFLICT(account_id) DO NOTHING`,[accountId]);
  }
  const existingTriUnits = Number((await scalar<string>(`SELECT COUNT(*) FROM ledger WHERE user_id=$1 AND note LIKE '%Tri-Leg Release%'`, [userId])) ?? 0);
  const cDoneToday = Number((await scalar<string>(`SELECT COUNT(*) FROM ledger WHERE user_id=$1 AND note LIKE '%Tri-Leg Release%' AND created_at >= $2 AND created_at < $3`, [userId,dayStart,dayEnd])) ?? 0);
  let unitsInserted = 0, consumedNow = 0;
  while (trackedDone < cap) {
    const right = unusedSources.find(x => !usedSourceIds.has(Number(x.source_account_id)));
    if (!right) break;
    const sourceNameNow = (await userById(Number(right.source_user_id)))?.username ?? '';
    const rFrom = sourceNameNow ? ` (from: @${sourceNameNow})` : '';
    const srcStar = isStarRank(right.source_rank);
    const srcLbl = srcStar ? 'StarPremium Source' : 'Premium Source';
    const maLbl = isStar ? 'StarPremium' : 'Premium';
    const unitCount = isStar && srcStar ? 2 : 1;
    const ledgerIds: number[] = [];
    for (let unitI=1;unitI<=unitCount;unitI++) {
      const unitNo=existingTriUnits+unitsInserted+1;
      const unitNote=unitCount>1 ? ` Unit ${unitI}/${unitCount}` : '';
      let ledgerId: number;
      if (cDoneToday+unitsInserted>=dailyCLimit) {
        ledgerId=await insertLedger({user_id:userId,amount:0,type:'cash',status:'active',
          note:`Flush Out - Tri-Leg Release Pair #${unitNo} exceeded daily limit (${dailyCLimit}/day)${rFrom} [${account.account_type}]`,created_at:eventTime});
      } else if (unitNo % gcEvery===0) {
        ledgerId=await insertLedger({user_id:userId,amount:1,type:'gc',status:'active',
          note:`Tri-Leg Release GC (5th)${rFrom} [${maLbl}${unitNote}; ${srcLbl}] - ${account.account_type} | Pair #${unitNo}`,created_at:eventTime});
      } else {
        ledgerId=await insertLedger({user_id:userId,amount:triPremiumAmt,type:'cash',status:'active',
          note:`Tri-Leg Release Bonus${rFrom} [${maLbl}${unitNote}; ${srcLbl}] - ${account.account_type} | Pair #${unitNo} | P${triPremiumAmt}`,created_at:eventTime});
        await addToWallet(userId,triPremiumAmt);
      }
      ledgerIds.push(ledgerId); unitsInserted++;
    }
    const spentPoints = remainingR(right);
    right.right_consumed += spentPoints;
    await exec(`UPDATE pairing_contributions SET right_consumed=right_consumed+$3 WHERE recipient_account_id=$1 AND source_account_id=$2`,[accountId,right.source_account_id,spentPoints]);
    usedSourceIds.add(Number(right.source_account_id));
    await exec(`INSERT INTO pairing_allocations(recipient_account_id,kind,right_source_account_id,ledger_ids,occurred_at)
      VALUES($1,'TRI',$2,$3::jsonb,$4)`,[accountId,right.source_account_id,JSON.stringify(ledgerIds),eventTime]);
    trackedDone++; consumedNow++; rPts -= spentPoints;
  }
  if (consumedNow) await exec('UPDATE accounts SET right_points=$1,pairing_count=pairing_count+$2 WHERE id=$3',[rPts,consumedNow,accountId]);
}

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


