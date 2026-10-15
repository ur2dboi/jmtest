import { exec, one, q, scalar } from './db';
import { ensureSettings } from './settings';
import { hashPassword } from './auth';
import { phFormat } from './time';
import { maAccountForUser, userById } from './engine/accounts';
import { registerMember, activateCa, generatePins, placeOrder, activateProductPin, upgradeRank } from './engine/registration';
import { requestEncashment, approveEncashment } from './engine/encash';
import { issueMemberId } from './engine/registration';
import { rebuildUnilevelCommissionsScope } from './engine/unilevel';

/* =====================================================================
 * SEEDER — packages, admin gateway, and a demo network built by running
 * the REAL engine (placement + DR + pairing + unilevel), never by
 * inserting fake earnings rows.
 * ===================================================================== */

export interface SeedOptions {
  adminUsername?: string;
  adminPassword?: string;
  demoNetwork?: boolean;
  verbose?: boolean;
}

const PACKAGES: [string, number, string, number][] = [
  ['Starter', 388, 'Entry package — ₱50 Direct Referral on any package sponsored (Starter/Premium/StarPremium), upgradeable to Premium or StarPremium. No pairing points until upgraded.', 0],
  ['Premium', 3598, 'Full compensation: 1 A+B point, Tri-Leg, Unilevel, DR ₱300.', 0],
  ['StarPremium', 8998, 'Top tier: 3 A+B points, 2× Tri-Leg units with StarPremium sources, DR ₱1000.', 0],
  ['Primo Parfum', 350, 'Retail product — activation counts 1 LP toward Unilevel eligibility.', 1],
  ['Extreme Botanic', 350, 'Retail product — activation counts 1 LP toward Unilevel eligibility.', 1],
  ['Extreme Diffuser', 350, 'Retail product — activation counts 1 LP toward Unilevel eligibility.', 1],
];

const log = (msg: string, verbose = true) => {
  if (verbose) console.log(msg);
};

export async function seedDatabase(opts: SeedOptions = {}): Promise<{ ok: boolean; summary: Record<string, unknown> }> {
  const verbose = opts.verbose !== false;
  await ensureSettings(true);

  /* ---------- packages ---------- */
  for (const [name, price, desc, isProduct] of PACKAGES) {
    await exec(
      `INSERT INTO packages (pkg_name, pkg_price, pkg_desc, is_product, status)
       VALUES ($1,$2,$3,$4,1)
       ON CONFLICT DO NOTHING`,
      [name, price, desc, isProduct],
    );
  }
  // pkg_name has no unique constraint; de-duplicate defensively.
  await exec(`
    DELETE FROM packages a USING packages b
    WHERE a.id > b.id AND a.pkg_name = b.pkg_name
  `);
  log('• packages seeded', verbose);

  /* ---------- admin gateway + root account ---------- */
  const adminUsername = opts.adminUsername || process.env.ADMIN_USERNAME || 'MJPREMIUM';
  const adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD || 'adminMJ2026';

  let admin = await one<{ id: number }>('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [adminUsername]);
  if (!admin) {
    const rows = await q<{ id: number }>(
      `INSERT INTO users (username, password_hash, email, display_name, rank, activation_status, is_admin, created_at)
       VALUES ($1,$2,$3,$4,'StarPremium','active',TRUE, now() - interval '120 days') RETURNING id`,
      [adminUsername, await hashPassword(adminPassword), 'admin@mjpremiumcorp.com', 'MJPremium Admin'],
    );
    admin = { id: Number(rows[0].id) };
    log(`• admin created: ${adminUsername} (id ${admin.id})`, verbose);
  } else {
    await exec('UPDATE users SET password_hash = $1, is_admin = TRUE WHERE id = $2', [
      await hashPassword(adminPassword),
      admin.id,
    ]);
    log(`• admin updated: ${adminUsername} (id ${admin.id})`, verbose);
  }

  // The root MA must own account id = 1 — the point-upflow loop stops at id > 1.
  const rootCount = Number((await scalar<string>('SELECT COUNT(*) FROM accounts')) ?? 0);
  if (rootCount === 0) {
    await exec(
      `INSERT INTO accounts (user_id, sponsor_id, upline_id, position, account_type, depth, rank_snapshot, activated_at, status, created_at)
       VALUES ($1,0,0,'L','MA',0,'StarPremium', now() - interval '120 days', 1, now() - interval '120 days')`,
      [admin.id],
    );
    log('• root Mother Account created (id 1)', verbose);
  }
  const rootAccount = (await maAccountForUser(admin.id))!;
  await issueMemberId(admin.id, 5);

  if (!opts.demoNetwork) {
    return { ok: true, summary: { admin: adminUsername, rootAccountId: rootAccount.id, members: 0 } };
  }

  /* ---------- activation codes ---------- */
  const existingPins = Number((await scalar<string>('SELECT COUNT(*) FROM pins')) ?? 0);
  if (existingPins === 0) {
    for (const pkg of ['Starter', 'Premium', 'StarPremium']) {
      await generatePins({ packageType: pkg, count: pkg === 'Premium' ? 40 : 20, purchaserId: admin.id });
    }
    for (const prod of ['Primo Parfum', 'Extreme Botanic', 'Extreme Diffuser']) {
      await generatePins({ packageType: prod, count: 30, isProduct: true, purchaserId: admin.id });
    }
    log('• activation codes generated (110 package + 90 product)', verbose);
  }

  const pinFor = async (pkg: string, product = false) => {
    const row = await one<{ pin_code: string }>(
      `SELECT pin_code FROM pins WHERE status='unused' AND is_product = $1 AND package_type = $2
       ORDER BY id ASC LIMIT 1`,
      [product ? 1 : 0, pkg],
    );
    return row?.pin_code ?? '';
  };

  /* ---------- demo roster (registered through the real engine) ----------
   * Depth matters: a direct child gives NO points to its own parent, so
   * pairing income appears from grandchildren upward.                    */
  const roster: { u: string; pkg: string; sponsor: string; days: number; name: string }[] = [
    // Level 1 — root's direct L / C / R
    { u: 'ana', pkg: 'StarPremium', sponsor: adminUsername, days: 100, name: 'Ana Reyes' },
    { u: 'ben', pkg: 'Premium', sponsor: adminUsername, days: 98, name: 'Ben Santos' },
    { u: 'carl', pkg: 'StarPremium', sponsor: adminUsername, days: 96, name: 'Carl Dela Cruz' },
    // Level 2 — ana's L / C / R
    { u: 'dana', pkg: 'Premium', sponsor: 'ana', days: 90, name: 'Dana Cruz' },
    { u: 'elmo', pkg: 'Premium', sponsor: 'ana', days: 88, name: 'Elmo Ramos' },
    { u: 'fritz', pkg: 'StarPremium', sponsor: 'ana', days: 86, name: 'Fritz Villanueva' },
    // Level 3 — grandchildren create ana's A+B points
    { u: 'gina', pkg: 'Premium', sponsor: 'dana', days: 80, name: 'Gina Bautista' },
    { u: 'hank', pkg: 'StarPremium', sponsor: 'dana', days: 78, name: 'Hank Mendoza' },
    { u: 'iris', pkg: 'Premium', sponsor: 'elmo', days: 76, name: 'Iris Navarro' },
    { u: 'jomar', pkg: 'Premium', sponsor: 'elmo', days: 74, name: 'Jomar Tan' },
    { u: 'oscar', pkg: 'Premium', sponsor: 'fritz', days: 72, name: 'Oscar Lim' },
    { u: 'paula', pkg: 'StarPremium', sponsor: 'fritz', days: 70, name: 'Paula Garcia' },
    // Level 4 — great-grandchildren create dana's A+B points
    { u: 'kate', pkg: 'Premium', sponsor: 'gina', days: 60, name: 'Kate Aquino' },
    { u: 'luis', pkg: 'Premium', sponsor: 'gina', days: 58, name: 'Luis Fernandez' },
    { u: 'mira', pkg: 'StarPremium', sponsor: 'hank', days: 56, name: 'Mira Castillo' },
    { u: 'noel', pkg: 'Premium', sponsor: 'hank', days: 54, name: 'Noel Pascual' },
    { u: 'omar', pkg: 'Premium', sponsor: 'iris', days: 52, name: 'Omar Sison' },
    { u: 'pia', pkg: 'Premium', sponsor: 'jomar', days: 50, name: 'Pia Bernardo' },
    // carl's branch (right-side spillover from root)
    { u: 'quinn', pkg: 'Premium', sponsor: 'carl', days: 48, name: 'Quinn Alvarez' },
    { u: 'rosa', pkg: 'Premium', sponsor: 'carl', days: 46, name: 'Rosa Domingo' },
    { u: 'tony', pkg: 'StarPremium', sponsor: 'carl', days: 44, name: 'Tony Evangelista' },
    { u: 'uma', pkg: 'Premium', sponsor: 'quinn', days: 40, name: 'Ursula Flores' },
    { u: 'vince', pkg: 'Premium', sponsor: 'rosa', days: 38, name: 'Vince Gutierrez' },
    // Starter member (DR only, no points)
    { u: 'wanda', pkg: 'Starter', sponsor: 'ben', days: 36, name: 'Wanda Herrera' },
    { u: 'xander', pkg: 'Starter', sponsor: 'wanda', days: 34, name: 'Xander Ignacio' },
    // recent signups
    { u: 'yara', pkg: 'Premium', sponsor: 'tony', days: 12, name: 'Yara Javier' },
    { u: 'zane', pkg: 'StarPremium', sponsor: 'yara', days: 10, name: 'Zane Kalaw' },
    { u: 'bianca', pkg: 'Premium', sponsor: 'zane', days: 6, name: 'Bianca Lorenzo' },
    { u: 'cedric', pkg: 'Premium', sponsor: 'bianca', days: 4, name: 'Cedric Morales' },
    { u: 'dahlia', pkg: 'StarPremium', sponsor: 'cedric', days: 2, name: 'Dahlia Navarro' },
  ];

  let placed = 0;
  let caDemoDone = false;
  for (const m of roster) {
    const exists = await one<{ id: number }>('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [m.u]);
    if (exists) continue;
    const pin = m.pkg === 'Starter' ? '' : await pinFor(m.pkg);
    const when = new Date(Date.now() - m.days * 86400000);
    const res = await registerMember({
      username: m.u,
      password: 'demo1234',
      sponsorUsername: m.sponsor,
      packageName: m.pkg,
      pinCode: pin,
      firstName: m.name.split(' ')[0],
      lastName: m.name.split(' ').slice(1).join(' '),
      email: `${m.u}@example.com`,
      phone: `0917${String(1000000 + placed).slice(0, 7)}`,
      gender: placed % 2 ? 'Male' : 'Female',
      address: 'San Jose del Monte, Bulacan',
      eventTime: when,
      actor: { id: admin.id, username: adminUsername, role: 'admin' },
    });
    if (res.ok) {
      placed++;
      // Backdate the account so reports and rebuilds replay chronologically.
      await exec('UPDATE accounts SET created_at = $1, activated_at = $1 WHERE id = $2', [when, res.accountId]);
      await exec('UPDATE users SET created_at = $1 WHERE id = $2', [when, res.userId]);
      await exec('UPDATE pins SET created_at = $1, used_at = $1 WHERE used_by = $2', [when, res.userId]);
      await issueMemberId(res.userId!, 3);
    } else {
      log(`  ! ${m.u}: ${res.error}`, verbose);
    }

    // CA separation demo: right after the root trio exists, ana opens CA1
    // (her direct L slot is still free). Later ana-sponsored members then
    // flow under CA1, exactly like the live system.
    if (!caDemoDone && m.u === 'carl') {
      caDemoDone = true;
      const anaRow = await one<{ id: number }>('SELECT id FROM users WHERE username = $1', ['ana']);
      const pinRow = await one<{ id: number }>(
        `SELECT id FROM pins WHERE status='unused' AND is_product=0 AND package_type='Premium' ORDER BY id ASC LIMIT 1`,
      );
      if (anaRow && pinRow) {
        await exec('UPDATE pins SET purchaser_id = $1 WHERE id = $2', [anaRow.id, pinRow.id]);
        const caRes = await activateCa({
          userId: anaRow.id,
          caUsername: 'ana_c1',
          caPassword: 'demo1234',
          pinId: pinRow.id,
          actor: { id: admin.id, username: adminUsername, role: 'admin' },
        });
        log(`• ana: CA1 activated (CA separation demo)${caRes.ok ? '' : ' — ' + caRes.error}`, verbose);
      }
    }
  }
  log(`• demo members registered through the engine: ${placed}`, verbose);

  /* ---------- product activations → Unilevel LP ---------- */
  const productTargets = ['ana', 'ben', 'carl', 'dana', 'elmo', 'fritz', 'gina', 'hank', 'kate', 'luis'];
  for (const uname of productTargets) {
    const u = await one<{ id: number }>('SELECT id FROM users WHERE username = $1', [uname]);
    if (!u) continue;
    const already = Number(
      (await scalar<string>(`SELECT COUNT(*) FROM pins WHERE is_product=1 AND status='used' AND used_by=$1`, [u.id])) ?? 0,
    );
    const need = Math.max(0, 6 - already); // >= 5 LP makes them Unilevel-eligible
    for (let i = 0; i < need; i++) {
      const code = await pinFor(['Primo Parfum', 'Extreme Botanic', 'Extreme Diffuser'][i % 3], true);
      if (!code) break;
      await activateProductPin(u.id, code, 'admin', admin.id);
    }
  }
  log('• product activations recorded (Unilevel LP >= 5 for 10 members)', verbose);

  /* ---------- package + product orders ---------- */
  const orderCount = Number((await scalar<string>('SELECT COUNT(*) FROM orders')) ?? 0);
  if (orderCount === 0) {
    for (const [uname, items] of [
      ['yara', [{ name: 'Primo Parfum', qty: 3, price: 350, isProduct: true }]],
      ['zane', [{ name: 'StarPremium', qty: 1, price: 8998, packageName: 'StarPremium' }]],
      ['bianca', [{ name: 'Extreme Diffuser', qty: 2, price: 350, isProduct: true }]],
      ['cedric', [{ name: 'Premium', qty: 1, price: 3598, packageName: 'Premium' }]],
    ] as [string, { name: string; qty: number; price: number; isProduct?: boolean; packageName?: string }[]][]) {
      const u = await one<{ id: number }>('SELECT id FROM users WHERE username = $1', [uname]);
      if (u) await placeOrder(u.id, items, '');
    }
    await exec(`UPDATE orders SET status='approved' WHERE id % 2 = 0`);
    log('• demo orders created (2 pending, 2 approved)', verbose);
  }

  /* ---------- one paid encashment + one pending ---------- */
  const encashCount = Number(
    (await scalar<string>(`SELECT COUNT(*) FROM ledger WHERE amount < 0 AND note LIKE '%Encashment%'`)) ?? 0,
  );
  if (encashCount === 0) {
    for (const uname of ['ana', 'carl']) {
      const u = await userById(Number((await one<{ id: number }>('SELECT id FROM users WHERE username=$1', [uname]))?.id ?? 0));
      if (!u) continue;
      const balance = Number(u.wallet_balance);
      if (balance < 1000) continue;
      const amount = Math.min(balance, uname === 'ana' ? 2000 : 1000);
      const res = await requestEncashment({
        userId: Number(u.id),
        amount,
        method: uname === 'ana' ? 'GCash' : 'Fund Transfer',
        accountName: u.display_name || u.username,
        accountNumber: uname === 'ana' ? '09171234567' : 'BDO 0034-8821-9902',
      });
      if (res.ok && res.ledgerId && uname === 'ana') {
        await approveEncashment(res.ledgerId, { id: admin.id, username: adminUsername });
      }
    }
    log('• demo encashments created (1 paid, 1 pending)', verbose);
  }

  /* ---------- rank upgrade demo ---------- */
  const wanda = await one<{ id: number; rank: string }>('SELECT id, rank FROM users WHERE username = $1', ['wanda']);
  if (wanda && wanda.rank === 'Starter') {
    const pin = await pinFor('Premium');
    if (pin) {
      await upgradeRank(wanda.id, 'Premium', pin, { id: admin.id, username: adminUsername, role: 'admin' });
      log('• wanda upgraded Starter → Premium', verbose);
    }
  }

  await rebuildUnilevelCommissionsScope(true);

  const summary = {
    members: Number((await scalar<string>('SELECT COUNT(*) FROM users WHERE is_admin = FALSE')) ?? 0),
    accounts: Number((await scalar<string>('SELECT COUNT(*) FROM accounts')) ?? 0),
    ledgerRows: Number((await scalar<string>('SELECT COUNT(*) FROM ledger')) ?? 0),
    pinsUsed: Number((await scalar<string>(`SELECT COUNT(*) FROM pins WHERE status='used'`)) ?? 0),
    orders: Number((await scalar<string>('SELECT COUNT(*) FROM orders')) ?? 0),
    totalPaid: Number(
      (await scalar<string>(
        `SELECT COALESCE(SUM(amount),0)::text FROM ledger WHERE amount > 0 AND type='cash'`,
      )) ?? 0,
    ),
    seededAt: phFormat(new Date(), 'Y-m-d H:i:s'),
  };
  log(`• summary: ${JSON.stringify(summary)}`, verbose);
  return { ok: true, summary };
}
