import { exec, one, q, scalar } from '@/lib/db';
import { ensureSettings, settingBool } from '@/lib/settings';
import { setActiveNode, validAlnumPassword, passwordPolicyMessage } from '@/lib/auth';
import { audit, body, err, fail, memberActor, ok } from '@/lib/http';
import type { AccountRow, PackageRow, PinRow, UserRow } from '@/lib/types';
import {
  accountById,
  auditLog,
  invalidateUser,
  isCA,
  isStarterRank,
  maAccountForUser,
  memberIdStatus,
  primaryAccountForUser,
  setAccountDepth,
  setAccountRankSnapshot,
  userById,
} from '@/lib/engine/accounts';
import {
  activateCa,
  activateProductPin,
  consumePin,
  rankFromPackage,
  registerMember,
  upgradeRank,
  validatePin,
} from '@/lib/engine/registration';
import { getStrictPlacement, validateStructurePlacement } from '@/lib/engine/placement';
import { finalizeNewAccountStructure, payDirectReferral, processPointUpflow } from '@/lib/engine/pairing';
import { requestEncashment } from '@/lib/engine/encash';
import { generatePinRow } from '@/lib/order-actions';
import { resolveMemberAccounts } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

/**
 * POST /api/member  { action, ... }
 * Port of every POST handler inside mlm_member_portal.
 */
export async function POST(req: Request) {
  try {
    await ensureSettings();
    const actor = await memberActor();
    if (!actor) return fail('Please log in.', 401);
    const user = actor.user;
    const b = await body<Record<string, unknown>>(req);
    const action = String(b.action ?? '');

    // Maintenance mode blocks members (admins unaffected)
    if (settingBool('mlm_maintenance_mode', false) && !user.is_admin && action !== 'switch-node') {
      return fail('System is under maintenance. Please check back shortly.', 503);
    }
    if (user.account_held && action !== 'switch-node') {
      return fail('Your account is on hold. Please contact the Administrator.', 403);
    }

    const primary = await primaryAccountForUser(Number(user.id));
    const loggedInAsChild = !!primary && isCA(primary.account_type);
    const { active: activeAccount } = await resolveMemberAccounts(Number(user.id), String(b.node ?? 'MA'));

    /* ---------------- switch dashboard node ---------------- */
    if (action === 'switch-node') {
      const node = String(b.node ?? 'MA');
      if (!['MA', 'C_L', 'C_C', 'C_R'].includes(node)) return fail('Invalid node.');
      await setActiveNode(node as never);
      return ok({ node });
    }

    /* ---------------- pending activation ---------------- */
    if (action === 'activate-pending') {
      if (user.activation_status !== 'pending') return fail('Account is already active.');
      let pin: PinRow | null = null;
      const code = String(b.code ?? '').trim();
      if (code) {
        const check = await validatePin(code);
        if (!check.ok || !check.pin) return fail(check.error!);
        pin = check.pin;
      } else {
        pin = await one<PinRow>(
          `SELECT * FROM pins WHERE purchaser_id=$1 AND is_product=0 AND status='unused' ORDER BY id ASC LIMIT 1`,
          [user.id],
        );
        if (!pin) return fail('No approved activation code found yet. Please wait for Admin approval or enter your code.');
      }

      const sponsorId = Number(user.sponsor_id) || 1;
      const sponsorMa = (await maAccountForUser(sponsorId)) ?? (await accountById(1));
      if (!sponsorMa) return fail('Sponsor placement node not found. Contact admin.');
      const placement = await getStrictPlacement(Number(sponsorMa.id));
      if (!placement) return fail("Activation Failed: No spillover-safe open slot under the sponsor's structure. Contact admin.");
      const check = await validateStructurePlacement(Number(sponsorMa.id), placement.upline_id, placement.position, 'MA');
      if (!check.ok) return fail(`Activation Failed: ${check.error}`);

      const packageType = pin.package_type;
      await exec(`UPDATE users SET rank=$1, activation_status='active' WHERE id=$2`, [packageType, user.id]);
      invalidateUser(Number(user.id));
      await consumePin(Number(pin.id), Number(user.id), 'member', Number(user.id));
      const rows = await q<{ id: number }>(
        `INSERT INTO accounts (user_id, sponsor_id, upline_id, position, account_type, depth, rank_snapshot, activated_at, status)
         VALUES ($1,$2,$3,$4,'MA',0,$5,now(),1) RETURNING id`,
        [user.id, sponsorId, placement.upline_id, placement.position, packageType],
      );
      const maId = Number(rows[0].id);
      await setAccountDepth(maId);
      await setAccountRankSnapshot(maId, packageType);
      await finalizeNewAccountStructure(maId, Number(user.id));
      await payDirectReferral(sponsorId, user.username, packageType, '', Number(user.id));
      await processPointUpflow(maId, Number(user.id));
      await audit(actor, 'registration', 'ACCOUNT ACTIVATION (CODE)', { pin: pin.pin_code, pkg: packageType });
      return ok({ message: 'Activation Complete! Welcome to the Dashboard.' });
    }

    // Everything below requires an active account
    if (user.activation_status === 'pending') return fail('Account is pending activation.', 403);
    if (!activeAccount) return fail('MLM account record is missing. Please contact the Administrator.', 404);

    /* ---------------- register downline ---------------- */
    if (action === 'register-downline') {
      if (loggedInAsChild) return fail('Registration not available when logged in as a Child Account. Please use the Mother Account.');
      const pin = await one<PinRow>(
        `SELECT * FROM pins WHERE id=$1 AND purchaser_id=$2 AND status='unused' AND is_product=0`,
        [Number(b.pin_id), user.id],
      );
      if (!pin) return fail('Invalid or used Package Code.');

      const fname = String(b.first_name ?? '').trim();
      const mname = String(b.middle_name ?? '').trim();
      const lname = String(b.last_name ?? '').trim();
      // Duplicate name rule: same first+last allowed only with a different middle name
      const dupIds = await q<{ id: number }>(
        `SELECT id FROM users WHERE LOWER(first_name)=LOWER($1) AND LOWER(last_name)=LOWER($2)`,
        [fname, lname],
      );
      for (const d of dupIds) {
        const du = await userById(Number(d.id));
        if ((du?.middle_name ?? '').trim().toLowerCase() === mname.toLowerCase()) {
          return fail(`A member with the name ${fname} ${mname} ${lname} already exists. Same name with same middle name is not allowed.`);
        }
      }

      const sponsorUsername = String(b.sponsor_username ?? '').trim() || user.username;
      const placementUsername = String(b.placement_username ?? '').trim();
      const directUplineId = Number(b.direct_upline_id ?? 0);
      const directPosition = String(b.direct_position ?? '').trim().toUpperCase();
      const viewRootId = Number(b.view_root_account_id ?? 0);

      const res = await registerMember({
        username: String(b.username ?? ''),
        password: String(b.password ?? ''),
        sponsorUsername,
        packageName: pin.package_type,
        pinCode: pin.pin_code,
        firstName: fname,
        middleName: mname,
        lastName: lname,
        email: String(b.email ?? ''),
        phone: String(b.phone ?? ''),
        bday: String(b.bday ?? ''),
        gender: String(b.gender ?? ''),
        ...(placementUsername
          ? { uplineUsername: placementUsername }
          : directUplineId > 0 && ['L', 'C', 'R'].includes(directPosition)
            ? {
                structureOwnerAccountId: Number(activeAccount.id),
                uplineAccountId: directUplineId,
                position: directPosition as 'L' | 'C' | 'R',
              }
            : { structureOwnerAccountId: viewRootId > 0 ? viewRootId : Number(activeAccount.id) }),
        actor: { id: Number(user.id), username: user.username, role: 'member' },
      });
      if (!res.ok) return fail(res.error!);
      return ok({
        message: `SUCCESS! New Member '${res.username}' registered and placed smoothly into the network!`,
        result: res,
      });
    }

    /* ---------------- activate Child Account ---------------- */
    if (action === 'activate-ca') {
      if (loggedInAsChild) return fail('Child Accounts are not allowed to open new Child Accounts.');
      const res = await activateCa({
        userId: Number(user.id),
        caUsername: String(b.ca_user ?? ''),
        caPassword: String(b.ca_pass ?? ''),
        pinId: Number(b.pin_id ?? 0),
        actor: { id: Number(user.id), username: user.username, role: 'member' },
      });
      if (!res.ok) return fail(res.error!);
      return ok({ message: `Child Account '${String(b.ca_user)}' successfully activated into position ${res.slot}!` });
    }

    /* ---------------- upgrade account ---------------- */
    if (action === 'upgrade') {
      // Child Accounts may upgrade their own node (e.g. Starter CA -> Premium);
      // the code must come from the Child Account's own vault (purchaser check below).
      const pin = await one<PinRow>(
        `SELECT * FROM pins WHERE id=$1 AND purchaser_id=$2 AND status='unused' AND is_product=0`,
        [Number(b.pin_id), user.id],
      );
      if (!pin) return fail('Invalid or used package code for upgrade.');
      const res = await upgradeRank(Number(user.id), pin.package_type, pin.pin_code, {
        id: Number(user.id), username: user.username, role: 'member',
      });
      if (!res.ok) return fail(res.error!);
      return ok({ message: `Account upgraded from ${res.from} to ${res.to}! Points differential has been recalculated.` });
    }

    /* ------------- code requests (Product Commission + Unilevel) ------------- */
    if (action === 'request-product-codes' || action === 'request-unilevel-codes') {
      if (loggedInAsChild) return fail('Child Accounts cannot request codes. Please use the Mother Account.');
      const isUni = action === 'request-unilevel-codes';
      // Starter accounts access Product Commission only; Unilevel unlocks on upgrade.
      if (isUni && isStarterRank(user.rank)) return fail('Unilevel is available to Premium and StarPremium accounts. Starter accounts may request Product Codes under Product Commission.');
      const itemId = Number(b.item_id ?? 0);
      const qty = Math.min(50, Math.max(1, Number(b.qty ?? 1)));
      const pkg = await one<PackageRow>('SELECT * FROM packages WHERE id=$1 AND status=1 AND is_product=1', [itemId]);
      if (!pkg) return fail('Please select a product.');
      await q(
        `INSERT INTO orders (user_id, order_details, proof_image, status) VALUES ($1,$2,$3,'pending')`,
        [
          user.id,
          `${isUni ? 'UNILEVEL CODE REQUEST' : 'CODE REQUEST'}: ${qty}x ${pkg.pkg_name}`,
          isUni ? 'Unilevel Code Request - no payment checkout' : 'Product Code Request - no payment checkout',
        ],
      );
      await audit(actor, 'purchase', isUni ? 'REQUEST UNILEVEL CODES' : 'REQUEST PRODUCT CODES', { qty, pkg: pkg.pkg_name });
      return ok({
        message: isUni
          ? `Request submitted! Once Admin approves it, ${qty} Unilevel Code(s) (UNI series) for ${pkg.pkg_name} will be added to your My Products vault.`
          : `Request submitted! Once Admin approves it, ${qty} Product Code(s) (PCC series) for ${pkg.pkg_name} will be added to your My Products vault.`,
      });
    }

    /* ---------------- orders ---------------- */
    if (action === 'order') {
      if (loggedInAsChild) return fail('Child Accounts are not permitted to make purchases.');
      const type = String(b.type ?? 'package');
      const itemId = Number(b.item_id ?? 0);
      const qty = Math.max(1, Number(b.qty ?? 1));
      const mop = String(b.payment_method ?? 'Cash (Walk-in)');
      const pkg = await one<PackageRow>('SELECT * FROM packages WHERE id=$1 AND status=1', [itemId]);
      if (!pkg) return fail('Please select an item to order.');
      if (type === 'product' && Number(pkg.is_product) !== 1) return fail('Selected item is not a retail product.');
      if (type === 'package' && Number(pkg.is_product) !== 0) return fail('Selected item is not a registration package.');

      const autoApprove = settingBool('mlm_sys_auto_approve_products', false) && Number(pkg.is_product) === 1;
      const rows = await q<{ id: number }>(
        `INSERT INTO orders (user_id, order_details, proof_image, status) VALUES ($1,$2,'No Proof Required',$3) RETURNING id`,
        [user.id, `ORDER: ${qty}x ${pkg.pkg_name} | MOP: ${mop}`, autoApprove ? 'approved' : 'pending'],
      );
      const orderId = Number(rows[0].id);
      if (autoApprove) {
        // Starter LP purchases activate immediately (Product Commission Activation).
        let activated = 0;
        for (let i = 0; i < qty; i++) {
          const pinId = await generatePinRow(pkg.pkg_name, true, Number(user.id));
          if (isStarterRank(user.rank)) {
            const pin = await one<PinRow>('SELECT * FROM pins WHERE id=$1', [pinId]);
            if (pin && (await activateProductPin(Number(user.id), pin.pin_code, 'member', Number(user.id))).ok) activated++;
          }
        }
        await audit(actor, 'purchase', 'PRODUCT ORDER (AUTO-APPROVED)', { orderId, qty, pkg: pkg.pkg_name, activated });
        return ok({
          message: activated > 0
            ? `Order approved and activated! ${activated} product(s) activated — Product Commission has been credited to your sponsor as Floating (LP).`
            : `Order approved! ${qty} product code(s) generated and added to your vault. Activate them in My Products to distribute commissions.`,
        });
      }
      await audit(actor, 'purchase', 'SUBMIT ORDER', { orderId, qty, pkg: pkg.pkg_name, type });
      return ok({ message: 'Order submitted successfully! Admin will review your order shortly.' });
    }

    /* ---------------- product activation / transfer ---------------- */
    if (action === 'activate-product' || action === 'transfer-product' || action === 'transfer-pin') {
      if (loggedInAsChild) return fail('Action not permitted for Child Accounts.');
      const isProductAction = action !== 'transfer-pin';
      const pin = await one<PinRow>(
        `SELECT * FROM pins WHERE id=$1 AND purchaser_id=$2 AND status='unused' AND is_product=$3`,
        [Number(b.pin_id), user.id, isProductAction ? 1 : 0],
      );
      if (!pin) return fail('Invalid, already used, or transferred code.');

      if (action === 'activate-product') {
        const targetName = String(b.target ?? '').trim();
        const target: UserRow | null = targetName
          ? await one<UserRow>('SELECT * FROM users WHERE username=$1', [targetName])
          : user;
        if (!target) return fail(`Username '${targetName}' not found.`);
        const res = await activateProductPin(Number(target.id), pin.pin_code, 'member', Number(user.id));
        if (!res.ok) return fail(res.error!);
        return ok({
          message: targetName
            ? `Product Code Activated to '${targetName}'!`
            : `Product ${pin.package_type} activated! Unilevel commissions distributed to your uplines.`,
        });
      }

      const targetName = String(b.target ?? '').trim();
      const target = targetName ? await one<UserRow>('SELECT * FROM users WHERE username=$1', [targetName]) : null;
      if (!target) return fail(`Target username '@${targetName}' not found.`);
      const updated = await exec('UPDATE pins SET purchaser_id=$1 WHERE id=$2 AND purchaser_id=$3 AND status=$4', [
        target.id, pin.id, user.id, 'unused',
      ]);
      if (!updated) return fail('Transfer failed. Code may no longer be available.');
      await audit(actor, 'transfer', isProductAction ? 'TRANSFER PRODUCT CODE' : 'TRANSFER PACKAGE CODE', { pin: pin.pin_code }, { id: Number(target.id), username: target.username });
      return ok({ message: `Code successfully transferred to '${targetName}'.` });
    }

    /* ---------------- encashment ---------------- */
    if (action === 'encash') {
      const ledgerUserId = Number((activeAccount as AccountRow).user_id);
      const idStatus = await memberIdStatus(ledgerUserId);
      if (!idStatus.valid) return fail(`Encashment blocked: ${idStatus.reason}`);
      const res = await requestEncashment({
        userId: ledgerUserId,
        amount: Number(b.amount ?? 0),
        method: String(b.method ?? 'Cash'),
        accountName: String(b.account_name ?? ''),
        accountNumber: String(b.account ?? ''),
      });
      if (!res.ok) return fail(res.error!);
      return ok({ message: 'Encashment requested successfully.', quote: res.quote });
    }

    /* ---------------- profile ---------------- */
    if (action === 'profile') {
      if (loggedInAsChild) return fail('Child Accounts are not permitted to manage profiles.');
      const updates: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const set = (col: string, val: unknown) => { updates.push(`${col}=$${i++}`); params.push(val); };
      set('gender', String(b.gender ?? user.gender ?? ''));
      set('civil', String(b.civil ?? user.civil ?? ''));
      set('bday', String(b.bday ?? user.bday ?? ''));
      set('address', String(b.address ?? user.address ?? ''));
      if (String(b.phone ?? '').trim()) set('phone', String(b.phone).trim());
      if (String(b.email ?? '').trim()) set('email', String(b.email).trim());
      const pic = String(b.profile_picture ?? '');
      if (pic && pic.length <= 400_000) set('profile_picture', pic);
      await exec(`UPDATE users SET ${updates.join(', ')} WHERE id=$${i}`, [...params, user.id]);
      invalidateUser(Number(user.id));

      let message = 'Profile information updated!';
      const newPass = String(b.new_password ?? '');
      const confirmPass = String(b.confirm_password ?? '');
      if (newPass || confirmPass) {
        if (!validAlnumPassword(newPass)) return fail(passwordPolicyMessage());
        if (newPass !== confirmPass) return fail('Passwords do not match. Profile saved but password NOT changed.');
        const { hashPassword } = await import('@/lib/auth');
        await exec('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(newPass), user.id]);
        invalidateUser(Number(user.id));
        message = 'Profile AND Password updated! You will need to log in again.';
      }
      await audit(actor, 'profile', 'UPDATE PROFILE');
      return ok({ message });
    }

    return fail(`Unknown action: ${action}`);
  } catch (e) {
    return err(e);
  }
}
