import { exec, one, q, scalar } from '../db';
import { phMonthKey } from '../time';
import type { AccountRow, UserRow } from '../types';
import {
  addToWallet,
  auditLog,
  freeCanCountForUplinePairing,
  getUserRankAt,
  isStarterRank,
  resyncAllWallets,
  setAccountDepth,
  unilevelMonthlyResetOn,
  userById,
} from './accounts';
import { payDirectReferral, processPointUpflow } from './pairing';
import { processUnilevelCommission, releaseMaturedUnilevelCommissions } from './unilevel';

/* =====================================================================
 * FULL + BATCH EARNINGS REBUILD
 * mlm_rebuild_earnings_from_tree() / mlm_admin_batch_rebuild_*
 *
 * Replays the compensation plan from persisted structure + used pins:
 *   Step 1  reset counters / points / wallets
 *   Step 2  Direct Referral bonuses (package pins only)
 *   Step 3  A+B and Tri-Leg replay in node creation order
 *   Step 4  Unilevel commissions from used product pins
 *   Step 5  wallet resync + monthly LP recompute
 *
 * The batch variant runs in fixed-size slices so it survives serverless
 * timeouts; progress lives in the `rebuild_state` table.
 * ===================================================================== */

export interface RebuildRow {
  batch_id: number;
  step: number;
  offset: number;
  total: number;
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  updated_at: string;
}

export async function getRebuildState(): Promise<RebuildRow> {
  const row = await one<RebuildRow>(
    `SELECT batch_id, step, row_offset AS "offset", total, status, message,
            to_char(updated_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI:SS') AS updated_at
     FROM rebuild_state WHERE id = 1`,
  );
  if (row) return row;
  await exec(`INSERT INTO rebuild_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  return getRebuildState();
}

async function setRebuildState(patch: Partial<RebuildRow>): Promise<void> {
  // TS field -> column mapping (`offset` is reserved-ish, stored as row_offset)
  const allowed: Record<string, string> = {
    step: 'step',
    offset: 'row_offset',
    total: 'total',
    status: 'status',
    message: 'message',
  };
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, col] of Object.entries(allowed)) {
    if (k in patch) {
      fields.push(`${col} = $${i++}`);
      values.push((patch as Record<string, unknown>)[k]);
    }
  }
  fields.push(`updated_at = now()`);
  await exec(`UPDATE rebuild_state SET ${fields.join(', ')} WHERE id = 1`, values);
}

/* ------------------------------------------------------------------ */
/* Step 1 — reset                                                      */
/* ------------------------------------------------------------------ */
export async function rebuildStep1Reset(): Promise<string> {
  await exec(`
    UPDATE accounts SET left_points = 0, center_points = 0, right_points = 0,
                        pairing_count = 0, depth = 0
  `);
  await exec(`
    DELETE FROM ledger
    WHERE note LIKE '%A+B Pair%' OR note LIKE '%Tri-Leg Release%'
       OR note LIKE '%Direct Referral Bonus%' OR note LIKE '%Unilevel Comm%'
  `);
  await exec(`UPDATE users SET lifetime_dr_paid = 0, lp = 0, monthly_lp = 0, wallet_balance = 0`);
  await rebuildAllDepths();
  // LP is eligibility input for Step 4, so recompute it here.
  await recomputeMonthlyLp();
  return 'Step 1 Complete: Earnings wiped, structure re-synced.';
}

/** Recompute every account depth with a single recursive CTE. */
export async function rebuildAllDepths(): Promise<void> {
  await exec(`
    WITH RECURSIVE t AS (
      SELECT id, upline_id, 0 AS depth FROM accounts WHERE upline_id IS NULL OR upline_id = 0
      UNION ALL
      SELECT a.id, a.upline_id, LEAST(t.depth + 1, 8) FROM accounts a JOIN t ON t.id = a.upline_id
    )
    UPDATE accounts a SET depth = t.depth FROM t WHERE a.id = t.id
  `);
}

/* ------------------------------------------------------------------ */
/* Step 2 — Direct Referral bonuses                                    */
/* ------------------------------------------------------------------ */
export async function rebuildStep2Dr(offset = 0, limit = 100): Promise<{ done: boolean; processed: number; msg: string }> {
  const rows = await q<{
    id: number;
    used_by: number;
    created_at: Date;
    package_type: string;
    sponsor_id: number;
  }>(
    `SELECT p.id, p.used_by, p.created_at, p.package_type, u.sponsor_id
     FROM pins p JOIN users u ON u.id = p.used_by AND u.sponsor_id > 0
     WHERE p.status = 'used' AND p.is_product = 0
     ORDER BY p.created_at ASC, p.id ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  for (const r of rows) {
    const usedBy = Number(r.used_by);
    if (usedBy <= 0) continue;
    const exists = await scalar<number>(
      `SELECT COUNT(*) FROM ledger WHERE user_id = $1 AND note LIKE $2`,
      [Number(r.sponsor_id), `%Direct Referral Bonus (PIN #${r.id})%`],
    );
    if (Number(exists) > 0) continue;

    const placed = await userById(usedBy);
    if (!placed) continue;
    const dr = await payDirectReferral(
      Number(r.sponsor_id),
      placed.username,
      r.package_type || placed.rank || 'Premium',
      ` (PIN #${r.id})`,
      usedBy,
      new Date(r.created_at),
    );
    if (dr > 0) {
      await exec('UPDATE users SET lifetime_dr_paid = lifetime_dr_paid + $1 WHERE id = $2', [
        dr,
        Number(r.sponsor_id),
      ]);
    }
  }

  const done = rows.length < limit;
  return {
    done,
    processed: rows.length,
    msg: done ? 'Step 2 Complete: Direct Referral bonuses rebuilt.' : `Step 2 Running: processed offset ${offset + rows.length}…`,
  };
}

/* ------------------------------------------------------------------ */
/* Step 3 — pairing replay (chronological)                             */
/* ------------------------------------------------------------------ */
export async function rebuildStep3Pairing(
  offset = 0,
  limit = 100,
): Promise<{ done: boolean; processed: number; msg: string }> {
  const rows = await q<AccountRow>(
    `SELECT * FROM accounts WHERE id > 1 ORDER BY id ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  for (const acc of rows) {
    const accId = Number(acc.id);
    const owner = await userById(Number(acc.user_id));
    if (!owner) continue;
    // Only accounts that count for upline pairing contribute points.
    if (!(await freeCanCountForUplinePairing(owner))) continue;
    const rank = await getUserRankAt(Number(acc.user_id), new Date(acc.created_at));
    if (isStarterRank(rank)) continue;
    await processPointUpflow(accId, Number(acc.user_id), new Date(acc.created_at), false);
  }

  const done = rows.length < limit;
  return {
    done,
    processed: rows.length,
    msg: done ? 'Step 3 Complete: A+B and Tri-Leg earnings rebuilt.' : `Step 3 Running: processed offset ${offset + rows.length}…`,
  };
}

/* ------------------------------------------------------------------ */
/* Step 4 — unilevel replay                                            */
/* ------------------------------------------------------------------ */
export async function rebuildStep4Unilevel(
  offset = 0,
  limit = 100,
): Promise<{ done: boolean; processed: number; msg: string }> {
  if (offset === 0) {
    // Remove existing unilevel rows in the active scope, then replay from pins.
    const periodScoped = unilevelMonthlyResetOn();
    if (periodScoped) {
      await exec(
        `DELETE FROM ledger WHERE (note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%')
           AND to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $1`,
        [phMonthKey()],
      );
    } else {
      await exec(`DELETE FROM ledger WHERE note LIKE '%Unilevel Comm%' OR note LIKE '%Product Comm%'`);
    }
  }

  const rows = await q<{ activator_id: number; qty: string; event_date: string; kind: string }>(
    `SELECT COALESCE(used_by, purchaser_id) AS activator_id,
            to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS event_date,
            CASE WHEN pin_code LIKE 'UNI-%' THEN 'UNI' WHEN pin_code LIKE 'PCC-%' THEN 'PCC' ELSE '' END AS kind,
            COUNT(*)::text AS qty
     FROM pins
     WHERE is_product = 1 AND status = 'used'
     GROUP BY activator_id, event_date, kind
     ORDER BY event_date ASC, activator_id ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  for (const r of rows) {
    await processUnilevelCommission(Number(r.activator_id), Number(r.qty), `${r.event_date}T00:00:00+08:00`, r.kind === 'UNI' || r.kind === 'PCC' ? r.kind : null);
  }

  const done = rows.length < limit;
  return {
    done,
    processed: rows.length,
    msg: done ? 'Step 4 Complete: Unilevel commissions rebuilt.' : `Step 4 Running: processed offset ${offset + rows.length}…`,
  };
}

/* ------------------------------------------------------------------ */
/* Step 5 — wallets + LP                                               */
/* ------------------------------------------------------------------ */
export async function rebuildStep5Wallets(offset = 0, limit = 200): Promise<{ done: boolean; processed: number; msg: string }> {
  if (offset === 0) {
    await releaseMaturedUnilevelCommissions();
  }
  const rows = await q<{ id: number }>(
    `SELECT id FROM users WHERE id > 1 ORDER BY id ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  for (const r of rows) {
    const id = Number(r.id);
    const cash = Number(
      (await scalar<string>(
        `SELECT COALESCE(SUM(amount),0)::text FROM ledger
         WHERE user_id = $1 AND amount > 0 AND type = 'cash'
           AND (status = 'released' OR (status = 'active' AND note NOT LIKE '%Encashment%'))`,
        [id],
      )) ?? 0,
    );
    const debit = Number(
      (await scalar<string>(
        `SELECT COALESCE(SUM(ABS(amount)),0)::text FROM ledger WHERE user_id = $1 AND amount < 0`,
        [id],
      )) ?? 0,
    );
    await exec('UPDATE users SET wallet_balance = $1 WHERE id = $2', [cash - debit, id]);
  }
  const done = rows.length < limit;
  return {
    done,
    processed: rows.length,
    msg: done ? 'Step 5 Complete: Wallets and LP rebuilt.' : `Step 5 Running: processed offset ${offset + rows.length}…`,
  };
}

/** Recompute lifetime + monthly LP from used product pins. */
export async function recomputeMonthlyLp(): Promise<void> {
  await exec(`UPDATE users SET lp = 0, monthly_lp = 0`);
  const rows = await q<{ uid: number; total: string }>(
    `SELECT COALESCE(used_by, purchaser_id) AS uid, COUNT(*)::text AS total
     FROM pins WHERE is_product = 1 AND status = 'used'
     GROUP BY uid`,
  );
  for (const r of rows) {
    await exec('UPDATE users SET lp = $1 WHERE id = $2', [Number(r.total), Number(r.uid)]);
  }
  const monthly = await q<{ uid: number; total: string }>(
    `SELECT COALESCE(used_by, purchaser_id) AS uid, COUNT(*)::text AS total
     FROM pins WHERE is_product = 1 AND status = 'used'
       AND to_char(COALESCE(used_at, created_at) AT TIME ZONE 'Asia/Manila', 'YYYY-MM') = $1
     GROUP BY uid`,
    [phMonthKey()],
  );
  for (const r of monthly) {
    await exec('UPDATE users SET monthly_lp = $1 WHERE id = $2', [Number(r.total), Number(r.uid)]);
  }
}

/* ------------------------------------------------------------------ */
/* One-shot full rebuild (small networks / local dev)                  */
/* ------------------------------------------------------------------ */
export async function fullRebuild(opts: { skipPairing?: boolean; actor?: { id: number; username: string } } = {}): Promise<string> {
  await rebuildStep1Reset();
  await rebuildStep2Dr(0, 100000);
  if (!opts.skipPairing) await rebuildStep3Pairing(0, 100000);
  await rebuildStep4Unilevel(0, 100000);
  await rebuildStep5Wallets(0, 100000);
  const msg = opts.skipPairing
    ? 'Full rebuild complete (pairing skipped).'
    : 'Full rebuild complete.';
  if (opts.actor) {
    await auditLog({
      actorUserId: opts.actor.id,
      actorUsername: opts.actor.username,
      actorRole: 'admin',
      category: 'system',
      action: 'FULL REBUILD',
      details: msg,
    });
  }
  return msg;
}

/* ------------------------------------------------------------------ */
/* Batch driver (used by the admin panel)                              */
/* ------------------------------------------------------------------ */
export async function initBatchRebuild(actor?: { id: number; username: string }): Promise<RebuildRow> {
  const total = Number((await scalar<string>('SELECT COUNT(*) FROM accounts WHERE id > 1')) ?? 0);
  await setRebuildState({ status: 'running', step: 1, offset: 0, total, message: 'Batch rebuild started.' });
  if (actor) {
    await auditLog({
      actorUserId: actor.id,
      actorUsername: actor.username,
      actorRole: 'admin',
      category: 'system',
      action: 'BATCH REBUILD START',
      details: { accounts: total },
    });
  }
  return getRebuildState();
}

export async function runBatchStep(batchId: number): Promise<RebuildRow> {
  const state = await getRebuildState();
  if (state.status === 'done') return state;
  if (Number(state.batch_id) !== Number(batchId) && Number(batchId) !== 1) {
    await setRebuildState({ status: 'error', message: 'Batch ID mismatch — restart the rebuild.' });
    return getRebuildState();
  }

  const limit = 100;
  try {
    if (state.step === 1) {
      const msg = await rebuildStep1Reset();
      await setRebuildState({ step: 2, offset: 0, message: msg });
    } else if (state.step === 2) {
      const r = await rebuildStep2Dr(state.offset, limit);
      if (r.done) await setRebuildState({ step: 3, offset: 0, message: r.msg });
      else await setRebuildState({ offset: state.offset + r.processed, message: r.msg });
    } else if (state.step === 3) {
      const r = await rebuildStep3Pairing(state.offset, limit);
      if (r.done) await setRebuildState({ step: 4, offset: 0, message: r.msg });
      else await setRebuildState({ offset: state.offset + r.processed, message: r.msg });
    } else if (state.step === 4) {
      const r = await rebuildStep4Unilevel(state.offset, limit);
      if (r.done) await setRebuildState({ step: 5, offset: 0, message: r.msg });
      else await setRebuildState({ offset: state.offset + r.processed, message: r.msg });
    } else if (state.step === 5) {
      const r = await rebuildStep5Wallets(state.offset, limit);
      if (r.done) {
        await resyncAllWallets();
        await setRebuildState({ step: 6, offset: 0, status: 'done', message: r.msg });
      } else {
        await setRebuildState({ offset: state.offset + r.processed, message: r.msg });
      }
    } else {
      await setRebuildState({ status: 'done', step: 6, message: 'Batch rebuild complete.' });
    }
  } catch (err) {
    await setRebuildState({ status: 'error', message: String((err as Error).message || err).slice(0, 500) });
  }
  return getRebuildState();
}

/* ------------------------------------------------------------------ */
/* Danger-zone maintenance                                             */
/* ------------------------------------------------------------------ */

/** Wipe points that have no matching active account (ghost points). */
export async function wipeGhostPoints(): Promise<number> {
  const before = await q<{ id: number }>(
    `SELECT id FROM accounts WHERE id > 1 AND (left_points > 0 OR center_points > 0 OR right_points > 0)`,
  );
  let wiped = 0;
  for (const a of before) {
    const owner = await one<{ user_id: number; status: number }>(
      'SELECT user_id, status FROM accounts WHERE id = $1',
      [Number(a.id)],
    );
    if (!owner) continue;
    const u = await userById(Number(owner.user_id));
    const rank = await getUserRankAt(Number(owner.user_id));
    if (!u || Number(owner.status) !== 1 || isStarterRank(rank)) {
      await exec('UPDATE accounts SET left_points=0, center_points=0, right_points=0, pairing_count=0 WHERE id = $1', [
        Number(a.id),
      ]);
      wiped++;
    }
  }
  return wiped;
}

/** Total financial wipe: ledger, points, wallets — structure stays. */
export async function totalFinancialWipe(actor?: { id: number; username: string }): Promise<string> {
  await exec('DELETE FROM ledger');
  await exec('UPDATE accounts SET left_points=0, center_points=0, right_points=0, pairing_count=0');
  await exec('UPDATE users SET wallet_balance=0, lifetime_dr_paid=0, lp=0, monthly_lp=0');
  await exec(`UPDATE pins SET status='unused', used_by=NULL, used_at=NULL, activation_source=NULL, activated_by_user_id=NULL`);
  const msg = 'Total financial wipe complete. Structure preserved.';
  if (actor) {
    await auditLog({
      actorUserId: actor.id,
      actorUsername: actor.username,
      actorRole: 'admin',
      category: 'danger',
      action: 'FINANCIAL WIPE',
      details: msg,
    });
  }
  return msg;
}

/** Re-evaluate pairing for a single account (admin repair tool). */
export async function repairAccountEarnings(accountId: number): Promise<string> {
  const acc = await one<AccountRow>('SELECT * FROM accounts WHERE id = $1', [Number(accountId)]);
  if (!acc) return 'Account not found.';
  await setAccountDepth(Number(acc.id));
  const { evaluatePairsCascade } = await import('./pairing');
  await evaluatePairsCascade(Number(acc.id), Number(acc.user_id));
  const owner = await userById(Number(acc.user_id));
  if (owner) {
    await resyncAllWallets();
  }
  return `Earnings re-evaluated for account ${acc.id}.`;
}
