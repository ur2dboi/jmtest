import { exec, one, q, scalar } from '@/lib/db';
import { ensureSettings, saveSettings, settingBool } from '@/lib/settings';
import { hashPassword, validAlnumPassword, passwordPolicyMessage } from '@/lib/auth';
import { adminActor, audit, body, err, fail, ok } from '@/lib/http';
import type { PackageRow, PinRow, UserRow } from '@/lib/types';
import {
  auditLog,
  invalidateUser,
  maAccountForUser,
  userById,
} from '@/lib/engine/accounts';
import { phMonthKey } from '@/lib/time';
import { generatePins, registerMember, upgradeRank } from '@/lib/engine/registration';
import { evaluatePairsCascade } from '@/lib/engine/pairing';
import { releaseMaturedUnilevelCommissions, handleProductActivationUnilevel, markProductPinUsed } from '@/lib/engine/unilevel';
import { approveEncashment, listEncashments, rejectEncashment } from '@/lib/engine/encash';
import { moveNode } from '@/lib/engine/tree';
import {
  fullRebuild,
  getRebuildState,
  initBatchRebuild,
  runBatchStep,
  totalFinancialWipe,
  wipeGhostPoints,
} from '@/lib/engine/rebuild';
import { clearAlertHistory } from '@/lib/queries';
import { approveOrder, rejectOrder, transferOrder } from '@/lib/order-actions';
import { restoreBackup } from '@/lib/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** POST /api/admin { action, ... } — port of the admin command center handlers. */
export async function POST(req: Request) {
  try {
    await ensureSettings();
    const actor = await adminActor();
    if (!actor) return fail('Admin gateway access required.', 403);
    const admin = actor.user;
    const actorRef = { id: Number(admin.id), username: admin.username };
    const b = await body<Record<string, unknown>>(req);
    const action = String(b.action ?? '');

    /* ---------------- direct registration (incl. free accounts) ---------------- */
    if (action === 'register') {
      const pkg = await one<PackageRow>('SELECT * FROM packages WHERE id=$1 AND is_product=0', [Number(b.pkg_id)]);
      if (!pkg) return fail('Please select a package/rank for this member, including Free Accounts.');
      const isFree = !!b.is_free;
      const accountType = isFree && String(b.free_kind) === 'CA' ? 'CA' : 'MA';

      // Resolve placement target: upline user + node (MA / CA_L / CA_C / CA_R) + leg
      const uplineUser = await one<UserRow>('SELECT * FROM users WHERE username=$1', [String(b.upline ?? '')]);
      if (!uplineUser) return fail('Target Upline username not found.');
      const sponsorUser = await one<UserRow>('SELECT * FROM users WHERE username=$1', [String(b.sponsor ?? '')]);
      if (!sponsorUser) return fail('Sponsor username not found.');
      const nodeType = String(b.upline_node ?? 'MA');
      let targetAccountId = 0;
      if (nodeType === 'MA') {
        const ma = await maAccountForUser(Number(uplineUser.id));
        if (ma) targetAccountId = Number(ma.id);
      } else {
        const pos = nodeType.replace('CA_', '');
        const ca = await one<{ id: number }>(
          `SELECT id FROM accounts WHERE user_id=$1 AND account_type='CA' AND position=$2 ORDER BY id ASC LIMIT 1`,
          [uplineUser.id, pos],
        );
        if (ca) targetAccountId = Number(ca.id);
      }
      if (!targetAccountId) return fail(`The specified Upline Node (${nodeType}) does not exist for this user.`);
      if (accountType === 'CA' && nodeType !== 'MA') {
        return fail('Free Child Account must be placed under the target user\'s Mother Account node (same as a regular Child Account).');
      }
      const leg = String(b.leg ?? 'L').toUpperCase();
      if (!['L', 'C', 'R'].includes(leg)) return fail('Invalid leg. Choose L, C, or R.');

      const res = await registerMember({
        username: String(b.username ?? ''),
        password: String(b.password ?? ''),
        sponsorUsername: accountType === 'CA' ? uplineUser.username : sponsorUser.username,
        packageName: pkg.pkg_name,
        firstName: String(b.first_name ?? ''),
        middleName: String(b.middle_name ?? ''),
        lastName: String(b.last_name ?? ''),
        email: String(b.email ?? ''),
        phone: String(b.phone ?? ''),
        uplineAccountId: targetAccountId,
        position: leg as 'L' | 'C' | 'R',
        accountType,
        isFreeAccount: isFree,
        freeDisplayRank: pkg.pkg_name,
        freeReceivePairing: !!b.free_receive,
        freeCountForUplinePairing: !!b.free_count,
        freePayDirectReferral: !!b.free_dr,
        actor: { ...actorRef, role: 'admin' },
      });
      if (!res.ok) return fail(res.error!);
      const typeLabel = accountType === 'CA' ? 'Child Account' : 'Mother Account';
      return ok({ message: `Success! Member '${res.username}' registered as ${typeLabel} under '${uplineUser.username}' (${leg}).`, result: res });
    }

    /* ---------------- network override (move node) ---------------- */
    if (action === 'move-node') {
      const moveUser = await one<UserRow>('SELECT * FROM users WHERE username=$1', [String(b.username ?? '')]);
      if (!moveUser || Number(moveUser.id) === 1) return fail('Invalid user to move (Admin cannot be moved).');
      const upUser = await one<UserRow>('SELECT * FROM users WHERE username=$1', [String(b.upline ?? '')]);
      if (!upUser) return fail('Target upline user not found.');
      if (moveUser.username === upUser.username) return fail('Cannot move a user underneath themselves.');
      const moveMa = await maAccountForUser(Number(moveUser.id));
      if (!moveMa) return fail('Member has no Mother Account node.');
      const nodeType = String(b.upline_node ?? 'MA');
      let targetId = 0;
      if (nodeType === 'MA') {
        const ma = await maAccountForUser(Number(upUser.id));
        if (ma) targetId = Number(ma.id);
      } else {
        const ca = await one<{ id: number }>(
          `SELECT id FROM accounts WHERE user_id=$1 AND account_type='CA' AND position=$2 LIMIT 1`,
          [upUser.id, nodeType.replace('CA_', '')],
        );
        if (ca) targetId = Number(ca.id);
      }
      if (!targetId) return fail('Required account nodes not found in database.');
      const res = await moveNode(Number(moveMa.id), targetId, String(b.leg ?? 'L'), actorRef);
      if (!res.ok) return fail(res.error!);
      return ok({ message: `SUCCESS: Member '${moveUser.username}' relocated under '${upUser.username}' (${String(b.leg)}) within spillover rules.` });
    }

    /* ---------------- member edit ---------------- */
    if (action === 'edit-member') {
      const target = await userById(Number(b.user_id));
      if (!target) return fail('Member not found.');
      const newUsername = String(b.username ?? target.username).trim();
      if (newUsername !== target.username) {
        const taken = await one<{ id: number }>('SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id<>$2', [newUsername, target.id]);
        if (taken) return fail(`Username '${newUsername}' is already taken.`);
      }
      await exec(
        `UPDATE users SET username=$1, email=$2, first_name=$3, last_name=$4, phone=$5, bday=$6,
           display_name=$7, achievement_rank=$8, monthly_lp=$9, monthly_lp_period=$10,
           member_id_number=$11, member_id_expires=NULLIF($12,'')::date
         WHERE id=$13`,
        [
          newUsername,
          String(b.email ?? target.email),
          String(b.first_name ?? target.first_name),
          String(b.last_name ?? target.last_name),
          String(b.phone ?? target.phone),
          String(b.bday ?? target.bday),
          `${String(b.first_name ?? target.first_name)} ${String(b.last_name ?? target.last_name)}`.trim() || newUsername,
          String(b.achievement ?? target.achievement_rank),
          Math.max(0, Number(b.lp ?? target.monthly_lp) || 0),
          phMonthKey(),
          String(b.member_id_number ?? '').trim() || target.member_id_number,
          String(b.member_id_expires ?? '').trim(),
          target.id,
        ],
      );
      if (String(b.password ?? '')) {
        if (!validAlnumPassword(String(b.password))) return fail(passwordPolicyMessage());
        await exec('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(String(b.password)), target.id]);
      }
      invalidateUser(Number(target.id));
      await audit(actor, 'admin', 'EDIT MEMBER', { username: newUsername }, { id: Number(target.id), username: newUsername });
      return ok({ message: 'Member updated successfully! (Any username changes have been applied.)' });
    }

    /* ---------------- hold / unhold ---------------- */
    if (action === 'toggle-hold') {
      const target = await userById(Number(b.user_id));
      if (!target || Number(target.id) === 1) return fail('Invalid member.');
      if (target.account_held) {
        await exec('UPDATE users SET account_held=FALSE WHERE id=$1', [target.id]);
        invalidateUser(Number(target.id));
        const accounts = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id=$1', [target.id]);
        for (const a of accounts) await evaluatePairsCascade(Number(a.id), 0);
        await releaseMaturedUnilevelCommissions();
        return ok({ message: `Account @${target.username} has been UNBLOCKED. Waiting points were re-evaluated.` });
      }
      await exec('UPDATE users SET account_held=TRUE WHERE id=$1', [target.id]);
      invalidateUser(Number(target.id));
      return ok({ message: `Account @${target.username} has been put ON HOLD. Earnings are paused, but waiting points can still accumulate.` });
    }

    /* ---------------- delete member(s) ---------------- */
    if (action === 'delete-member' || action === 'bulk-delete-members') {
      const ids = action === 'delete-member' ? [Number(b.user_id)] : (b.user_ids as unknown[]).map(Number);
      let deleted = 0;
      for (const uid of ids) {
        if (!uid || uid === 1) continue;
        const target = await userById(uid);
        if (!target) continue;
        // Cascade: Child Account users sponsored by this member
        const caUsers = await q<{ user_id: number }>(
          `SELECT DISTINCT user_id FROM accounts WHERE sponsor_id=$1 AND account_type='CA'`,
          [uid],
        );
        for (const ca of caUsers) await deleteUserCascade(Number(ca.user_id));
        await deleteUserCascade(uid);
        deleted++;
        void target;
      }
      await audit(actor, 'admin', action === 'delete-member' ? 'DELETE MEMBER' : 'BULK DELETE MEMBERS', { ids });
      return ok({ message: `Deleted ${deleted} member(s) and all associated Child Accounts.` });
    }

    /* ---------------- orders ---------------- */
    if (action === 'orders-batch') {
      const ids = (b.order_ids as unknown[] | undefined)?.map(Number).filter(Boolean) ?? [];
      if (!ids.length) return fail('Please select at least one order to process.');
      let approved = 0, rejected = 0, generated = 0, activated = 0;
      for (const id of ids) {
        if (b.mode === 'activate') {
          const r = await approveOrder(id, actorRef, { activate: true });
          if (r.ok) { approved++; generated += r.generated ?? 0; activated += r.activated ?? 0; }
        } else if (b.mode === 'approve') {
          const r = await approveOrder(id, actorRef);
          if (r.ok) { approved++; generated += r.generated ?? 0; }
        } else if (b.mode === 'reject') {
          const r = await rejectOrder(id, actorRef);
          if (r.ok) rejected++;
        } else if (b.mode === 'transfer') {
          const r = await transferOrder(id, String(b.target ?? ''), actorRef);
          if (r.ok) approved++;
        }
      }
      if (b.mode === 'reject') return ok({ message: `Successfully Rejected ${rejected} order(s).` });
      if (b.mode === 'transfer') return ok({ message: `Transferred ${approved} order(s) to @${String(b.target)}.` });
      if (b.mode === 'activate') return ok({ message: `Activated ${approved} order(s). ${activated} product code(s) generated, used, and unilevel commissions distributed.` });
      return ok({ message: `Successfully Approved ${approved} order(s). Generated ${generated} activation codes.` });
    }
    if (action === 'order-single') {
      const id = Number(b.order_id);
      if (b.mode === 'approve') {
        const r = await approveOrder(id, actorRef);
        return r.ok ? ok({ message: `Order #${id} approved. ${r.generated ?? 0} code(s) generated as unused.` }) : fail(r.error!);
      }
      if (b.mode === 'activate') {
        const r = await approveOrder(id, actorRef, { activate: true });
        return r.ok ? ok({ message: `Order #${id} activated. ${r.activated ?? 0} code(s) generated, used, and commissions distributed.` }) : fail(r.error!);
      }
      if (b.mode === 'reject') {
        const r = await rejectOrder(id, actorRef);
        return r.ok ? ok({ message: `Order #${id} rejected.` }) : fail(r.error!);
      }
      if (b.mode === 'transfer') {
        const r = await transferOrder(id, String(b.target ?? ''), actorRef);
        return r.ok ? ok({ message: `Order #${id} transferred to @${String(b.target)}.` }) : fail(r.error!);
      }
      return fail('Unknown order mode.');
    }

    /* ---------------- encashment ---------------- */
    if (action === 'encash-single' || action === 'encash-bulk') {
      const ids = action === 'encash-single' ? [Number(b.ledger_id)] : ((b.ledger_ids as unknown[]) ?? []).map(Number);
      let processed = 0;
      for (const id of ids) {
        const r = b.mode === 'reject'
          ? await rejectEncashment(id, actorRef, String(b.reason ?? ''))
          : await approveEncashment(id, actorRef);
        if (r.ok) processed++;
      }
      return ok({ message: `${b.mode === 'reject' ? 'Rejected' : 'Approved & marked PAID'}: ${processed} encashment request(s).` });
    }

    /* ---------------- pins / product entries ---------------- */
    if (action === 'pin-generate') {
      const isProduct = !!b.is_product;
      const res = await generatePins({
        packageType: String(b.package_type ?? ''),
        count: Math.max(1, Math.min(500, Number(b.count ?? 1))),
        isProduct,
        purchaserId: 1,
        actor: actorRef,
      });
      return ok({ message: `Success! ${res.count} new code(s) generated for ${String(b.package_type)}.`, codes: res.codes });
    }
    if (action === 'pin-delete' || action === 'pins-bulk-delete') {
      const ids = action === 'pin-delete' ? [Number(b.pin_id)] : ((b.pin_ids as unknown[]) ?? []).map(Number);
      let deleted = 0;
      for (const id of ids) if (id) deleted += await exec('DELETE FROM pins WHERE id=$1', [id]);
      await audit(actor, 'admin', 'DELETE PIN(S)', { ids });
      return ok({ message: `Success! ${deleted} code(s) permanently deleted.` });
    }
    if (action === 'pin-transfer') {
      const target = await one<UserRow>('SELECT * FROM users WHERE username=$1', [String(b.target ?? '')]);
      if (!target) return fail('New Purchaser Username not found.');
      await exec('UPDATE pins SET purchaser_id=$1 WHERE id=$2', [target.id, Number(b.pin_id)]);
      return ok({ message: `Success! Pin Code ownership transferred to @${target.username}.` });
    }
    if (action === 'product-auto-activate-all' || action === 'product-activate-entry') {
      const pins = action === 'product-activate-entry'
        ? await q<PinRow>(`SELECT * FROM pins WHERE id=$1 AND is_product=1 AND status='unused'`, [Number(b.pin_id)])
        : await q<PinRow>(`SELECT * FROM pins WHERE is_product=1 AND status='unused' AND purchaser_id > 1`);
      let activated = 0;
      for (const p of pins) {
        if (Number(p.purchaser_id) < 2) continue;
        await markProductPinUsed(Number(p.id), Number(p.purchaser_id), 'admin');
        await handleProductActivationUnilevel(Number(p.purchaser_id), 1);
        activated++;
      }
      return ok({ message: activated ? `Auto-activated ${activated} loose product(s). Unilevel commissions distributed.` : 'No loose products found to activate.' });
    }

    /* ---------------- packages / products ---------------- */
    if (action === 'package-save' || action === 'product-save') {
      const isProduct = action === 'product-save' ? 1 : 0;
      const id = Number(b.id ?? 0);
      const payload = {
        name: String(b.name ?? '').trim(),
        price: Number(b.price ?? 0),
        desc: String(b.desc ?? ''),
        variants: String(b.variants ?? ''),
        status: Number(b.status ?? 1) ? 1 : 0,
      };
      if (!payload.name) return fail('Name is required.');
      if (id > 0) {
        await exec('UPDATE packages SET pkg_name=$1, pkg_price=$2, pkg_desc=$3, pkg_variants=$4, is_product=$5, status=$6 WHERE id=$7',
          [payload.name, payload.price, payload.desc, payload.variants, isProduct, payload.status, id]);
        return ok({ message: `${isProduct ? 'Product' : 'Package'} #${id} updated successfully.` });
      }
      const rows = await q<{ id: number }>(
        `INSERT INTO packages (pkg_name, pkg_price, pkg_desc, pkg_variants, is_product, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [payload.name, payload.price, payload.desc, payload.variants, isProduct, payload.status],
      );
      return ok({ message: `${isProduct ? 'Product' : 'Package'} Added Successfully!`, id: Number(rows[0].id) });
    }
    if (action === 'package-delete' || action === 'product-delete') {
      await exec('DELETE FROM packages WHERE id=$1', [Number(b.id)]);
      return ok({ message: 'Deleted.' });
    }

    /* ---------------- upgrade member (admin) ---------------- */
    if (action === 'upgrade-member') {
      const target = await userById(Number(b.user_id));
      if (!target) return fail('Member not found.');
      const res = await upgradeRank(Number(target.id), String(b.rank ?? ''), String(b.pin_code ?? '') || undefined, { ...actorRef, role: 'admin' });
      if (!res.ok) return fail(res.error!);
      return ok({ message: `@${target.username} upgraded ${res.from} → ${res.to}.` });
    }

    /* ---------------- settings ---------------- */
    if (action === 'settings-save') {
      const v = (b.values ?? {}) as Record<string, string | number | boolean>;
      const numKeys = [
        'mlm_sys_dr_starter', 'mlm_sys_dr_premium', 'mlm_sys_dr_starpremium', 'mlm_sys_bp_amount',
        'mlm_sys_tri_premium', 'mlm_sys_limit_premium', 'mlm_sys_limit_starpremium',
        'mlm_sys_limit_ca_premium', 'mlm_sys_limit_ca_starpremium', 'mlm_sys_gc_every',
        'mlm_sys_max_depth', 'mlm_sys_tax', 'mlm_sys_fee', 'mlm_sys_fund_transfer_fee', 'mlm_sys_min_encash',
      ];
      const out: Record<string, string> = {};
      for (const k of numKeys) if (v[k] !== undefined) out[k] = String(Number(v[k]) || 0);
      for (let i = 1; i <= 10; i++) {
        const k = `mlm_sys_uni_l${i}`;
        if (v[k] !== undefined) out[k] = String(Number(v[k]) || 0);
      }
      // Final rule: right-leg trigger count fixed at 1 for both ranks.
      out.mlm_sys_rpts_premium = '1';
      out.mlm_sys_rpts_starpremium = '1';
      for (const k of ['mlm_sys_unilevel_monthly_reset', 'mlm_sys_unilevel_cutoff_hold', 'mlm_sys_auto_approve_products']) {
        if (v[k] !== undefined) out[k] = v[k] ? '1' : '0';
      }
      await saveSettings(out);
      await audit(actor, 'settings', 'SAVE COMPENSATION SETTINGS', out);
      return ok({ message: 'Compensation Plan Settings Saved!' });
    }
    if (action === 'maintenance-toggle') {
      const current = settingBool('mlm_maintenance_mode', false);
      await saveSettings({ mlm_maintenance_mode: current ? '0' : '1' });
      await audit(actor, 'settings', current ? 'MAINTENANCE OFF' : 'MAINTENANCE ON');
      return ok({ message: current ? 'Maintenance mode DISABLED - system is now live for all members.' : 'Maintenance mode ENABLED - members are now blocked.' });
    }

    /* ---------------- rebuild ---------------- */
    if (action === 'rebuild-start') {
      const state = await initBatchRebuild(actorRef);
      return ok({ message: 'Batch rebuild started.', state });
    }
    if (action === 'rebuild-step') {
      const state = await runBatchStep(Number(b.batch_id ?? 1));
      return ok({ state });
    }
    if (action === 'rebuild-state') {
      return ok({ state: await getRebuildState() });
    }
    if (action === 'rebuild-full') {
      const msg = await fullRebuild({ skipPairing: !!b.skip_pairing, actor: actorRef });
      return ok({ message: msg });
    }
    if (action === 'wipe-points') {
      const wiped = await wipeGhostPoints();
      await audit(actor, 'danger', 'WIPE GHOST POINTS', { wiped });
      return ok({ message: `Ghost Points Wiped! ${wiped} account(s) reset.` });
    }
    if (action === 'wipe-ledger') {
      if (String(b.confirm ?? '') !== 'WIPE') return fail('Type WIPE to confirm the total financial wipe.');
      const msg = await totalFinancialWipe(actorRef);
      return ok({ message: msg });
    }

    /* ---------------- alerts / logs / backup ---------------- */
    if (action === 'alerts-clear-history') {
      await clearAlertHistory();
      return ok({ message: 'Alert history cleared.' });
    }
    if (action === 'logs-delete') {
      const ids = ((b.log_ids as unknown[]) ?? []).map(Number).filter(Boolean);
      if (!ids.length) return fail('Please select at least one activity log to delete.');
      const deleted = await exec('DELETE FROM audit_logs WHERE id = ANY($1::bigint[])', [ids]);
      await audit(actor, 'admin', 'DELETE ACTIVITY LOGS', { deleted, ids });
      return ok({ message: `Deleted ${deleted} selected activity log(s).` });
    }
    if (action === 'logs-clear') {
      if (String(b.confirm ?? '') !== 'CLEAR') return fail('Type CLEAR to confirm deleting all activity logs.');
      const count = Number((await scalar<string>('SELECT COUNT(*) FROM audit_logs')) ?? 0);
      await exec('DELETE FROM audit_logs');
      await audit(actor, 'admin', 'CLEAR ACTIVITY LOGS', { deleted: count });
      return ok({ message: `Activity logs cleared. Deleted ${count} old log row(s).` });
    }
    if (action === 'restore-backup') {
      if (String(b.confirm ?? '') !== 'RESTORE') return fail('Type RESTORE to confirm the restore operation.');
      const res = await restoreBackup(b.backup, actorRef);
      if (!res.ok) return fail(res.error!);
      return ok({ message: `Backup restored. Rows: ${JSON.stringify(res.stats)}` });
    }

    return fail(`Unknown action: ${action}`);
  } catch (e) {
    return err(e);
  }
}

async function deleteUserCascade(uid: number): Promise<void> {
  await exec('DELETE FROM accounts WHERE user_id=$1', [uid]);
  await exec('DELETE FROM ledger WHERE user_id=$1', [uid]);
  await exec('DELETE FROM orders WHERE user_id=$1', [uid]);
  await exec('DELETE FROM pins WHERE purchaser_id=$1', [uid]);
  await exec('DELETE FROM users WHERE id=$1', [uid]);
  invalidateUser(uid);
}

/** Keep tree.ts import used for member income repair endpoints. */
export async function GET() {
  const actor = await adminActor();
  if (!actor) return fail('Admin gateway access required.', 403);
  const pending = await listEncashments({ state: 'pending', limit: 1 });
  return ok({ pendingEncashments: pending.total });
}
