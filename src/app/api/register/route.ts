import { exec, one, q } from '@/lib/db';
import { ensureSettings } from '@/lib/settings';
import { hashPassword, setSessionCookie, validAlnumPassword, passwordPolicyMessage } from '@/lib/auth';
import { audit, body, err, fail, ok } from '@/lib/http';
import { generatePinRow } from '@/lib/order-actions';
import { ensureMemberIdNumber } from '@/lib/engine/accounts';
import type { PackageRow, UserRow } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

/**
 * POST /api/register — public registration wizard (mlm_register_form).
 * Creates a PENDING member + a locked (pending_payment) activation code +
 * a registration order. Admin approval unlocks the code; the member then
 * activates from the pending screen and is placed under the sponsor.
 */
export async function POST(req: Request) {
  try {
    await ensureSettings();
    const b = await body<Record<string, string>>(req);
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    const sponsorUsername = String(b.sponsor ?? '').trim();
    const pkgName = String(b.package_name ?? '').trim();
    const variant = String(b.variant ?? '').trim();

    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      return fail('Username must be 3–32 characters (letters, numbers, dot, dash, underscore).');
    }
    if (!validAlnumPassword(password)) return fail(passwordPolicyMessage());
    if (!pkgName) return fail('Please select a package.');

    const exists = await one<{ id: number }>('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (exists) return fail('Username already taken. Please choose another.');

    const email = String(b.email ?? '').trim() || `${username}@mjpremium.local`;
    const emailUsed = await one<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
    if (emailUsed && String(b.email ?? '').trim()) return fail('Email address is already in use.');

    const sponsor = sponsorUsername
      ? await one<UserRow>('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [sponsorUsername])
      : null;
    if (!sponsor) return fail('Sponsor Username not found.');
    if (sponsor.activation_status !== 'active') return fail('Sponsor account is not active yet.');

    const pkg = await one<PackageRow>(
      `SELECT * FROM packages WHERE pkg_name = $1 AND status = 1 AND is_product = 0`,
      [pkgName],
    );
    if (!pkg) return fail('Selected package is not available.');

    const firstName = String(b.first_name ?? '').trim();
    const lastName = String(b.last_name ?? '').trim();
    const fullName = `${firstName} ${String(b.middle_name ?? '').trim()} ${lastName}`.replace(/\s+/g, ' ').trim();

    const rows = await q<{ id: number }>(
      `INSERT INTO users
         (username, password_hash, email, display_name, first_name, middle_name, last_name, phone, bday,
          rank, activation_status, is_admin, sponsor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',FALSE,$11) RETURNING id`,
      [
        username,
        await hashPassword(password),
        email,
        fullName || username,
        firstName,
        String(b.middle_name ?? '').trim(),
        lastName,
        String(b.phone ?? '').trim(),
        String(b.bday ?? '').trim(),
        pkg.pkg_name,
        Number(sponsor.id),
      ],
    );
    const newUserId = Number(rows[0].id);
    await ensureMemberIdNumber(newUserId);

    // Locked activation code + registration order (admin unlocks on approval)
    const pinId = await generatePinRow(pkg.pkg_name, false, newUserId);
    const pin = await one<{ pin_code: string }>('SELECT pin_code FROM pins WHERE id = $1', [pinId]);
    await exec(`UPDATE pins SET status='pending_payment' WHERE id = $1`, [pinId]);
    await q(
      `INSERT INTO orders (user_id, order_details, proof_image, status) VALUES ($1,$2,'No Proof Required','pending')`,
      [newUserId, `REGISTRATION: ${pkg.pkg_name} (${variant || 'Standard'}) | Code: ${pin?.pin_code ?? ''}`],
    );

    const user = await one<UserRow>('SELECT * FROM users WHERE id = $1', [newUserId]);
    if (user) {
      await setSessionCookie({ uid: newUserId, u: username, r: 'member' });
      await audit({ user, role: 'member' }, 'registration', 'PUBLIC REGISTRATION', { pkg: pkg.pkg_name, variant });
    }
    return ok({ redirect: '/member-portal', username });
  } catch (e) {
    return err(e);
  }
}
