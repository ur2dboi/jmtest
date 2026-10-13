import { one, q, scalar } from '../db';
import type { AccountRow, Placement, PlacementCheck, Position } from '../types';
import {
  accountById,
  isAccountDescendant,
  isCA,
  isMA,
  isStarterRank,
  maAccountForUser,
  maxChildDepth,
  resolveParentMaForCa,
  subtreeByDepth,
  userById,
} from './accounts';

/* =====================================================================
 * STRICT PLACEMENT + SPILLOVER ENGINE
 * Port of plugin v9.6.119 / v9.6.124.
 *
 *   MA (owner at ANY depth)
 *   ├── CA1 / Free CA1 → R1 R2 R3   (all open for the owner while filling)
 *   ├── CA2 / Free CA2 → R4 R5 R6
 *   └── MA3 / Free Mother → upline may only use Right→Right→Right
 *
 * Gate = the owner's 3 direct nodes (L/C/R) exist AND every direct CA has
 * its own L/C/R filled (the "3 + 9" rule). Before the gate: no spillover.
 * After the gate: spillover is Right→Right→Right only, from each base.
 * ===================================================================== */

type DirectRows = Partial<Record<Position, AccountRow>>;

async function directChildren(accountId: number): Promise<DirectRows> {
  const rows = await q<AccountRow>(
    `SELECT * FROM accounts WHERE upline_id = $1
     ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
    [Number(accountId)],
  );
  const out: DirectRows = {};
  for (const r of rows) out[r.position] = r;
  return out;
}

async function childPositions(accountId: number): Promise<Position[]> {
  const rows = await q<{ position: Position }>('SELECT position FROM accounts WHERE upline_id = $1', [
    Number(accountId),
  ]);
  return rows.map((r) => r.position);
}

/**
 * mlm_first_rows_complete() — dynamic spillover gate.
 * 1) immediate L/C/R under this account must exist
 * 2) each direct CA must have L/C/R filled (R1–R3 etc.)
 * 3) a direct regular MA (paid MA3 / free mother) needs no kids for the gate
 */
export async function firstRowsComplete(accountId: number): Promise<boolean> {
  const direct = await directChildren(Number(accountId));
  if (!direct.L || !direct.C || !direct.R) return false;
  for (const pos of ['L', 'C', 'R'] as Position[]) {
    const child = direct[pos];
    if (!child) return false;
    if (!isCA(child.account_type)) continue; // regular MA / free mother: no requirement
    const filled = await childPositions(child.id);
    for (const need of ['L', 'C', 'R'] as Position[]) if (!filled.includes(need)) return false;
  }
  return true;
}

/** Spillover bases: direct CA kids, or the direct regular MA node itself. */
export async function getSpilloverBaseParentIds(rootAccountId: number): Promise<number[]> {
  const root = Number(rootAccountId);
  if (!root) return [];
  const rows = await q<AccountRow>(
    `SELECT * FROM accounts WHERE upline_id = $1
     ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
    [root],
  );
  const bases: number[] = [];
  for (const child of rows) {
    if (isCA(child.account_type)) {
      const kids = await q<{ id: number }>(
        `SELECT id FROM accounts WHERE upline_id = $1
         ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
        [child.id],
      );
      for (const k of kids) bases.push(Number(k.id));
    } else {
      bases.push(Number(child.id));
    }
  }
  return Array.from(new Set(bases.filter(Boolean)));
}

/** Bases that are direct regular MA / free mother (Right→Right→Right only). */
export async function getDirectRegularSpilloverBaseIds(rootAccountId: number): Promise<number[]> {
  const rows = await q<AccountRow>(
    `SELECT * FROM accounts WHERE upline_id = $1
     ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
    [Number(rootAccountId)],
  );
  return Array.from(new Set(rows.filter((r) => !isCA(r.account_type)).map((r) => Number(r.id))));
}

/** True when parentId is the base itself or lies on base → R → R → R … */
export async function isRightChainFromBase(baseAccountId: number, parentAccountId: number): Promise<boolean> {
  let current = Number(baseAccountId);
  const target = Number(parentAccountId);
  if (!current || !target) return false;
  let safety = 0;
  while (current && safety++ < 500) {
    if (current === target) return true;
    const next = await scalar<number>(`SELECT id FROM accounts WHERE upline_id = $1 AND position = 'R' LIMIT 1`, [
      current,
    ]);
    current = Number(next ?? 0);
  }
  return false;
}

/** Deepest open R slot along a pure Right chain. */
export async function getRightChainPlacement(startAccountId: number): Promise<Placement | null> {
  let current = Number(startAccountId);
  if (!current) return null;
  let safety = 0;
  while (current && safety++ < 500) {
    const rChild = await scalar<number>(`SELECT id FROM accounts WHERE upline_id = $1 AND position = 'R' LIMIT 1`, [
      current,
    ]);
    if (!rChild) return { upline_id: current, position: 'R' };
    current = Number(rChild);
  }
  return null;
}

export async function getRightChainPlacementFromBases(baseIds: number[]): Promise<Placement | null> {
  for (const base of baseIds.map(Number).filter(Boolean)) {
    const place = await getRightChainPlacement(base);
    if (place && place.position === 'R') return place;
  }
  return null;
}

export async function isPublicRightSpilloverParent(rootAccountId: number, parentAccountId: number): Promise<boolean> {
  const root = Number(rootAccountId);
  const parent = Number(parentAccountId);
  if (!root || !parent || root === parent) return false;
  for (const base of await getSpilloverBaseParentIds(root)) {
    if (await isRightChainFromBase(base, parent)) return true;
  }
  return false;
}

export async function isRegularDirectRightSpilloverParent(
  rootAccountId: number,
  parentAccountId: number,
): Promise<boolean> {
  const root = Number(rootAccountId);
  const parent = Number(parentAccountId);
  if (!root || !parent || root === parent) return false;
  for (const base of await getDirectRegularSpilloverBaseIds(root)) {
    if (await isRightChainFromBase(base, parent)) return true;
  }
  return false;
}

export async function getSpilloverPlacement(rootAccountId: number): Promise<Placement | null> {
  const root = Number(rootAccountId);
  if (!root) return null;
  const place = await getRightChainPlacementFromBases(await getSpilloverBaseParentIds(root));
  if (place && place.position !== 'R') return null; // never return a non-R spillover
  return place;
}

/**
 * MASTER PLACEMENT — mlm_get_strict_placement().
 * Free/paid identical, works at any depth, always relative to the
 * logged-in owner's own account.
 */
export async function getStrictPlacement(rootAccountId: number): Promise<Placement | null> {
  const root = Number(rootAccountId);
  if (!root) return null;

  if (!(await firstRowsComplete(root))) {
    // PHASE A (relative to this root only)
    const direct = await directChildren(root);
    if (!direct.L) return { upline_id: root, position: 'L' };
    if (!direct.C) return { upline_id: root, position: 'C' };
    if (!direct.R) return { upline_id: root, position: 'R' };

    // Fill under direct CA / free CA only (R1–R9)
    for (const leg of ['L', 'C', 'R'] as Position[]) {
      const child = direct[leg];
      if (!child || !isCA(child.account_type)) continue;
      const filled = await childPositions(child.id);
      if (!filled.includes('L')) return { upline_id: child.id, position: 'L' };
      if (!filled.includes('C')) return { upline_id: child.id, position: 'C' };
      if (!filled.includes('R')) return { upline_id: child.id, position: 'R' };
    }
    // Early Right-only path on a direct regular MA / free mother (MA3)
    for (const leg of ['L', 'C', 'R'] as Position[]) {
      const child = direct[leg];
      if (!child || isCA(child.account_type)) continue;
      const place = await getRightChainPlacement(child.id);
      if (place) return place;
    }
    return null;
  }

  // PHASE B: Right→Right→Right only
  return getSpilloverPlacement(root);
}

/** Perfect BFS fill (L > C > R) capped at the trinary Level-3 boundary. */
export async function getKamadaPlacement(rootAccountId: number): Promise<Placement | null> {
  const maxRelDepth = maxChildDepth();
  const queue: { id: number; level: number }[] = [{ id: Number(rootAccountId), level: 0 }];
  while (queue.length) {
    const { id: currentId, level } = queue.shift()!;
    if (level >= maxRelDepth) continue;
    const children = await q<{ id: number; position: Position }>(
      'SELECT id, position FROM accounts WHERE upline_id = $1',
      [currentId],
    );
    const filled = children.map((c) => c.position);
    const byPos: Partial<Record<Position, number>> = {};
    for (const c of children) byPos[c.position] = Number(c.id);
    for (const pos of ['L', 'C', 'R'] as Position[]) {
      if (!filled.includes(pos)) return { upline_id: currentId, position: pos };
    }
    if (level < maxRelDepth) {
      for (const pos of ['L', 'C', 'R'] as Position[]) {
        if (byPos[pos]) queue.push({ id: byPos[pos] as number, level: level + 1 });
      }
    }
  }
  return null; // structure full — never silently double-fill (FIX-7)
}

/* =====================================================================
 * SHARED PLACEMENT VALIDATOR (member registration + admin direct
 * registration + admin network override). Port of v9.6.124.
 * ===================================================================== */
export async function validateStructurePlacement(
  ownerAccountId: number,
  targetUplineId: number,
  position: string,
  newAccountType: 'MA' | 'CA' = 'MA',
): Promise<PlacementCheck> {
  let owner = Number(ownerAccountId);
  const target = Number(targetUplineId);
  const pos = String(position).trim().toUpperCase() as Position;
  const type = isCA(newAccountType) ? 'CA' : 'MA';

  if (!owner || !target || !['L', 'C', 'R'].includes(pos)) {
    return { ok: false, error: 'Invalid placement parameters (owner, upline, or leg).' };
  }

  let ownerRow = await accountById(owner);
  if (!ownerRow) return { ok: false, error: 'Structure owner account not found.' };
  if (isCA(ownerRow.account_type)) {
    const parentMa = await resolveParentMaForCa(ownerRow);
    if (!parentMa) return { ok: false, error: 'Cannot resolve Mother Account for structure owner.' };
    ownerRow = parentMa;
    owner = Number(parentMa.id);
  }

  const targetRow = await accountById(target);
  if (!targetRow) return { ok: false, error: 'Target upline node not found.' };

  const slotTaken = await scalar<number>('SELECT id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1', [
    target,
    pos,
  ]);
  if (slotTaken) return { ok: false, error: `Target slot (${pos}) is already occupied.` };

  // Child Accounts (free or paid) sit only in the owner MA's direct L/C/R.
  if (type === 'CA') {
    if (target !== owner || !isMA(targetRow.account_type)) {
      return {
        ok: false,
        error: 'Child Accounts (free or paid) must be placed under the structure owner Mother Account node (direct L/C/R).',
      };
    }
    return { ok: true };
  }

  const gateComplete = await firstRowsComplete(owner);
  const isOwnerRoot = target === owner;
  const isDirectCaOfOwner = isCA(targetRow.account_type) && Number(targetRow.upline_id) === owner;
  const onPublicRight = await isPublicRightSpilloverParent(owner, target);
  const onRegularMaRight = await isRegularDirectRightSpilloverParent(owner, target);

  if (!isOwnerRoot && !(await isAccountDescendant(owner, target, true))) {
    return {
      ok: false,
      error: "Target node is outside the structure owner downline. Cannot place here without affecting another tree's spillover structure.",
    };
  }

  if (!gateComplete) {
    if (isOwnerRoot) return { ok: true };
    if (isDirectCaOfOwner) return { ok: true };
    if (onRegularMaRight && pos === 'R') return { ok: true };
    if (onRegularMaRight && pos !== 'R') {
      return {
        ok: false,
        error: 'SPILLOVER RULE: Direct regular MA / Free Mother branch allows upline placement on Right only. Left/Center belong to that member.',
      };
    }
    return {
      ok: false,
      error: 'COMPLETE 3+9 FIRST: Before the owner gate is complete, place only under the owner MA (L/C/R) or under direct CA1/CA2/CA3 (R-row). Private L/C of downlines are blocked (free or paid).',
    };
  }

  if (pos !== 'R') {
    return {
      ok: false,
      error: 'SPILLOVER RULE: After the owner gate is complete, only Right→Right→Right is allowed. Left/Center stay locked (free or paid).',
    };
  }
  if (!onPublicRight && !onRegularMaRight) {
    return {
      ok: false,
      error: 'SPILLOVER RULE: Target is not on a public Right→Right→Right chain of this owner. Cannot place here without breaking spillover structure.',
    };
  }
  return { ok: true };
}

/** MA account that owns structure for an admin registration under a user. */
export async function adminStructureOwnerAccountId(uplineUserId: number, targetUplineId = 0): Promise<number> {
  if (Number(uplineUserId) > 0) {
    const ma = await maAccountForUser(Number(uplineUserId));
    if (ma) return Number(ma.id);
  }
  let current = targetUplineId > 0 ? await accountById(targetUplineId) : null;
  let safety = 0;
  while (current && safety++ < 100) {
    if (isMA(current.account_type)) return Number(current.id);
    if (!current.upline_id) break;
    current = await accountById(current.upline_id);
  }
  return 0;
}

/* ---------- 9-row / column reporting helpers ---------- */

export interface ColumnPair {
  column: Position;
  a: string;
  b: string;
  a_units: number;
  b_units: number;
  units: number;
}

/** Completed aligned columns in the owner's 9-row (v9.6.11). */
export async function completedSecondRowColumns(accountId: number): Promise<{
  completed: number;
  filled: number;
  columns: Position[];
}> {
  const direct = await directChildren(Number(accountId));
  if (!direct.L || !direct.C || !direct.R) return { completed: 0, filled: 0, columns: [] };
  let completed = 0;
  let filled = 0;
  const columns: Position[] = [];
  for (const col of ['L', 'C', 'R'] as Position[]) {
    let ok = true;
    for (const leg of ['L', 'C', 'R'] as Position[]) {
      const parent = direct[leg]!;
      const exists = Number(
        (await scalar<string>('SELECT COUNT(*) FROM accounts WHERE upline_id = $1 AND position = $2', [
          parent.id,
          col,
        ])) ?? 0,
      );
      if (exists > 0) filled++;
      else ok = false;
    }
    if (ok) {
      completed++;
      columns.push(col);
    }
  }
  return { completed, filled, columns };
}

/** Aligned A+B columns of the first 9-row (v9.6.12). */
export async function secondRowAbColumns(accountId: number): Promise<{
  completed: number;
  filled: number;
  pairs: ColumnPair[];
}> {
  const out = { completed: 0, filled: 0, pairs: [] as ColumnPair[] };
  const direct = await directChildren(Number(accountId));
  if (!direct.L || !direct.C || !direct.R) return out;

  for (const col of ['L', 'C', 'R'] as Position[]) {
    const a = await one<{ id: number; user_id: number }>(
      'SELECT id, user_id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1',
      [direct.L.id, col],
    );
    const b = await one<{ id: number; user_id: number }>(
      'SELECT id, user_id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1',
      [direct.C.id, col],
    );
    if (a) out.filled++;
    if (b) out.filled++;
    if (a && b) {
      const [aUser, bUser] = await Promise.all([userById(a.user_id), userById(b.user_id)]);
      const aUnits = aUser && !isStarterRank(aUser.rank) && aUser.rank.toLowerCase().includes('starpremium') ? 3 : 1;
      const bUnits = bUser && !isStarterRank(bUser.rank) && bUser.rank.toLowerCase().includes('starpremium') ? 3 : 1;
      out.completed += Math.min(aUnits, bUnits);
      out.pairs.push({
        column: col,
        a: aUser?.username ?? '',
        b: bUser?.username ?? '',
        a_units: aUnits,
        b_units: bUnits,
        units: Math.min(aUnits, bUnits),
      });
    }
  }
  return out;
}

/** R1–R9 label for a slot under a CA (CA1-L=R1 … CA3-R=R9). */
export async function rSlotLabel(parentAccountId: number, position: string): Promise<string> {
  const pos = String(position).trim().toUpperCase() as Position;
  if (!parentAccountId || !['L', 'C', 'R'].includes(pos)) return '';
  const parent = await accountById(Number(parentAccountId));
  if (!parent || !isCA(parent.account_type)) return '';
  const caIndex: Record<string, number> = { L: 0, C: 1, R: 2 };
  let caIndexNum = caIndex[String(parent.position).toUpperCase()];
  if (caIndexNum === undefined) {
    const siblings = await q<{ id: number }>(
      `SELECT id FROM accounts WHERE upline_id = $1 AND account_type = 'CA'
       ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
      [parent.upline_id],
    );
    caIndexNum = Math.max(
      0,
      siblings.findIndex((s) => Number(s.id) === Number(parentAccountId)),
    );
  }
  const slotIndex: Record<string, number> = { L: 1, C: 2, R: 3 };
  const rNum = caIndexNum * 3 + slotIndex[pos];
  if (rNum < 1 || rNum > 9) return '';
  return `R${rNum}`;
}

/** Qualifying (non-Starter) downline count under a leg, excluding the leg root. */
export async function legQualifyingDownlineCount(accountId: number, leg: Position): Promise<number> {
  const directId = await scalar<number>('SELECT id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1', [
    Number(accountId),
    leg,
  ]);
  if (!directId) return 0;
  const levels = await subtreeByDepth(Number(directId), 50);
  const ids: number[] = [];
  for (const [depth, atDepth] of Object.entries(levels)) {
    if (Number(depth) === 0) continue; // the leg root itself never counts
    ids.push(...atDepth);
  }
  if (!ids.length) return 0;
  const rows = await q<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ANY($1::bigint[])', [ids]);
  let count = 0;
  for (const r of rows) {
    const u = await userById(Number(r.user_id));
    if (!u) continue;
    if (!isStarterRank(u.rank || 'Premium')) count++;
  }
  return count;
}

/** Display-only network metric: counts every visible node under a leg. */
export async function legMetricDownlineCount(accountId: number, leg: Position): Promise<number> {
  const directId = await scalar<number>('SELECT id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1', [
    Number(accountId),
    leg,
  ]);
  if (!directId) return 0;
  const levels = await subtreeByDepth(Number(directId), 50);
  const ids: number[] = Object.values(levels).flat();
  if (!ids.length) return 0;
  const rows = await q<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ANY($1::bigint[])', [ids]);
  let count = 0;
  for (const r of rows) {
    const u = await userById(Number(r.user_id));
    if (!u) continue;
    if (!isStarterRank(u.rank || 'Premium')) count++;
  }
  return count;
}

export async function triLegStructuralCap(accountId: number): Promise<number> {
  return Math.min(
    await legQualifyingDownlineCount(accountId, 'L'),
    await legQualifyingDownlineCount(accountId, 'C'),
    await legQualifyingDownlineCount(accountId, 'R'),
  );
}

/** Aligned CA matrix applies once an account has a complete direct L/C/R row. */
export async function useAlignedCaRules(accountId: number): Promise<boolean> {
  const n = Number(
    (await scalar<string>(
      `SELECT COUNT(DISTINCT position) FROM accounts WHERE upline_id = $1 AND position IN ('L','C','R')`,
      [Number(accountId)],
    )) ?? 0,
  );
  return n >= 3;
}

/** Second-row node ids (the 9-row) for a root account. */
export async function getSecondRowNodeIds(rootAccountId: number): Promise<number[]> {
  const direct = await directChildren(Number(rootAccountId));
  const row2: number[] = [];
  for (const leg of ['L', 'C', 'R'] as Position[]) {
    const parent = direct[leg];
    if (!parent) continue;
    for (const col of ['L', 'C', 'R'] as Position[]) {
      const id = await scalar<number>('SELECT id FROM accounts WHERE upline_id = $1 AND position = $2 LIMIT 1', [
        parent.id,
        col,
      ]);
      if (id) row2.push(Number(id));
    }
  }
  return row2;
}
