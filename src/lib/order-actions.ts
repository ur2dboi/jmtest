import { exec, one } from './db';
import type { OrderRow, PackageRow } from './types';
import { auditLog, userById } from './engine/accounts';
import { consumePin } from './engine/registration';
import { handleProductActivationUnilevel, markProductPinUsed } from './engine/unilevel';
import { packagesByName } from './queries';

/* =====================================================================
 * ORDER APPROVAL ENGINE (admin Pkg Orders / Product Orders)
 * - Registration orders carry a Code: -> unlock that pin to 'unused'.
 * - ORDER: Nx Name -> generate N pins (unused). "Activate" additionally
 *   marks product pins used (source=admin) and pays unilevel.
 * ===================================================================== */

export interface OrderActor {
  id: number;
  username: string;
}

function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function generatePinRow(packageType: string, isProduct: boolean, purchaserId: number): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const rows = await one<{ id: number }>(
      `INSERT INTO pins (pin_code, package_type, is_product, purchaser_id, status)
       VALUES ($1,$2,$3,$4,'unused')
       ON CONFLICT (pin_code) DO NOTHING RETURNING id`,
      [code, packageType, isProduct ? 1 : 0, purchaserId],
    );
    if (rows) return Number(rows.id);
  }
  throw new Error('Failed to generate a unique pin code.');
}

export async function approveOrder(
  orderId: number,
  actor: OrderActor,
  opts: { activate?: boolean } = {},
): Promise<{ ok: boolean; error?: string; generated?: number; activated?: number }> {
  const order = await one<OrderRow>('SELECT * FROM orders WHERE id = $1', [Number(orderId)]);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.status !== 'pending') return { ok: false, error: 'Order was already processed.' };

  const details = order.order_details || '';
  const codeMatch = /Code:\s*([A-Z0-9]+)/i.exec(details);

  if (codeMatch) {
    // Registration unlock: pending_payment -> unused
    await exec(`UPDATE pins SET status='unused' WHERE pin_code = $1 AND status='pending_payment'`, [codeMatch[1]]);
    await exec(`UPDATE orders SET status='approved' WHERE id = $1`, [order.id]);
    await auditLog({
      actorUserId: actor.id, actorUsername: actor.username, actorRole: 'admin',
      category: 'orders', action: 'APPROVE REGISTRATION ORDER',
      targetUserId: Number(order.user_id), details: { orderId: order.id, code: codeMatch[1] },
    });
    return { ok: true, generated: 0 };
  }

  const orderMatch = /ORDER:\s*(\d+)x\s*(.+?)(?:\s*\||$)/.exec(details);
  if (!orderMatch) {
    await exec(`UPDATE orders SET status='approved' WHERE id = $1`, [order.id]);
    return { ok: true, generated: 0 };
  }

  const qty = Math.max(1, Number(orderMatch[1]));
  const pkgName = orderMatch[2].trim();
  const byName = await packagesByName();
  const pkg: PackageRow | undefined = byName.get(pkgName);
  const isProduct = !!pkg && Number(pkg.is_product) === 1;

  await exec(`UPDATE orders SET status='approved' WHERE id = $1`, [order.id]);
  let generated = 0;
  let activated = 0;
  for (let i = 0; i < qty; i++) {
    const pinId = await generatePinRow(pkgName, isProduct, Number(order.user_id));
    generated++;
    // Product pins stay 'unused' on plain approval: the member activates
    // from My Products and only then are commissions distributed.
    if (opts.activate && isProduct) {
      await markProductPinUsed(pinId, Number(order.user_id), 'admin');
      await handleProductActivationUnilevel(Number(order.user_id), 1);
      activated++;
    }
  }
  await auditLog({
    actorUserId: actor.id, actorUsername: actor.username, actorRole: 'admin',
    category: 'orders', action: opts.activate ? 'APPROVE + ACTIVATE ORDER' : 'APPROVE ORDER',
    targetUserId: Number(order.user_id), details: { orderId: order.id, qty, pkgName, isProduct, generated, activated },
  });
  return { ok: true, generated, activated };
}

export async function rejectOrder(orderId: number, actor: OrderActor): Promise<{ ok: boolean; error?: string }> {
  const order = await one<OrderRow>('SELECT * FROM orders WHERE id = $1', [Number(orderId)]);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.status !== 'pending') return { ok: false, error: 'Order was already processed.' };
  await exec(`UPDATE orders SET status='rejected' WHERE id = $1`, [order.id]);
  const codeMatch = /Code:\s*([A-Z0-9]+)/i.exec(order.order_details || '');
  if (codeMatch) {
    // Keep the registration pin locked so the member cannot activate.
    await exec(`UPDATE pins SET status='pending_payment' WHERE pin_code = $1 AND status <> 'used'`, [codeMatch[1]]);
  }
  await auditLog({
    actorUserId: actor.id, actorUsername: actor.username, actorRole: 'admin',
    category: 'orders', action: 'REJECT ORDER', targetUserId: Number(order.user_id),
    details: { orderId: order.id },
  });
  return { ok: true };
}

export async function transferOrder(
  orderId: number,
  targetUsername: string,
  actor: OrderActor,
): Promise<{ ok: boolean; error?: string }> {
  const target = await one<{ id: number }>('SELECT id FROM users WHERE username = $1', [targetUsername.trim()]);
  if (!target) return { ok: false, error: `Username '@${targetUsername}' not found.` };
  const order = await one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND status = $2', [Number(orderId), 'pending']);
  if (!order) return { ok: false, error: 'Pending order not found.' };
  await exec('UPDATE orders SET user_id = $1 WHERE id = $2', [Number(target.id), Number(orderId)]);
  await auditLog({
    actorUserId: actor.id, actorUsername: actor.username, actorRole: 'admin',
    category: 'orders', action: 'TRANSFER ORDER', targetUserId: Number(target.id),
    targetUsername, details: { orderId: Number(orderId), from: Number(order.user_id) },
  });
  return { ok: true };
}

/** Consume a vault pin for registration flows (ownership-checked by caller). */
export async function useVaultPin(pinId: number, usedBy: number, actor: OrderActor, isAdmin: boolean): Promise<boolean> {
  return consumePin(pinId, usedBy, isAdmin ? 'admin' : 'member', actor.id);
}

export async function orderOwnerName(order: OrderRow): Promise<string> {
  const u = await userById(Number(order.user_id));
  return u?.username ?? `#${order.user_id}`;
}
