import { exec, one, q, scalar } from '../db';
import type { AccountRow, PinRow, Position, UserRow } from '../types';
import { hashPassword, validAlnumPassword } from '../auth';
import { phFormat } from '../time';
import {
  accountById,
  addRankHistory,
  auditLog,
  freeCanPayDirectReferral,
  generateMemberIdNumber,
  getUserRankAt,
  isCA,
  isFreeAccountUser,
  isMA,
  isStarterRank,
  maAccountForUser,
  memberDisplayRank,
  primaryAccountForUser,
  setAccountDepth,
  setAccountRankSnapshot,
  syncFreeAccountKindMeta,
  userById,
} from './accounts';
import { calcDrBonus, finalizeNewAccountStructure, insertLedger, payDirectReferral, processPointUpflow } from './pairing';
import {
  getStrictPlacement,
  rSlotLabel,
  validateStructurePlacement,
  getSpilloverPlacement,
  firstRowsComplete,
} from './placement';
import { addToWallet } from './accounts';

/* =====================================================================
 * REGISTRATION / CA ACTIVATION / RANK UPGRADE / ORDERS
 * The single write-path used by the member portal, the admin command
 * center and the seeder, so placement + earnings always stay consistent.
 * ===================================================================== */

export const RANK_ORDER = ['Starter', 'Premium', 'StarPremium'] as const;

export function rankFromPackage(pkgName: string): string {
  const p = String(pkgName ?? '').replace(/\s+/g, '').toLowerCase();
  // Order matters: "starter" contains "star", so test it first.
  if (p.includes('starter')) return 'Starter';
  if (p.includes('starpremium') || p.includes('star')) return 'StarPremium';
  if (p.includes('premium')) return 'Premium';
  return 'Premium';
}

export function rankIndex(rank: string): number {
  const r = String(rank ?? '').replace(/\s+/g, '').toLowerCase();
  if (r.includes('starpremium')) return 2;
  if (r.includes('starter')) return 0;
  return 1;
}

/* ---------------------------- pins ---------------------------- */

export async function findPinByCode(code: string): Promise<PinRow | null> {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;
  return one<PinRow>('SELECT * FROM pins WHERE UPPER(pin_code) = $1 LIMIT 1', [c]);
}

export interface PinCheck {
  ok: boolean;
  pin?: PinRow;
  error?: string;
}

export async function validatePin(
  code: string,
  opts: { expectProduct?: boolean; rank?: string } = {},
): Promise<PinCheck> {
  const pin = await findPinByCode(code);
  if (!pin) return { ok: false, error: `Activation code "${code}" was not found.` };
  if (pin.status !== 'unused') return { ok: false, error: `Activation code "${pin.pin_code}" is already ${pin.status}.` };
  if (opts.expectProduct && Number(pin.is_product) !== 1) {
    return { ok: false, error: `"${pin.pin_code}" is a package code, not a product code.` };
  }
  if (!opts.expectProduct && Number(pin.is_product) === 1) {
    return { ok: false, error: `"${pin.pin_code}" is a product code, not a registration package code.` };
  }
  if (opts.rank && pin.package_type && rankFromPackage(pin.package_type) !== rankFromPackage(opts.rank)) {
    return {
      ok: false,
      error: `Code "${pin.pin_code}" is for the ${pin.package_type} package (selected: ${opts.rank}).`,
    };
  }
  return { ok: true, pin };
}

export async function consumePin(
  pinId: number,
  usedByUserId: number,
  source: 'member' | 'admin' = 'member',
  actorId = 0,
  isProduct = false,
): Promise<boolean> {
  const affected = await exec(
    `UPDATE pins SET status = 'used', used_by = $1, used_at = now(),
        activation_source = $2, activated_by_user_id = NULLIF($3,0)
     WHERE id = $4 AND status = 'unused'`,
    [Number(usedByUserId), source, Number(actorId), Number(pinId)],
  );
  if (affected > 0 && isProduct) await exec(`UPDATE pins SET is_product = 1 WHERE id = $1`, [Number(pinId)]);
  return affected > 0;
}

export async function generatePins(opts: {
  packageType: string;
  count: number;
  isProduct?: boolean;
  purchaserId?: number;
  actor?: { id: number; username: string };
}): Promise<{ codes: string[]; count: number }> {
  const count = Math.max(1, Math.min(5000, Number(opts.count) || 1));
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    let tries = 0;
    do {
      code = `MJP-${Math.random().toString(36).slice(2, 8).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      tries++;
    } while (tries < 8 && Number((await scalar<number>('SELECT COUNT(*) FROM pins WHERE pin_code = $1', [code])) ?? 0) > 0);
    await exec(
      `INSERT INTO pins (pin_code, package_type, is_product, purchaser_id, status)
       VALUES ($1,$2,$3,$4,'unused') ON CONFLICT (pin_code) DO NOTHING`,
      [code, opts.packageType, opts.isProduct ? 1 : 0, Number(opts.purchaserId ?? 0)],
    );
    codes.push(code);
  }
  if (opts.actor) {
    await auditLog({
      actorUserId: opts.actor.id,
      actorUsername: opts.actor.username,
      actorRole: 'admin',
      category: 'pins',
      action: 'GENERATE PINS',
      details: { package: opts.packageType, count: codes.length, product: !!opts.isProduct },
    });
  }
  return { codes, count: codes.length };
}

/* ------------------------- registration ------------------------- */

export interface RegisterInput {
  username: string;
  password: string;
  sponsorUsername: string;
  packageName?: string;
  pinCode?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  gender?: string;
  bday?: string;
  address?: string;
  /** structure owner for placement; defaults to the sponsor's MA */
  uplineUsername?: string;
  /** explicit structure-owner account id (member tree click / admin override) */
  structureOwnerAccountId?: number;
  /** explicit slot (admin network placement); otherwise auto strict placement */
  uplineAccountId?: number;
  position?: Position;
  accountType?: 'MA' | 'CA';
  isFreeAccount?: boolean;
  freeDisplayRank?: string;
  freeReceivePairing?: boolean;
  freeCountForUplinePairing?: boolean;
  freePayDirectReferral?: boolean;
  actor?: { id: number; username: string; role: 'member' | 'admin' };
  eventTime?: Date;
}

export interface RegisterResult {
  ok: boolean;
  error?: string;
  userId?: number;
  accountId?: number;
  username?: string;
  rank?: string;
  uplineUsername?: string;
  position?: Position;
  slotLabel?: string;
  spillover?: boolean;
  drBonus?: number;
  placementNote?: string;
}

export async function registerMember(input: RegisterInput): Promise<RegisterResult> {
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const when = input.eventTime ?? new Date();

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return { ok: false, error: 'Username must be 3–32 characters (letters, numbers, dot, dash, underscore).' };
  }
  if (!validAlnumPassword(password)) {
    return { ok: false, error: 'Password must be at least 6 characters and contain no spaces.' };
  }
  if (Number((await scalar<number>('SELECT COUNT(*) FROM users WHERE LOWER(username) = LOWER($1)', [username])) ?? 0) > 0) {
    return { ok: false, error: `Username "${username}" is already taken.` };
  }

  const sponsor = await one<UserRow>('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [
    String(input.sponsorUsername ?? '').trim(),
  ]);
  if (!sponsor) return { ok: false, error: `Sponsor "${input.sponsorUsername}" was not found.` };

  const isFree = !!input.isFreeAccount;
  const pkgName = String(input.packageName ?? 'Premium').trim() || 'Premium';
  const rank = isFree ? rankFromPackage(input.freeDisplayRank || 'Premium') : rankFromPackage(pkgName);
  const accountType = isCA(input.accountType) ? 'CA' : 'MA';

  /* --- pin validation (free accounts need no pin) --- */
  let pin: PinRow | null = null;
  if (!isFree) {
    if (rank === 'Starter' && !input.pinCode) {
      // Starter may register without a code in the plugin's free-entry path;
      // require one whenever a code is supplied.
    } else if (!input.pinCode) {
      return { ok: false, error: 'An activation code is required for this package.' };
    }
    if (input.pinCode) {
      const check = await validatePin(input.pinCode, { rank });
      if (!check.ok || !check.pin) return { ok: false, error: check.error };
      pin = check.pin;
    }
  }

  /* --- structure owner + placement --- */
  const ownerUserInput = String(input.uplineUsername ?? '').trim();
  const structureOwner = ownerUserInput
    ? await one<UserRow>('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [ownerUserInput])
    : sponsor;
  if (!structureOwner) return { ok: false, error: `Placement upline "${ownerUserInput}" was not found.` };

  let ownerAccount =
    Number(input.structureOwnerAccountId) > 0
      ? await accountById(Number(input.structureOwnerAccountId))
      : ((await maAccountForUser(Number(structureOwner.id))) ?? (await primaryAccountForUser(Number(structureOwner.id))));
  if (!ownerAccount) return { ok: false, error: 'Structure owner has no active account node.' };
  if (isCA(ownerAccount.account_type)) {
    const resolved = await resolveOwnerMa(ownerAccount);
    if (resolved) ownerAccount = resolved;
  }
  const ownerAccountId = Number(ownerAccount.id);

  let uplineId = Number(input.uplineAccountId ?? 0);
  let position: Position | '' = String(input.position ?? '').toUpperCase() as Position;
  let spillover = false;

  if (uplineId > 0 && ['L', 'C', 'R'].includes(position)) {
    // manual / admin placement — enforce the same rules as auto placement
    const check = await validateStructurePlacement(ownerAccountId, uplineId, position, accountType);
    if (!check.ok) return { ok: false, error: check.error };
  } else {
    const auto = await getStrictPlacement(ownerAccountId);
    if (!auto) {
      return {
        ok: false,
        error: 'No available slot in this structure (trinary Level-3 boundary reached). Ask the admin to place manually.',
      };
    }
    uplineId = Number(auto.upline_id);
    position = auto.position;
    const sp = await getSpilloverPlacement(ownerAccountId);
    spillover = !!(sp && Number(sp.upline_id) === uplineId && sp.position === position);
  }

  if (accountType === 'CA' && uplineId !== ownerAccountId) {
    return { ok: false, error: 'Child Accounts must sit directly under the owner Mother Account (L/C/R).' };
  }

  const uplineRow = await accountById(uplineId);
  if (!uplineRow) return { ok: false, error: 'Placement parent node not found.' };

  /* --- create the user --- */
  const hash = await hashPassword(password);
  const userRows = await q<{ id: number }>(
    `INSERT INTO users
       (username, password_hash, email, display_name, first_name, middle_name, last_name, phone, bday,
        gender, address, rank, activation_status, is_admin, sponsor_id,
        is_free_account, free_account_kind, free_display_rank,
        free_receive_pairing, free_count_for_upline_pairing, free_pay_direct_referral, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',FALSE,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id`,
    [
      username,
      hash,
      String(input.email ?? ''),
      String(input.firstName ?? '') + (input.lastName ? ' ' + input.lastName : '') || username,
      String(input.firstName ?? ''),
      String(input.middleName ?? ''),
      String(input.lastName ?? ''),
      String(input.phone ?? ''),
      String(input.bday ?? ''),
      String(input.gender ?? ''),
      String(input.address ?? ''),
      rank,
      Number(sponsor.id),
      isFree,
      isFree ? accountType : '',
      isFree ? rank : '',
      isFree ? !!input.freeReceivePairing : false,
      isFree ? !!input.freeCountForUplinePairing : false,
      isFree ? !!input.freePayDirectReferral : false,
      when,
    ],
  );
  const newUserId = Number(userRows[0]?.id ?? 0);
  if (!newUserId) return { ok: false, error: 'Failed to create the member record.' };

  /* --- create the placement node --- */
  const accRows = await q<{ id: number }>(
    `INSERT INTO accounts (user_id, sponsor_id, upline_id, position, account_type, depth, rank_snapshot, activated_at, status, created_at)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7,1,$7) RETURNING id`,
    [newUserId, Number(sponsor.id), uplineId, position, accountType, rank, when],
  );
  const newAccountId = Number(accRows[0]?.id ?? 0);

  await setAccountDepth(newAccountId);
  await setAccountRankSnapshot(newAccountId, rank, when);
  if (isFree) await syncFreeAccountKindMeta(newUserId, accountType);

  /* --- consume the pin --- */
  if (pin) {
    await consumePin(Number(pin.id), newUserId, input.actor?.role === 'admin' ? 'admin' : 'member', input.actor?.id ?? 0);
  }

  /* --- direct referral bonus to the sponsor only --- */
  let drBonus = 0;
  const sponsorUser = await userById(Number(sponsor.id));
  const newUser = await userById(newUserId);
  const sponsorCanEarn = sponsorUser ? await freeCanPayDirectReferral(sponsorUser) : true;
  const placedCounts = newUser ? !(isFreeAccountUser(newUser) && !newUser.free_count_for_upline_pairing) : true;
  if (sponsorCanEarn && placedCounts) {
    drBonus = await payDirectReferral(
      Number(sponsor.id),
      username,
      isFree ? 'Free' : pkgName,
      pin ? ` (PIN #${pin.id})` : '',
      newUserId,
      when,
    );
    if (drBonus > 0) {
      await exec('UPDATE users SET lifetime_dr_paid = lifetime_dr_paid + $1 WHERE id = $2', [drBonus, Number(sponsor.id)]);
    }
  }

  /* --- points upflow + pair evaluation (chronological event time) --- */
  await processPointUpflow(newAccountId, newUserId, when);
  await finalizeNewAccountStructure(newAccountId, newUserId);

  const slotLabel = (await rSlotLabel(uplineId, position)) || '';
  const note = spillover
    ? `Spillover placement under @${((await userById(Number(uplineRow.user_id)))?.username ?? '').toUpperCase()}`
    : `Manual structure slot ${position}`;

  await auditLog({
    actorUserId: input.actor?.id ?? newUserId,
    actorUsername: input.actor?.username ?? username,
    actorRole: input.actor?.role ?? 'member',
    category: 'registration',
    action: isFree ? `REGISTER FREE ${accountType}` : `REGISTER ${rank.toUpperCase()}`,
    targetUserId: newUserId,
    targetUsername: username,
    details: {
      sponsor: sponsor.username,
      upline_account: uplineId,
      position,
      slot: slotLabel,
      pin: pin?.pin_code ?? '',
      dr: drBonus,
      spillover,
      free: isFree,
    },
  });

  return {
    ok: true,
    userId: newUserId,
    accountId: newAccountId,
    username,
    rank: isFree ? memberDisplayRank(newUser, rank) : rank,
    uplineUsername: (await userById(Number(uplineRow.user_id)))?.username ?? '',
    position,
    slotLabel,
    spillover,
    drBonus,
    placementNote: note,
  };
}

async function resolveOwnerMa(ca: AccountRow): Promise<AccountRow | null> {
  let current: AccountRow | null = ca;
  let safety = 0;
  while (current && safety++ < 50) {
    if (isMA(current.account_type)) return current;
    current = current.upline_id ? await accountById(Number(current.upline_id)) : null;
  }
  return null;
}

/* ------------------------- CA activation ------------------------- */

export interface CaActivationInput {
  /** Mother Account owner's user id */
  userId: number;
  /** New Child Account login (plugin: CA is a separate user) */
  caUsername: string;
  caPassword: string;
  /** Package pin row id owned by the owner (their package vault) */
  pinId?: number;
  pinCode?: string;
  isFree?: boolean;
  freeReceivePairing?: boolean;
  freeCountForUplinePairing?: boolean;
  freePayDirectReferral?: boolean;
  actor?: { id: number; username: string; role: 'member' | 'admin' };
}

/**
 * Activate the next Child Account (CA1 → CA2 → CA3) directly under the
 * member's Mother Account (plugin: activate_ca_advanced).
 *
 * A CA is a SEPARATE restricted user with its own login and its own
 * wallet/ledger (sponsor = the MA owner). Structurally it is a connector
 * node: it never earns the owner's direct referrals and never consumes a
 * unilevel tier.
 */
export async function activateCa(
  input: CaActivationInput,
): Promise<{ ok: boolean; error?: string; accountId?: number; caUserId?: number; slot?: string }> {
  const owner = await userById(Number(input.userId));
  if (!owner) return { ok: false, error: 'Member not found.' };
  const ma = await maAccountForUser(Number(owner.id));
  if (!ma) return { ok: false, error: 'Mother Account not found for this member.' };

  const caUsername = String(input.caUsername ?? '').trim();
  const caPassword = String(input.caPassword ?? '');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(caUsername)) {
    return { ok: false, error: 'Child Account username must be 3–32 characters (letters, numbers, dot, dash, underscore).' };
  }
  if (!validAlnumPassword(caPassword)) {
    return { ok: false, error: 'Child Account password must be at least 6 characters and contain no spaces.' };
  }
  if (Number((await scalar<number>('SELECT COUNT(*) FROM users WHERE LOWER(username) = LOWER($1)', [caUsername])) ?? 0) > 0) {
    return { ok: false, error: `Username "${caUsername}" is already taken.` };
  }

  const filledRows = await q<{ position: Position; account_type: string }>(
    'SELECT position, account_type FROM accounts WHERE upline_id = $1',
    [Number(ma.id)],
  );
  const filled = filledRows.map((r) => r.position);
  const caCount = filledRows.filter((r) => r.account_type === 'CA').length;
  // Plugin order: first free direct slot wins (L, then C, then R).
  const slot = (['L', 'C', 'R'] as Position[]).find((p) => !filled.includes(p));
  if (!slot) {
    return { ok: false, error: 'All 3 Child Account slots are already active or occupied by spillovers.' };
  }

  let pin: PinRow | null = null;
  if (!input.isFree) {
    if (Number(input.pinId) > 0) {
      pin = await one<PinRow>(
        `SELECT * FROM pins WHERE id=$1 AND purchaser_id=$2 AND status='unused' AND is_product=0`,
        [Number(input.pinId), Number(owner.id)],
      );
      if (!pin) return { ok: false, error: 'Invalid or used Package Code. You must purchase a package to open a CA.' };
    } else if (input.pinCode) {
      const check = await validatePin(input.pinCode);
      if (!check.ok || !check.pin) return { ok: false, error: check.error };
      if (Number(check.pin.purchaser_id) !== Number(owner.id)) {
        return { ok: false, error: 'That Package Code does not belong to your vault.' };
      }
      pin = check.pin;
    } else {
      return { ok: false, error: 'An activation code is required for a paid Child Account.' };
    }
  }

  const rank = rankFromPackage(pin?.package_type || owner.rank || 'Premium');
  const hash = await hashPassword(caPassword);
  const displayName = `${owner.first_name} ${owner.last_name}`.trim() + ' (CA)';
  const userRows = await q<{ id: number }>(
    `INSERT INTO users
       (username, password_hash, email, display_name, first_name, middle_name, last_name, phone, bday,
        rank, activation_status, is_admin, sponsor_id,
        is_free_account, free_account_kind, free_display_rank,
        free_receive_pairing, free_count_for_upline_pairing, free_pay_direct_referral)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',FALSE,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      caUsername,
      hash,
      `${caUsername}@mjpremium.local`,
      displayName || caUsername,
      owner.first_name,
      owner.middle_name,
      owner.last_name,
      owner.phone,
      owner.bday,
      rank,
      Number(owner.id),
      !!input.isFree,
      input.isFree ? 'CA' : '',
      input.isFree ? rank : '',
      input.isFree ? !!input.freeReceivePairing : false,
      input.isFree ? !!input.freeCountForUplinePairing : false,
      input.isFree ? !!input.freePayDirectReferral : false,
    ],
  );
  const caUserId = Number(userRows[0]?.id ?? 0);
  if (!caUserId) return { ok: false, error: 'Failed to create the Child Account user.' };
  await exec('UPDATE users SET member_id_number = $1 WHERE id = $2', [
    generateMemberIdNumber(caUserId),
    caUserId,
  ]);

  const rows = await q<{ id: number }>(
    `INSERT INTO accounts (user_id, sponsor_id, upline_id, position, account_type, depth, rank_snapshot, activated_at, status)
     VALUES ($1,$2,$3,$4,'CA',0,$5,now(),1) RETURNING id`,
    [caUserId, Number(owner.id), Number(ma.id), slot, rank],
  );
  const caId = Number(rows[0]?.id ?? 0);
  await setAccountDepth(caId);
  await setAccountRankSnapshot(caId, rank);
  if (input.isFree) await syncFreeAccountKindMeta(caUserId, 'CA');
  if (pin) {
    await consumePin(Number(pin.id), caUserId, input.actor?.role === 'admin' ? 'admin' : 'member', input.actor?.id ?? 0);
  }

  // CAs participate in point upflow; the direct-child skip prevents self-pairing.
  await processPointUpflow(caId, caUserId);
  await finalizeNewAccountStructure(caId, caUserId);
  // FIX-2 + FIX-5: DR for CA activation goes to the CA's sponsor (the owner).
  await payDirectReferral(Number(owner.id), caUsername, pin?.package_type || rank, ' (CA Activation)', caUserId);

  const label = slot === 'L' ? 'CA1' : slot === 'C' ? 'CA2' : 'CA3';
  await auditLog({
    actorUserId: input.actor?.id ?? Number(owner.id),
    actorUsername: input.actor?.username ?? owner.username,
    actorRole: input.actor?.role ?? 'member',
    category: 'accounts',
    action: `ACTIVATE ${label}`,
    targetUserId: caUserId,
    targetUsername: caUsername,
    details: { slot, rank, pin: pin?.pin_code ?? '', ca_number: caCount + 1, free: !!input.isFree },
  });

  return { ok: true, accountId: caId, caUserId, slot: `${label} (${slot})` };
}

/* ------------------------- rank upgrade ------------------------- */

export async function upgradeRank(
  userId: number,
  targetRank: string,
  pinCode?: string,
  actor?: { id: number; username: string; role: 'member' | 'admin' },
): Promise<{ ok: boolean; error?: string; from?: string; to?: string; dr?: number }> {
  const user = await userById(Number(userId));
  if (!user) return { ok: false, error: 'Member not found.' };
  const from = user.rank || 'Premium';
  const to = rankFromPackage(targetRank);
  if (isStarterRank(from) && rankIndex(to) === 0) return { ok: false, error: 'Already on the Starter rank.' };
  if (rankIndex(to) <= rankIndex(from)) return { ok: false, error: `Cannot downgrade from ${from} to ${to}.` };

  let pin: PinRow | null = null;
  if (pinCode) {
    const check = await validatePin(pinCode, { rank: to });
    if (!check.ok || !check.pin) return { ok: false, error: check.error };
    pin = check.pin;
  }

  await exec('UPDATE users SET rank = $1 WHERE id = $2', [to, Number(userId)]);
  await addRankHistory(Number(userId), from, to);
  const accounts = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = $1', [Number(userId)]);
  for (const a of accounts) await setAccountRankSnapshot(Number(a.id), to);
  if (pin) {
    await consumePin(Number(pin.id), Number(userId), actor?.role === 'admin' ? 'admin' : 'member', actor?.id ?? 0);
    // Upgrading with a package code pays the sponsor the upgrade difference DR.
    let dr = 0;
    if (Number(user.sponsor_id) > 0) {
      dr = await payDirectReferral(Number(user.sponsor_id), user.username, to, ` (Upgrade PIN #${pin.id})`, Number(userId));
      if (dr > 0) await exec('UPDATE users SET lifetime_dr_paid = lifetime_dr_paid + $1 WHERE id = $2', [dr, Number(user.sponsor_id)]);
    }
    await auditLog({
      actorUserId: actor?.id ?? Number(userId),
      actorUsername: actor?.username ?? user.username,
      actorRole: actor?.role ?? 'member',
      category: 'rank',
      action: 'RANK UPGRADE',
      targetUserId: Number(userId),
      targetUsername: user.username,
      details: { from, to, pin: pin.pin_code, dr },
    });
    return { ok: true, from, to, dr };
  }

  await auditLog({
    actorUserId: actor?.id ?? Number(userId),
    actorUsername: actor?.username ?? user.username,
    actorRole: actor?.role ?? 'member',
    category: 'rank',
    action: 'RANK UPGRADE',
    targetUserId: Number(userId),
    targetUsername: user.username,
    details: { from, to },
  });
  return { ok: true, from, to };
}

/* ---------------------------- orders ---------------------------- */

export interface OrderItem {
  name: string;
  qty: number;
  price: number;
  isProduct?: boolean;
  packageName?: string;
}

export async function placeOrder(
  userId: number,
  items: OrderItem[],
  proofImage = '',
): Promise<{ ok: boolean; error?: string; orderId?: number; total?: number }> {
  const list = (items ?? []).filter((i) => i && i.name);
  if (!list.length) return { ok: false, error: 'Select at least one item.' };
  const total = list.reduce((s, i) => s + Number(i.price || 0) * Math.max(1, Number(i.qty || 1)), 0);
  const rows = await q<{ id: number }>(
    `INSERT INTO orders (user_id, order_details, proof_image, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
    [Number(userId), JSON.stringify(list), String(proofImage ?? '')],
  );
  const orderId = Number(rows[0]?.id ?? 0);
  const u = await userById(Number(userId));
  await auditLog({
    actorUserId: Number(userId),
    actorUsername: u?.username ?? '',
    actorRole: 'member',
    category: 'orders',
    action: 'PLACE ORDER',
    targetUserId: Number(userId),
    details: { orderId, total, items: list.length },
  });
  return { ok: true, orderId, total };
}

export async function orderItems(orderDetails: string): Promise<OrderItem[]> {
  try {
    const parsed = JSON.parse(orderDetails || '[]');
    if (Array.isArray(parsed)) return parsed as OrderItem[];
  } catch {
    /* legacy free-text orders */
  }
  return [{ name: String(orderDetails || 'Order'), qty: 1, price: 0 }];
}

/* ------------------------- fund transfer ------------------------- */

export async function transferFunds(
  fromUserId: number,
  toUsername: string,
  amount: number,
  note = '',
): Promise<{ ok: boolean; error?: string; fee?: number; net?: number }> {
  const amt = Number(amount);
  const fee = Number((await import('../settings')).settingNum('mlm_sys_fund_transfer_fee', 25));
  const from = await userById(Number(fromUserId));
  if (!from) return { ok: false, error: 'Sender not found.' };
  const to = await one<UserRow>('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [
    String(toUsername ?? '').trim(),
  ]);
  if (!to) return { ok: false, error: `Recipient "${toUsername}" was not found.` };
  if (Number(to.id) === Number(fromUserId)) return { ok: false, error: 'You cannot transfer funds to yourself.' };
  if (!(amt > 0)) return { ok: false, error: 'Enter an amount greater than zero.' };
  if (Number(from.wallet_balance) < amt + fee) {
    return { ok: false, error: `Insufficient wallet balance (available ₱${Number(from.wallet_balance).toFixed(2)}, fee ₱${fee}).` };
  }

  await insertLedger({
    user_id: Number(fromUserId),
    amount: -(amt + fee),
    fee_deducted: fee,
    type: 'cash',
    status: 'active',
    note: `Fund Transfer to @${to.username}${note ? ` — ${note}` : ''}`,
  });
  await addToWallet(Number(fromUserId), -(amt + fee));
  await insertLedger({
    user_id: Number(to.id),
    amount: amt,
    type: 'cash',
    status: 'released',
    note: `Fund Transfer received from @${from.username}${note ? ` — ${note}` : ''}`,
  });
  await addToWallet(Number(to.id), amt);
  await auditLog({
    actorUserId: Number(fromUserId),
    actorUsername: from.username,
    actorRole: 'member',
    category: 'wallet',
    action: 'FUND TRANSFER',
    targetUserId: Number(to.id),
    targetUsername: to.username,
    details: { amount: amt, fee, note },
  });
  return { ok: true, fee, net: amt };
}

/* ---------------------- product activation ---------------------- */

export async function activateProductPin(
  userId: number,
  pinCode: string,
  source: 'member' | 'admin' = 'member',
  actorId = 0,
): Promise<{ ok: boolean; error?: string; lp?: number }> {
  const check = await validatePin(pinCode, { expectProduct: true });
  if (!check.ok || !check.pin) return { ok: false, error: check.error };
  const user = await userById(Number(userId));
  if (!user) return { ok: false, error: 'Member not found.' };
  if (isStarterRank(user.rank)) return { ok: false, error: 'Starter accounts cannot activate retail products.' };

  const { markProductPinUsed, handleProductActivationUnilevel, usedProductPinCount } = await import('./unilevel');
  await markProductPinUsed(Number(check.pin.id), Number(userId), source, actorId);
  await exec('UPDATE users SET lp = lp + 1 WHERE id = $1', [Number(userId)]);
  await handleProductActivationUnilevel(Number(userId), 1);
  await auditLog({
    actorUserId: actorId || Number(userId),
    actorUsername: source === 'admin' ? (await userById(actorId))?.username ?? 'admin' : user.username,
    actorRole: source === 'admin' ? 'admin' : 'member',
    category: 'products',
    action: 'ACTIVATE PRODUCT',
    targetUserId: Number(userId),
    targetUsername: user.username,
    details: { pin: check.pin.pin_code, product: check.pin.package_type },
  });
  return { ok: true, lp: await usedProductPinCount(Number(userId)) };
}

/* ------------------------- member ID card ------------------------- */

export async function issueMemberId(userId: number, validYears = 1): Promise<string> {
  const idNumber = generateMemberIdNumber(Number(userId));
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + Math.max(1, Number(validYears) || 1));
  await exec('UPDATE users SET member_id_number = $1, member_id_expires = $2 WHERE id = $3', [
    idNumber,
    phFormat(expires, 'Y-m-d'),
    Number(userId),
  ]);
  return idNumber;
}

export { calcDrBonus, getUserRankAt };
