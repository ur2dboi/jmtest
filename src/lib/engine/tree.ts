import { exec, one, q, scalar } from '../db';
import type { AccountRow, Position, UserRow } from '../types';
import {
  accountById,
  auditLog,
  isAccountDescendant,
  isCA,
  isMA,
  liveDownlineCount,
  maAccountForUser,
  memberDisplayRank,
  primaryAccountForUser,
  setAccountDepth,
  userById,
} from './accounts';
import { evaluatePairsCascade, finalizeNewAccountStructure } from './pairing';
import { rSlotLabel, validateStructurePlacement, getSpilloverPlacement, firstRowsComplete } from './placement';
import { rebuildAllDepths } from './rebuild';

/* =====================================================================
 * GENEALOGY / TREE READ LAYER + ADMIN NETWORK OVERRIDE
 * ===================================================================== */

export interface TreeCell {
  id: number;
  user_id: number;
  username: string;
  name: string;
  type: 'MA' | 'CA';
  position: Position;
  rank: string;
  depth: number;
  level: number;
  points: { L: number; C: number; R: number };
  pairing_count: number;
  status: number;
  held: boolean;
  free: boolean;
  slot: string;
  downline: number;
  registered_at: string;
  children: { L: TreeCell | null; C: TreeCell | null; R: TreeCell | null };
}

interface RawCell {
  id: number;
  user_id: number;
  upline_id: number;
  position: Position;
  account_type: 'MA' | 'CA';
  left_points: number;
  center_points: number;
  right_points: number;
  pairing_count: number;
  depth: number;
  status: number;
  lvl: number;
  username: string;
  display_name: string;
  user_rank: string;
  is_free_account: boolean;
  account_held: boolean;
  registered_at: string;
}

/** Fetch a subtree as flat rows (single query, depth-limited). */
export async function fetchSubtree(rootAccountId: number, levels = 2): Promise<RawCell[]> {
  const root = Number(rootAccountId);
  if (!root) return [];
  const depth = Math.max(0, Math.min(6, Number(levels)));
  return q<RawCell>(
    `WITH RECURSIVE t AS (
       SELECT a.id, a.user_id, a.upline_id, a.position, a.account_type, a.left_points, a.center_points,
              a.right_points, a.pairing_count, a.depth, a.status, a.created_at, 0 AS lvl
       FROM accounts a WHERE a.id = $1
       UNION ALL
       SELECT c.id, c.user_id, c.upline_id, c.position, c.account_type, c.left_points, c.center_points,
              c.right_points, c.pairing_count, c.depth, c.status, c.created_at, t.lvl + 1
       FROM accounts c JOIN t ON c.upline_id = t.id WHERE t.lvl < $2
     )
     SELECT t.id, t.user_id, t.upline_id, t.position, t.account_type, t.left_points, t.center_points,
            t.right_points, t.pairing_count, t.depth, t.status, t.lvl,
            COALESCE(u.username,'') AS username, COALESCE(u.display_name,'') AS display_name,
            COALESCE(u.rank,'Premium') AS user_rank,
            COALESCE(u.is_free_account, FALSE) AS is_free_account,
            COALESCE(u.account_held, FALSE) AS account_held,
            to_char(t.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS registered_at
     FROM t LEFT JOIN users u ON u.id = t.user_id
     ORDER BY t.lvl ASC, t.id ASC`,
    [root, depth],
  );
}

async function toCell(row: RawCell): Promise<TreeCell> {
  const u = { username: row.username, rank: row.user_rank, is_free_account: row.is_free_account } as UserRow;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    username: row.username,
    name: row.display_name || row.username,
    type: isCA(row.account_type) ? 'CA' : 'MA',
    position: row.position,
    rank: memberDisplayRank(u, row.user_rank),
    depth: Number(row.depth),
    level: Number(row.lvl),
    points: {
      L: Number(row.left_points),
      C: Number(row.center_points),
      R: Number(row.right_points),
    },
    pairing_count: Number(row.pairing_count),
    status: Number(row.status),
    held: !!row.account_held,
    free: !!row.is_free_account,
    slot: (await rSlotLabel(Number(row.upline_id), row.position)) || '',
    downline: 0,
    registered_at: row.registered_at,
    children: { L: null, C: null, R: null },
  };
}

/** Build the rendered tree (root + N levels) with per-cell downline counts. */
export async function getTreeCells(rootAccountId: number, levels = 2): Promise<TreeCell | null> {
  const rows = await fetchSubtree(Number(rootAccountId), levels);
  if (!rows.length) return null;
  const cells = new Map<number, TreeCell>();
  for (const r of rows) cells.set(Number(r.id), await toCell(r));

  for (const r of rows) {
    const cell = cells.get(Number(r.id));
    const parent = cells.get(Number(r.upline_id));
    if (cell && parent) parent.children[r.position] = cell;
  }

  const root = cells.get(Number(rows[0].id)) ?? null;
  if (root) {
    for (const cell of cells.values()) {
      cell.downline = await liveDownlineCount(cell.id);
    }
  }
  return root;
}

export async function nodeCell(accountId: number): Promise<TreeCell | null> {
  const row = await one<RawCell>(
    `SELECT a.id, a.user_id, a.upline_id, a.position, a.account_type, a.left_points, a.center_points,
            a.right_points, a.pairing_count, a.depth, a.status, 0 AS lvl,
            COALESCE(u.username,'') AS username, COALESCE(u.display_name,'') AS display_name,
            COALESCE(u.rank,'Premium') AS user_rank,
            COALESCE(u.is_free_account, FALSE) AS is_free_account,
            COALESCE(u.account_held, FALSE) AS account_held,
            to_char(a.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS registered_at
     FROM accounts a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [Number(accountId)],
  );
  if (!row) return null;
  const cell = await toCell(row);
  cell.downline = await liveDownlineCount(cell.id);
  return cell;
}

/** Genealogy view payload for a focused node (drill-down + navigator). */
export async function genealogyView(focusAccountId: number, levels = 2): Promise<{
  focus: TreeCell | null;
  trail: { id: number; username: string; position: Position; type: 'MA' | 'CA' }[];
  rootId: number;
  placement?: { upline_id: number; position: Position; slot: string; spillover: boolean } | null;
  gate?: { complete: boolean; filled: number };
}> {
  const focus = await nodeCell(Number(focusAccountId));
  const trail: { id: number; username: string; position: Position; type: 'MA' | 'CA' }[] = [];
  let current = await accountById(Number(focusAccountId));
  let rootId = Number(focusAccountId);
  let safety = 0;
  while (current && safety++ < 100) {
    rootId = Number(current.id);
    const u = await userById(Number(current.user_id));
    trail.unshift({
      id: Number(current.id),
      username: u?.username ?? `#${current.id}`,
      position: current.position,
      type: isCA(current.account_type) ? 'CA' : 'MA',
    });
    if (!current.upline_id) break;
    current = await accountById(Number(current.upline_id));
  }
  const tree = await getTreeCells(Number(focusAccountId), levels);
  const placement = await getStrictPlacementSafe(Number(focusAccountId));
  const gateComplete = await firstRowsComplete(Number(focusAccountId));
  const filled = Number(
    (await scalar<string>('SELECT COUNT(*) FROM accounts WHERE upline_id = $1', [Number(focusAccountId)])) ?? 0,
  );
  return { focus: tree, trail, rootId, placement, gate: { complete: gateComplete, filled } };
}

async function getStrictPlacementSafe(accountId: number) {
  const { getStrictPlacement } = await import('./placement');
  const p = await getStrictPlacement(Number(accountId));
  if (!p) return null;
  const parent = await accountById(Number(p.upline_id));
  const owner = parent ? await userById(Number(parent.user_id)) : null;
  const sp = await getSpilloverPlacement(Number(accountId));
  return {
    upline_id: Number(p.upline_id),
    position: p.position,
    slot: (await rSlotLabel(Number(p.upline_id), p.position)) || p.position,
    spillover: !!(sp && Number(sp.upline_id) === Number(p.upline_id) && sp.position === p.position),
    upline_username: owner?.username ?? '',
  };
}

/* ------------------------- downline lists ------------------------- */

export interface DownlineRow {
  id: number;
  user_id: number;
  username: string;
  name: string;
  rank: string;
  type: 'MA' | 'CA';
  position: Position;
  depth: number;
  leg: string;
  slot: string;
  registered_at: string;
  wallet: string;
  earnings: number;
  free: boolean;
  held: boolean;
}

export async function downlineList(
  rootAccountId: number,
  opts: { maxDepth?: number; q?: string; leg?: Position | 'ALL'; limit?: number; offset?: number } = {},
): Promise<{ rows: DownlineRow[]; total: number }> {
  const root = Number(rootAccountId);
  const maxDepth = Math.max(1, Math.min(12, Number(opts.maxDepth) || 8));
  const where: string[] = ['t.lvl > 0'];
  const params: unknown[] = [root, maxDepth];
  let i = 3;
  if (opts.leg && opts.leg !== 'ALL') {
    where.push(`t.leg = $${i++}`);
    params.push(opts.leg);
  }
  if (opts.q) {
    where.push(`(u.username ILIKE $${i} OR u.display_name ILIKE $${i})`);
    params.push(`%${opts.q}%`);
    i++;
  }
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const base = `
    WITH RECURSIVE t AS (
      SELECT a.id, a.user_id, a.upline_id, a.position, a.account_type, a.depth, 0 AS lvl,
             ''::text AS leg
      FROM accounts a WHERE a.id = $1
      UNION ALL
      SELECT c.id, c.user_id, c.upline_id, c.position, c.account_type, c.depth, t.lvl + 1,
             CASE WHEN t.lvl = 0 THEN c.position ELSE t.leg END
      FROM accounts c JOIN t ON c.upline_id = t.id WHERE t.lvl < $2
    )`;

  const total = Number(
    (await scalar<string>(
      `${base} SELECT COUNT(*) FROM t LEFT JOIN users u ON u.id = t.user_id WHERE ${where.join(' AND ')}`,
      params,
    )) ?? 0,
  );

  const rows = await q<DownlineRow & { created_at: string }>(
    `${base}
     SELECT t.id, t.user_id, COALESCE(u.username,'') AS username,
            COALESCE(NULLIF(u.display_name,''), u.username) AS name,
            COALESCE(u.rank,'Premium') AS rank,
            CASE WHEN t.account_type = 'CA' THEN 'CA' ELSE 'MA' END AS type,
            t.position, t.depth, t.lvl, t.leg,
            COALESCE(u.wallet_balance,0)::text AS wallet,
            COALESCE(u.is_free_account, FALSE) AS free,
            COALESCE(u.account_held, FALSE) AS held,
            to_char(a.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS registered_at,
            COALESCE(e.total,0)::float8 AS earnings
     FROM t
     JOIN accounts a ON a.id = t.id
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(amount),0) AS total FROM ledger
       WHERE user_id = t.user_id AND amount > 0 AND type = 'cash'
     ) e ON TRUE
     WHERE ${where.join(' AND ')}
     ORDER BY t.lvl ASC, t.id ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset],
  );

  for (const r of rows) {
    r.slot = (await rSlotLabel(Number((await accountById(Number(r.id)))?.upline_id ?? 0), r.position)) || '';
  }
  return { rows, total };
}

/** Member → My Associates: DIRECT / SPILLOVER / SPILLED IN (v9.6.12). */
export async function associatesForUser(userId: number): Promise<{
  direct: DownlineRow[];
  spillover: DownlineRow[];
  spilledIn: DownlineRow[];
  counts: { direct: number; spillover: number; spilledIn: number };
}> {
  const uid = Number(userId);
  const ma = await maAccountForUser(uid);
  const maId = ma ? Number(ma.id) : 0;

  // DIRECT: members whose sponsor is this user.
  const direct = await q<DownlineRow>(
    `SELECT a.id, a.user_id, u.username, COALESCE(NULLIF(u.display_name,''),u.username) AS name,
            u.rank, CASE WHEN a.account_type='CA' THEN 'CA' ELSE 'MA' END AS type,
            a.position, a.depth, '' AS leg, '' AS slot,
            COALESCE(u.wallet_balance,0)::text AS wallet, 0::float8 AS earnings,
            COALESCE(u.is_free_account,FALSE) AS free, COALESCE(u.account_held,FALSE) AS held,
            to_char(a.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS registered_at
     FROM users u JOIN accounts a ON a.user_id = u.id AND a.account_type = 'MA'
     WHERE u.sponsor_id = $1 AND u.id <> $1
     ORDER BY a.id ASC LIMIT 500`,
    [uid],
  );

  // SPILLOVER: this user's downline members whose SPONSOR is someone else
  // (they were placed here by an upline's overflow).
  const spillover = maId
    ? await q<DownlineRow>(
        `WITH RECURSIVE t AS (
           SELECT id, user_id, upline_id, position, account_type, depth, 0 AS lvl FROM accounts WHERE id = $1
           UNION ALL
           SELECT c.id, c.user_id, c.upline_id, c.position, c.account_type, c.depth, t.lvl+1
           FROM accounts c JOIN t ON c.upline_id = t.id WHERE t.lvl < 8
         )
         SELECT t.id, t.user_id, u.username, COALESCE(NULLIF(u.display_name,''),u.username) AS name,
                u.rank, CASE WHEN t.account_type='CA' THEN 'CA' ELSE 'MA' END AS type,
                t.position, t.depth, '' AS leg, '' AS slot,
                COALESCE(u.wallet_balance,0)::text AS wallet, 0::float8 AS earnings,
                COALESCE(u.is_free_account,FALSE) AS free, COALESCE(u.account_held,FALSE) AS held,
                to_char(a.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS registered_at
         FROM t JOIN users u ON u.id = t.user_id JOIN accounts a ON a.id = t.id
         WHERE t.lvl > 0 AND u.sponsor_id <> $2
         ORDER BY t.lvl, t.id LIMIT 500`,
        [maId, uid],
      )
    : [];

  // SPILLED IN: members sponsored by this user but placed under another MA.
  const spilledIn = await q<DownlineRow>(
    `SELECT a.id, a.user_id, u.username, COALESCE(NULLIF(u.display_name,''),u.username) AS name,
            u.rank, CASE WHEN a.account_type='CA' THEN 'CA' ELSE 'MA' END AS type,
            a.position, a.depth, '' AS leg, '' AS slot,
            COALESCE(u.wallet_balance,0)::text AS wallet, 0::float8 AS earnings,
            COALESCE(u.is_free_account,FALSE) AS free, COALESCE(u.account_held,FALSE) AS held,
            to_char(a.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS registered_at
     FROM users u JOIN accounts a ON a.user_id = u.id AND a.account_type = 'MA'
     WHERE u.sponsor_id = $1 AND u.id <> $1
       AND NOT EXISTS (
         WITH RECURSIVE t AS (
           SELECT id, upline_id, 0 AS lvl FROM accounts WHERE id = $2
           UNION ALL
           SELECT c.id, c.upline_id, t.lvl+1 FROM accounts c JOIN t ON c.upline_id = t.id WHERE t.lvl < 8
         ) SELECT 1 FROM t WHERE t.id = a.id
       )
     ORDER BY a.id ASC LIMIT 500`,
    [uid, maId || 0],
  );

  return {
    direct,
    spillover,
    spilledIn,
    counts: { direct: direct.length, spillover: spillover.length, spilledIn: spilledIn.length },
  };
}

/* ---------------------- admin network override ---------------------- */

export async function moveNode(
  accountId: number,
  newUplineId: number,
  newPosition: string,
  actor: { id: number; username: string },
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const acc = await accountById(Number(accountId));
  if (!acc) return { ok: false, error: 'Node not found.' };
  const target = Number(newUplineId);
  const pos = String(newPosition).trim().toUpperCase() as Position;
  if (!['L', 'C', 'R'].includes(pos)) return { ok: false, error: 'Invalid leg position.' };
  if (target === Number(acc.id)) return { ok: false, error: 'A node cannot be placed under itself.' };
  if (await isAccountDescendant(Number(acc.id), target, true)) {
    return { ok: false, error: 'Cannot move a node into its own downline (would detach the subtree).' };
  }

  const targetRow = await accountById(target);
  if (!targetRow) return { ok: false, error: 'Target parent node not found.' };

  // Structure owner = closest MA above the target parent (or the target itself).
  let ownerAccount = targetRow;
  let safety = 0;
  while (!isMA(ownerAccount.account_type) && ownerAccount.upline_id && safety++ < 50) {
    const up = await accountById(Number(ownerAccount.upline_id));
    if (!up) break;
    ownerAccount = up;
  }
  const check = await validateStructurePlacement(Number(ownerAccount.id), target, pos, isCA(acc.account_type) ? 'CA' : 'MA');
  if (!check.ok) return { ok: false, error: check.error };

  const from = `${acc.upline_id}/${acc.position}`;
  await exec('UPDATE accounts SET upline_id = $1, position = $2 WHERE id = $3', [target, pos, Number(acc.id)]);
  await rebuildAllDepths();
  await finalizeNewAccountStructure(Number(acc.id), Number(acc.user_id));
  await evaluatePairsCascade(target, Number(acc.user_id));

  const detail = `Account ${acc.id} moved from ${from} to ${target}/${pos}`;
  await auditLog({
    actorUserId: actor.id,
    actorUsername: actor.username,
    actorRole: 'admin',
    category: 'network',
    action: 'MOVE NODE',
    targetUserId: Number(acc.user_id),
    details: { account: Number(acc.id), from, to: `${target}/${pos}` },
  });
  return { ok: true, detail };
}

/** Open slots under a node, with the rule hint for each leg. */
export async function openSlots(accountId: number): Promise<
  { position: Position; occupied: boolean; occupant?: string; slot: string; hint: string; allowed: boolean }[]
> {
  const id = Number(accountId);
  const rows = await q<{ position: Position; user_id: number }>('SELECT position, user_id FROM accounts WHERE upline_id = $1', [id]);
  const byPos = new Map<Position, number>();
  for (const r of rows) byPos.set(r.position, Number(r.user_id));
  const gateComplete = await firstRowsComplete(id);
  const out: { position: Position; occupied: boolean; occupant?: string; slot: string; hint: string; allowed: boolean }[] = [];
  for (const p of ['L', 'C', 'R'] as Position[]) {
    const occupantId = byPos.get(p);
    const occupant = occupantId ? ((await userById(occupantId))?.username ?? '') : undefined;
    out.push({
      position: p,
      occupied: !!occupantId,
      occupant,
      slot: (await rSlotLabel(id, p)) || p,
      allowed: !occupantId && (gateComplete ? p === 'R' : true),
      hint: occupantId
        ? 'OCCUPIED'
        : gateComplete
          ? p === 'R'
            ? 'SPILLOVER (Right only)'
            : 'LOCKED — Right→Right→Right only'
          : 'REGISTER',
    });
  }
  return out;
}

export { primaryAccountForUser, setAccountDepth };

/* ------------------- slot states for the tree UI ------------------- */

export interface SlotState {
  allowed: boolean;
  hint: 'REGISTER' | 'SPILLOVER' | 'LOCKED_3_9' | 'LOCKED_RIGHT';
  label: string;
}

const EMPTY_LBL: Record<Position, string> = {
  L: 'Left Downline Empty',
  C: 'Center Downline Empty',
  R: 'Right Downline Empty',
};

/**
 * For every empty slot visible in the rendered tree (focus + 2 levels),
 * decide whether the structure owner may register there. Uses the same
 * shared validator as the registration submit path (v9.6.124), so the UI
 * can never offer a slot the engine would reject.
 */
export async function treeSlotStates(
  focusAccountId: number,
  ownerAccountId: number,
): Promise<Record<string, SlotState>> {
  const { validateStructurePlacement, firstRowsComplete } = await import('./placement');
  const rowsComplete = await firstRowsComplete(Number(ownerAccountId));
  const cells = await fetchSubtree(Number(focusAccountId), 2);
  const parents = cells.filter((c) => Number(c.lvl) < 2);
  const occupied = new Set(cells.filter((c) => Number(c.lvl) > 0).map((c) => `${c.upline_id}:${c.position}`));
  const out: Record<string, SlotState> = {};

  for (const parent of parents) {
    for (const pos of ['L', 'C', 'R'] as Position[]) {
      const key = `${parent.id}:${pos}`;
      if (occupied.has(key)) continue;
      const check = await validateStructurePlacement(Number(ownerAccountId), Number(parent.id), pos, 'MA');
      if (check.ok) {
        const spill = rowsComplete && pos === 'R';
        out[key] = { allowed: true, hint: spill ? 'SPILLOVER' : 'REGISTER', label: EMPTY_LBL[pos] };
      } else {
        const rightOnly = /SPILLOVER RULE/i.test(check.error ?? '');
        out[key] = {
          allowed: false,
          hint: rightOnly ? 'LOCKED_RIGHT' : 'LOCKED_3_9',
          label: EMPTY_LBL[pos],
        };
      }
    }
  }
  return out;
}
