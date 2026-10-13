import { exec, one, q, scalar } from '../db';
import type { LedgerRow } from '../types';
import { settingNum } from '../settings';
import { auditLog, memberCanEncash, memberIdStatus, money, userById, addToWallet } from './accounts';
import { insertLedger } from './pairing';

/* =====================================================================
 * ENCASHMENT — request / approve / reject
 *
 * Net = gross − 10% withholding tax − ₱20 system fee − ₱25 (Fund Transfer)
 * A request is a NEGATIVE ledger row noted "Pending Admin Approval"; the
 * admin either marks it APPROVED & PAID or rejects it (refund + reversal).
 * Blocked without a valid, non-expired member ID number.
 * ===================================================================== */

export interface EncashQuote {
  gross: number;
  tax: number;
  systemFee: number;
  transferFee: number;
  totalDeductions: number;
  net: number;
}

export function quoteEncashment(gross: number, method: string): EncashQuote {
  const g = Math.max(0, Number(gross) || 0);
  const taxRate = settingNum('mlm_sys_tax', 10);
  const systemFee = settingNum('mlm_sys_fee', 20);
  const transferFee = /fund/i.test(method) ? settingNum('mlm_sys_fund_transfer_fee', 25) : 0;
  const tax = Math.round(g * (taxRate / 100) * 100) / 100;
  const totalDeductions = tax + systemFee + transferFee;
  return {
    gross: g,
    tax,
    systemFee,
    transferFee,
    totalDeductions,
    net: Math.round((g - totalDeductions) * 100) / 100,
  };
}

export interface EncashRequestInput {
  userId: number;
  amount: number;
  method: string;
  accountName?: string;
  accountNumber?: string;
  note?: string;
  ip?: string;
}

export async function requestEncashment(input: EncashRequestInput): Promise<{ ok: boolean; error?: string; quote?: EncashQuote; ledgerId?: number }> {
  const user = await userById(Number(input.userId));
  if (!user) return { ok: false, error: 'Member not found.' };

  const idStatus = await memberIdStatus(Number(user.id));
  if (!idStatus.valid) {
    return {
      ok: false,
      error: idStatus.reason || 'A valid, non-expired MJP Member ID is required before encashment.',
    };
  }
  if (!(await memberCanEncash(Number(user.id)))) {
    return { ok: false, error: 'Your account is not eligible to encash right now.' };
  }

  const min = settingNum('mlm_sys_min_encash', 1000);
  const gross = Number(input.amount);
  if (!(gross > 0)) return { ok: false, error: 'Enter an amount greater than zero.' };
  if (gross < min) return { ok: false, error: `Minimum encashment is ₱${money(min)}.` };
  if (Number(user.wallet_balance) < gross) {
    return { ok: false, error: `Insufficient released wallet balance (available ₱${money(user.wallet_balance)}).` };
  }

  const method = String(input.method || 'GCash').trim();
  const quote = quoteEncashment(gross, method);
  if (quote.net <= 0) return { ok: false, error: 'Amount is too small — net proceeds would be zero.' };

  const detail = [input.accountName, input.accountNumber].filter(Boolean).join(' • ');
  const note =
    `Encashment ₱${money(gross)} via ${method}` +
    (detail ? ` (${detail})` : '') +
    ` — Tax ₱${money(quote.tax)}, Fee ₱${money(quote.systemFee + quote.transferFee)}, Net ₱${money(quote.net)}` +
    ` — Pending Admin Approval`;

  const ledgerId = await insertLedger({
    user_id: Number(user.id),
    amount: -gross,
    tax_deducted: quote.tax,
    fee_deducted: quote.systemFee + quote.transferFee,
    type: 'cash',
    status: 'active',
    note,
  });
  await addToWallet(Number(user.id), -gross);

  await auditLog({
    actorUserId: Number(user.id),
    actorUsername: user.username,
    actorRole: 'member',
    category: 'encashment',
    action: 'ENCASH REQUEST',
    targetUserId: Number(user.id),
    details: { gross, method, net: quote.net, ledgerId, note: input.note ?? '' },
    ip: input.ip,
  });

  return { ok: true, quote, ledgerId };
}

export async function approveEncashment(
  ledgerId: number,
  actor: { id: number; username: string },
): Promise<{ ok: boolean; error?: string }> {
  const row = await one<LedgerRow>('SELECT * FROM ledger WHERE id = $1 AND amount < 0', [Number(ledgerId)]);
  if (!row) return { ok: false, error: 'Encashment request not found.' };
  if (!/Pending Admin Approval/i.test(row.note)) return { ok: false, error: 'This request was already processed.' };
  const note = row.note.replace(/— Pending Admin Approval/i, '— APPROVED & PAID');
  await exec('UPDATE ledger SET note = $1, status = $2 WHERE id = $3', [note, 'released', Number(ledgerId)]);
  await auditLog({
    actorUserId: actor.id,
    actorUsername: actor.username,
    actorRole: 'admin',
    category: 'encashment',
    action: 'ENCASH APPROVE',
    targetUserId: Number(row.user_id),
    details: { ledgerId: Number(ledgerId), amount: Number(row.amount) },
  });
  return { ok: true };
}

export async function rejectEncashment(
  ledgerId: number,
  actor: { id: number; username: string },
  reason = '',
): Promise<{ ok: boolean; error?: string }> {
  const row = await one<LedgerRow>('SELECT * FROM ledger WHERE id = $1 AND amount < 0', [Number(ledgerId)]);
  if (!row) return { ok: false, error: 'Encashment request not found.' };
  if (!/Pending Admin Approval/i.test(row.note)) return { ok: false, error: 'This request was already processed.' };
  const refund = Math.abs(Number(row.amount));
  await exec('DELETE FROM ledger WHERE id = $1', [Number(ledgerId)]);
  await addToWallet(Number(row.user_id), refund);
  await auditLog({
    actorUserId: actor.id,
    actorUsername: actor.username,
    actorRole: 'admin',
    category: 'encashment',
    action: 'ENCASH REJECT',
    targetUserId: Number(row.user_id),
    details: { ledgerId: Number(ledgerId), refund, reason },
  });
  return { ok: true };
}

export interface EncashRow extends LedgerRow {
  username?: string;
  display_name?: string;
  member_id_number?: string;
  state?: 'pending' | 'paid' | 'rejected';
}

export async function listEncashments(
  filter: { state?: 'pending' | 'paid' | 'all'; q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: EncashRow[]; total: number }> {
  const where = [`l.amount < 0`, `l.note LIKE '%Encashment%'`];
  const params: unknown[] = [];
  let i = 1;
  if (filter.state === 'pending') where.push(`l.note LIKE '%Pending Admin Approval%'`);
  if (filter.state === 'paid') where.push(`l.note LIKE '%APPROVED & PAID%'`);
  if (filter.q) {
    where.push(`(u.username ILIKE $${i} OR u.display_name ILIKE $${i} OR l.note ILIKE $${i})`);
    params.push(`%${filter.q}%`);
    i++;
  }
  const total = Number(
    (await scalar<string>(
      `SELECT COUNT(*) FROM ledger l LEFT JOIN users u ON u.id = l.user_id WHERE ${where.join(' AND ')}`,
      params,
    )) ?? 0,
  );
  const limit = Math.max(1, Math.min(500, Number(filter.limit) || 100));
  const offset = Math.max(0, Number(filter.offset) || 0);
  const rows = await q<EncashRow>(
    `SELECT l.*, u.username, u.display_name, u.member_id_number,
            to_char(l.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI:SS') AS created_text
     FROM ledger l LEFT JOIN users u ON u.id = l.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset],
  );
  for (const r of rows) {
    r.state = /APPROVED & PAID/i.test(r.note) ? 'paid' : /Pending Admin Approval/i.test(r.note) ? 'pending' : 'rejected';
  }
  return { rows, total };
}
