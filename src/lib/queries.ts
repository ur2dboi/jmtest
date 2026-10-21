import { createHash } from 'crypto';
import { exec, one, q, scalar } from './db';
import { phFormat, phMonthKey } from './time';
import { ensureSettings, setting, settingBool, settingInt, settingNum, unilevelMatrix } from '../lib/settings';
import type { AccountRow, LedgerRow, OrderRow, PackageRow, PinRow, UserRow } from './types';
import {
  accountById,
  getUnilevelLp,
  isCA,
  isFreeAccountUser,
  isStarRank,
  isStarterRank,
  liveDownlineCount,
  maAccountForUser,
  memberDisplayRank,
  memberIdStatus,
  num,
  primaryAccountForUser,
  resyncWallet,
  unilevelMonthlyResetOn,
  userById,
} from './engine/accounts';
import { firstRowsComplete, legMetricDownlineCount } from './engine/placement';
import { releaseMaturedUnilevelCommissions } from './engine/unilevel';
import { getTreeCells, type TreeCell } from './engine/tree';

/* =====================================================================
 * READ MODELS for the member portal + admin command center.
 * Ports the data assembly of mlm_member_portal / mlm_custom_admin_dashboard.
 * ===================================================================== */

export interface EarningsBreakdown {
  dr: number;
  pairingReleased: number;
  pairingHang: number;
  tri: number;
  unilevel: number;
  unilevelPendingCutoff: number;
  productComm: number;
  productCommPending: number;
  gc: number;
  totalEarned: number;
  pendingEncash: number;
  totalEncashed: number;
  balance: number;
  wallet: number;
}

export async function earningsFor(userId: number): Promise<EarningsBreakdown> {
  const uid = Number(userId);
  // Single aggregate pass over the member's ledger (was 9 sequential sums).
  const agg = await one<{
    dr: string; pairing_released: string; pairing_hang: string; tri: string;
    unilevel: string; unilevel_pending: string; product_comm: string; product_comm_pending: string; gc: string;
    pending_encash: string; total_encashed: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN note LIKE '%Direct Referral%' AND type='cash' THEN amount ELSE 0 END),0)::text AS dr,
       COALESCE(SUM(CASE WHEN note LIKE '%A+B%' AND type='cash' AND status='released' THEN amount ELSE 0 END),0)::text AS pairing_released,
       COALESCE(SUM(CASE WHEN note LIKE '%A+B%' AND type='cash' AND status='hang' THEN amount ELSE 0 END),0)::text AS pairing_hang,
       COALESCE(SUM(CASE WHEN note LIKE '%Tri-Leg%' AND type='cash' THEN amount ELSE 0 END),0)::text AS tri,
       COALESCE(SUM(CASE WHEN note LIKE '%Unilevel%' AND note NOT LIKE '%Product Comm%' AND status NOT IN ('hang','forfeited') THEN amount ELSE 0 END),0)::text AS unilevel,
       COALESCE(SUM(CASE WHEN note LIKE '%Unilevel%' AND note NOT LIKE '%Product Comm%' AND status='hang' THEN amount ELSE 0 END),0)::text AS unilevel_pending,
       COALESCE(SUM(CASE WHEN note LIKE '%Product Comm%' AND status NOT IN ('hang','forfeited') THEN amount ELSE 0 END),0)::text AS product_comm,
       COALESCE(SUM(CASE WHEN note LIKE '%Product Comm%' AND status='hang' THEN amount ELSE 0 END),0)::text AS product_comm_pending,
       COALESCE(SUM(CASE WHEN type='gc' THEN amount ELSE 0 END),0)::text AS gc,
       COALESCE(SUM(CASE WHEN note LIKE '%Encashment%' AND note LIKE '%Pending%' AND note NOT LIKE '%REJECTED%' AND note NOT LIKE '%APPROVED%' THEN ABS(amount) ELSE 0 END),0)::text AS pending_encash,
       COALESCE(SUM(CASE WHEN note LIKE '%Encashment%' AND (note LIKE '%APPROVED%' OR note LIKE '%APPROVED & PAID%') AND note NOT LIKE '%REJECTED%' THEN ABS(amount) ELSE 0 END),0)::text AS total_encashed
     FROM ledger WHERE user_id = $1`,
    [uid],
  );
  const dr = num(agg?.dr);
  const pairingReleased = num(agg?.pairing_released);
  const pairingHang = num(agg?.pairing_hang);
  const tri = num(agg?.tri);
  const unilevel = num(agg?.unilevel);
  const unilevelPendingCutoff = num(agg?.unilevel_pending);
  const productComm = num(agg?.product_comm);
  const productCommPending = num(agg?.product_comm_pending);
  const gc = Math.trunc(num(agg?.gc));
  const pendingEncash = num(agg?.pending_encash);
  const totalEncashed = num(agg?.total_encashed);
  const totalEarned = dr + pairingReleased + tri + unilevel + productComm;
  const user = await userById(uid);
  return {
    dr,
    pairingReleased,
    pairingHang,
    tri,
    unilevel,
    unilevelPendingCutoff,
    productComm,
    productCommPending,
    gc,
    totalEarned,
    pendingEncash,
    totalEncashed,
    balance: Math.max(0, totalEarned - pendingEncash - totalEncashed),
    wallet: num(user?.wallet_balance),
  };
}

export interface MemberPortalData {
  user: UserRow;
  ma: AccountRow | null;
  cas: AccountRow[];
  accounts: { ma: AccountRow | null; cas: AccountRow[] };
  activeAccount: AccountRow;
  isChildLogin: boolean;
  earnings: EarningsBreakdown;
  downlineCount: number;
  legCounts: { A: number; B: number; C: number };
  lp: number;
  lpEligible: boolean;
  idStatus: Awaited<ReturnType<typeof memberIdStatus>>;
  canUpgrade: boolean;
  upgradePins: PinRow[];
  packagePins: PinRow[];
  productPins: PinRow[];
  vaultCounts: { packages: number; products: number; premium: number; starpremium: number; all: number; activatedThisMonth: number };
  packages: PackageRow[];
  products: PackageRow[];
  ledger: LedgerRow[];
  encashLedger: LedgerRow[];
  orders: OrderRow[];
  codeRequests: OrderRow[];
  unilevelCodeRequests: OrderRow[];
  selfActivatedProducts: (PinRow & { recipient?: string })[];
  adminActivatedProducts: PinRow[];
  gateComplete: boolean;
  maintenance: boolean;
  starterBenefits: { dr: number; productCommPerBottle: number };
  unilevelDetail: { rates: number[]; levelTotals: { level: number; count: number; total: number }[]; rows: LedgerRow[] };
  productCommDetail: { perBottle: number; bottles: number; rows: LedgerRow[] };
}

/** Resolve the logged-in member's MA + CA nodes and the active node. */
export async function resolveMemberAccounts(
  userId: number,
  activeNode: string,
): Promise<{
  primary: AccountRow | null;
  ma: AccountRow | null;
  cas: AccountRow[];
  active: AccountRow | null;
  isChildLogin: boolean;
  effectiveNode: string;
}> {
  const primary = await primaryAccountForUser(Number(userId));
  let ma: AccountRow | null = null;
  let cas: AccountRow[] = [];
  let active: AccountRow | null = primary;
  let isChildLogin = false;
  let effectiveNode = 'MA';

  if (primary && isCA(primary.account_type)) {
    isChildLogin = true;
    const { resolveParentMaForCa } = await import('./engine/accounts');
    ma = await resolveParentMaForCa(primary);
    if (ma) {
      cas = await q<AccountRow>(
        `SELECT * FROM accounts WHERE upline_id = $1 AND account_type='CA'
         ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
        [ma.id],
      );
    }
    active = primary;
    effectiveNode =
      primary.position === 'L' ? 'C_L' : primary.position === 'C' ? 'C_C' : 'C_R';
  } else {
    ma = primary;
    if (ma) {
      cas = await q<AccountRow>(
        `SELECT * FROM accounts WHERE upline_id = $1 AND account_type='CA'
         ORDER BY CASE position WHEN 'L' THEN 0 WHEN 'C' THEN 1 ELSE 2 END, id ASC`,
        [ma.id],
      );
      if (activeNode && activeNode !== 'MA') {
        const match = cas.find((c) => `C_${c.position}` === activeNode);
        if (match) {
          active = match;
          effectiveNode = activeNode;
        }
      }
    }
  }
  return { primary, ma, cas, active, isChildLogin, effectiveNode };
}

export async function memberPortalData(userId: number, activeNode: string): Promise<MemberPortalData | null> {
  // Monthly settlement (1st of the month): matured Floating (LP)
  // commissions move into wallet/earnings. Idempotent; no-op mid-month.
  await ensureSettings();
  await releaseMaturedUnilevelCommissions();
  const user = await userById(Number(userId));
  if (!user) return null;
  const { ma, cas, active, isChildLogin } = await resolveMemberAccounts(userId, activeNode);
  if (!active) return null;

  const ledgerUserId = Number(active.user_id);
  const earnings = await earningsFor(ledgerUserId);
  const downlineCount = await liveDownlineCount(Number(active.id));
  const [legA, legB, legC] = await Promise.all([
    legMetricDownlineCount(Number(active.id), 'L'),
    legMetricDownlineCount(Number(active.id), 'C'),
    legMetricDownlineCount(Number(active.id), 'R'),
  ]);

  const packages = await q<PackageRow>(`SELECT * FROM packages WHERE status=1 AND is_product=0 ORDER BY pkg_price ASC`);
  const products = await q<PackageRow>(`SELECT * FROM packages WHERE status=1 AND is_product=1 ORDER BY pkg_price ASC`);
  const allPackages = await q<PackageRow>(`SELECT * FROM packages WHERE is_product=0 ORDER BY pkg_price ASC`);
  void allPackages;

  const packagePins = await q<PinRow>(
    `SELECT * FROM pins WHERE purchaser_id=$1 AND status='unused' AND is_product=0 ORDER BY id DESC`,
    [userId],
  );
  const productPins = await q<PinRow>(
    `SELECT * FROM pins WHERE purchaser_id=$1 AND status='unused' AND is_product=1 ORDER BY id DESC`,
    [userId],
  );

  const rankNorm = (user.rank || '').replace(/\s+/g, '').toLowerCase();
  // Child Accounts may upgrade their own node too (e.g. a Starter CA using a
  // Premium/StarPremium code from its own vault); other CA actions stay MA-only.
  const canUpgrade = rankNorm.includes('starter') || (rankNorm.includes('premium') && !rankNorm.includes('starpremium'));
  const upgradePins = canUpgrade
    ? rankNorm.includes('starter')
      ? await q<PinRow>(
          `SELECT * FROM pins WHERE purchaser_id=$1 AND status='unused' AND is_product=0 AND LOWER(package_type) LIKE '%premium%' AND LOWER(package_type) NOT LIKE '%starter%' ORDER BY id ASC`,
          [userId],
        )
      : await q<PinRow>(
          `SELECT * FROM pins WHERE purchaser_id=$1 AND status='unused' AND is_product=0 AND LOWER(package_type) LIKE '%starpremium%' ORDER BY id ASC`,
          [userId],
        )
    : [];

  const unilevelRows = await q<LedgerRow>(
    `SELECT * FROM ledger WHERE user_id=$1 AND note LIKE 'Unilevel Comm%' ORDER BY id DESC LIMIT 100`,
    [userId],
  );
  const unilevelLevelRows = await q<{ lvl: number; cnt: number; total: string }>(
    `SELECT COALESCE((regexp_match(note, 'Compressed Level ([0-9]+)'))[1]::int, 0) AS lvl,
            COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0)::text AS total
       FROM ledger WHERE user_id=$1 AND note LIKE 'Unilevel Comm%' AND status <> 'forfeited' GROUP BY 1 ORDER BY 1`,
    [userId],
  );
  const productCommRows = await q<LedgerRow>(
    `SELECT * FROM ledger WHERE user_id=$1 AND note LIKE 'Product Comm%' ORDER BY id DESC LIMIT 100`,
    [userId],
  );
  const productCommBottles = Number(
    (await scalar<string>(
      `SELECT COALESCE(SUM((regexp_match(note, 'Qty: ([0-9]+)'))[1]::int), 0)
         FROM ledger WHERE user_id=$1 AND note LIKE 'Product Comm%'`,
      [userId],
    )) ?? 0,
  );

  const ledger = await q<LedgerRow>(
    `SELECT * FROM ledger WHERE user_id=$1
       AND ((amount > 0 AND type='cash' AND status<>'hang') OR type='gc' OR (type='hang' AND status='hang')
            OR ((note LIKE '%Unilevel%' OR note LIKE '%Product Comm%') AND status='hang') OR note LIKE '%Flush Out%')
       AND note NOT LIKE '%Encashment%' AND note NOT LIKE '%Refund%'
     ORDER BY created_at DESC, id DESC LIMIT 500`,
    [ledgerUserId],
  );
  const encashLedger = await q<LedgerRow>(
    `SELECT * FROM ledger WHERE user_id=$1 AND note LIKE '%Encashment%' ORDER BY id DESC LIMIT 200`,
    [ledgerUserId],
  );
  const orders = await q<OrderRow>(`SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [userId]);
  const codeRequests = await q<OrderRow>(
    `SELECT * FROM orders WHERE user_id=$1 AND order_details LIKE 'CODE REQUEST:%' ORDER BY id DESC LIMIT 20`,
    [userId],
  );
  const unilevelCodeRequests = await q<OrderRow>(
    `SELECT * FROM orders WHERE user_id=$1 AND order_details LIKE 'UNILEVEL CODE REQUEST:%' ORDER BY id DESC LIMIT 20`,
    [userId],
  );

  const selfActivated = await q<PinRow & { recipient_id: number }>(
    `SELECT p.*, p.used_by AS recipient_id FROM pins p
     WHERE p.is_product=1 AND p.status='used'
       AND ((p.activation_source='member' AND (p.purchaser_id=$1 OR p.activated_by_user_id=$1))
            OR (p.activation_source IS NULL AND p.purchaser_id=$1))
     ORDER BY p.used_at DESC NULLS LAST, p.id DESC LIMIT 50`,
    [userId],
  );
  const selfActivatedProducts = await Promise.all(
    selfActivated.map(async (p) => {
      const r = p.used_by ? await userById(Number(p.used_by)) : null;
      return { ...p, recipient: r ? `@${r.username}` : '' };
    }),
  );
  const adminActivatedProducts = await q<PinRow>(
    `SELECT * FROM pins WHERE purchaser_id=$1 AND is_product=1 AND status='used' AND activation_source='admin'
     ORDER BY used_at DESC NULLS LAST, id DESC LIMIT 50`,
    [userId],
  );

  const monthKey = phMonthKey();
  const activatedThisMonth = num(
    (await scalar<string>(
      `SELECT COUNT(*) FROM pins WHERE purchaser_id=$1 AND status='used' AND is_product=0
         AND to_char(used_at AT TIME ZONE 'Asia/Manila','YYYY-MM') = $2`,
      [userId, monthKey],
    )) ?? 0,
  );

  return {
    user,
    ma,
    cas,
    accounts: { ma, cas },
    activeAccount: active,
    isChildLogin,
    earnings,
    downlineCount,
    legCounts: { A: legA, B: legB, C: legC },
    lp: await getUnilevelLp(Number(userId)),
    lpEligible: (await getUnilevelLp(Number(userId))) >= 5,
    idStatus: await memberIdStatus(Number(userId)),
    canUpgrade,
    upgradePins,
    packagePins,
    productPins,
    vaultCounts: {
      packages: packagePins.length,
      products: productPins.length,
      premium: packagePins.filter((p) => /premium/i.test(p.package_type) && !/starpremium/i.test(p.package_type.replace(/\s/g, ''))).length,
      starpremium: packagePins.filter((p) => /starpremium/i.test(p.package_type.replace(/\s/g, ''))).length,
      all: packagePins.length + productPins.length,
      activatedThisMonth,
    },
    packages,
    products,
    ledger,
    encashLedger,
    orders,
    codeRequests,
    unilevelCodeRequests,
    selfActivatedProducts,
    adminActivatedProducts,
    gateComplete: ma ? await firstRowsComplete(Number(ma.id)) : false,
    maintenance: setting('mlm_maintenance_mode') === '1',
    unilevelDetail: {
      rates: unilevelMatrix(),
      levelTotals: unilevelLevelRows.map((r) => ({ level: Number(r.lvl), count: Number(r.cnt), total: num(r.total) })),
      rows: unilevelRows,
    },
    productCommDetail: {
      perBottle: settingNum('mlm_sys_product_comm_starter', 20),
      bottles: productCommBottles,
      rows: productCommRows,
    },
    starterBenefits: {
      dr: settingNum('mlm_sys_dr_starter', 50),
      productCommPerBottle: settingNum('mlm_sys_product_comm_starter', 20),
    },
  };
}

/* ------------------------- orders helpers ------------------------- */

export function orderIsProduct(orderDetails: string, packagesByName: Map<string, PackageRow>): boolean {
  const m = /ORDER:\s*\d+x\s*(.+?)(?:\s*\||$)/.exec(orderDetails || '');
  if (!m) return false;
  const pkg = packagesByName.get(m[1].trim());
  return !!pkg && Number(pkg.is_product) === 1;
}

export function orderIsFreeAccountSale(orderDetails: string, user: UserRow | null): boolean {
  const details = String(orderDetails ?? '');
  if (/FREE ACCOUNT:/i.test(details)) return true;
  if (user && isFreeAccountUser(user) && /REGISTRATION:/i.test(details) && /Admin Encoded/i.test(details)) return true;
  return false;
}

export function orderSalesAmount(
  orderDetails: string,
  packagesByName: Map<string, number>,
  user: UserRow | null,
): number {
  const details = String(orderDetails ?? '');
  if (orderIsFreeAccountSale(details, user)) return 0;
  let qty = 1;
  let name = '';
  let m = /ORDER:\s*(\d+)x\s*(.+?)(?:\s*\||$)/.exec(details);
  if (m) {
    qty = Math.max(1, Number(m[1]));
    name = m[2].trim();
  } else if ((m = /REGISTRATION:\s*(.+?)(?:\s*\(|\s*\||$)/.exec(details))) {
    name = m[1].trim();
  } else if ((m = /DASHBOARD ORDER\s*\|\s*Pkg:\s*(.+?)(?:\s*\||$)/.exec(details))) {
    name = m[1].trim();
  }
  name = name.replace(/^\d+x\s*/, '').trim();
  const price = packagesByName.get(name);
  return price ? price * qty : 0;
}

export function orderSalesItemName(orderDetails: string): string {
  const details = String(orderDetails ?? '');
  let m = /ORDER:\s*(\d+)x\s*(.+?)(?:\s*\||$)/.exec(details);
  if (m) return `${m[1]}x ${m[2].trim()}`;
  m = /REGISTRATION:\s*(.+?)(?:\s*\||$)/.exec(details);
  if (m) return `REGISTRATION: ${m[1].trim()}`;
  return details.replace(/\s*\|\s*Code:.*$/, '');
}

export async function packagesByName(): Promise<Map<string, PackageRow>> {
  const rows = await q<PackageRow>('SELECT * FROM packages');
  return new Map(rows.map((r) => [r.pkg_name, r]));
}
export async function packagePriceMap(): Promise<Map<string, number>> {
  const rows = await q<PackageRow>('SELECT pkg_name, pkg_price FROM packages');
  return new Map(rows.map((r) => [r.pkg_name, num(r.pkg_price)]));
}

/* ------------------------- admin overview ------------------------- */

export interface AdminOverview {
  totalSales: number;
  totalPayouts: number;
  grossIncome: number;
  memberCount: number;
  premiumCount: number;
  starpremiumCount: number;
  payables: { total: number; uncashed: number; floating: number; rows: PayableRow[] };
  pendingOrders: number;
  pendingPkgOrders: number;
  pendingProdOrders: number;
  pendingPayouts: number;
  alertCount: number;
}

export interface PayableRow {
  user_id: number;
  username: string;
  available: number;
  earned: number;
  deducted: number;
  category: 'Uncashed' | 'Floating Payout';
}

export async function adminOverview(): Promise<AdminOverview> {
  await ensureSettings();
  const priceMap = await packagePriceMap();
  const byName = await packagesByName();

  const approved = await q<OrderRow>(`SELECT * FROM orders WHERE status='approved'`);
  let totalSales = 0;
  for (const o of approved) {
    const u = await userById(Number(o.user_id));
    totalSales += orderSalesAmount(o.order_details, priceMap, u);
  }
  const totalPayouts = num(
    (await scalar<string>(`SELECT COALESCE(SUM(ABS(amount)),0) FROM ledger WHERE amount < 0 AND note LIKE '%APPROVED%PAID%'`)) ?? 0,
  );

  const users = await q<UserRow>('SELECT * FROM users');
  let premiumCount = 0;
  let starpremiumCount = 0;
  for (const u of users) {
    const rank = memberDisplayRank(u, u.rank);
    if (isStarRank(rank)) starpremiumCount++;
    else if (/premium/i.test(rank)) premiumCount++;
  }

  const minEncash = num(settingInt('mlm_sys_min_encash', 1000));
  const payables: PayableRow[] = [];
  let payTotal = 0;
  let payUncashed = 0;
  let payFloating = 0;
  const ledgerUsers = await q<{ user_id: number; earned: string; deducted: string }>(
    `SELECT user_id,
            COALESCE(SUM(CASE WHEN amount>0 AND type='cash' AND status NOT IN ('hang','forfeited') AND note NOT LIKE '%Encashment%' THEN amount ELSE 0 END),0)::text AS earned,
            COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0)::text AS deducted
     FROM ledger GROUP BY user_id`,
  );
  for (const r of ledgerUsers) {
    const uid = Number(r.user_id);
    const earned = num(r.earned);
    const deducted = num(r.deducted);
    const available = Math.max(0, earned - deducted);
    if (available <= 0) continue;
    const u = await userById(uid);
    const category = available >= minEncash ? 'Uncashed' : 'Floating Payout';
    payables.push({ user_id: uid, username: u?.username ?? `#${uid}`, available, earned, deducted, category });
    payTotal += available;
    if (category === 'Uncashed') payUncashed += available;
    else payFloating += available;
  }
  payables.sort((a, b) => b.available - a.available);

  const pending = await q<OrderRow>(`SELECT * FROM orders WHERE status='pending' ORDER BY id ASC`);
  let pkgCount = 0;
  let prodCount = 0;
  for (const o of pending) (orderIsProduct(o.order_details, byName) ? prodCount++ : pkgCount++);

  const pendingPayouts = num(
    (await scalar<string>(
      `SELECT COUNT(*) FROM ledger WHERE amount < 0 AND (note LIKE '%Pending Admin Approval%' OR (note LIKE '%Encashment%' AND note LIKE '%Pending%' AND note NOT LIKE '%APPROVED%' AND note NOT LIKE '%REJECTED%'))`,
    )) ?? 0,
  );

  const alerts = await detectEarningAlerts();
  return {
    totalSales,
    totalPayouts,
    grossIncome: totalSales - totalPayouts,
    memberCount: users.length,
    premiumCount,
    starpremiumCount,
    payables: { total: payTotal, uncashed: payUncashed, floating: payFloating, rows: payables },
    pendingOrders: pending.length,
    pendingPkgOrders: pkgCount,
    pendingProdOrders: prodCount,
    pendingPayouts,
    alertCount: alerts.length,
  };
}

/* ------------------------- leaderboards / reports ------------------------- */

export async function leaderboards(start: string, end: string) {
  const earners = await q<{ user_id: number; total: string }>(
    `SELECT user_id,
            (COALESCE(SUM(CASE WHEN amount>0 AND type='cash' AND status NOT IN ('hang','forfeited') AND note NOT LIKE '%Refund%' THEN amount ELSE 0 END),0)
             + COALESCE(SUM(CASE WHEN type='hang' AND status='hang' THEN amount ELSE 0 END),0))::text AS total
     FROM ledger WHERE created_at::date >= $1::date AND created_at::date <= $2::date
     GROUP BY user_id ORDER BY total DESC LIMIT 10`,
    [start, end],
  );
  const encash = await q<{ user_id: number; total: string }>(
    `SELECT user_id, SUM(ABS(amount))::text AS total FROM ledger
     WHERE amount < 0 AND note LIKE '%APPROVED & PAID%' AND created_at::date >= $1::date AND created_at::date <= $2::date
     GROUP BY user_id ORDER BY total DESC LIMIT 10`,
    [start, end],
  );
  const sponsors = await q<{ user_id: number; total: string }>(
    `SELECT a.sponsor_id AS user_id, COUNT(a.id)::text AS total
     FROM accounts a JOIN users u ON a.user_id = u.id
     WHERE u.created_at::date >= $1::date AND u.created_at::date <= $2::date AND a.sponsor_id > 0
     GROUP BY a.sponsor_id ORDER BY total DESC LIMIT 10`,
    [start, end],
  );
  const orders = await q<{ user_id: number; order_details: string }>(
    `SELECT user_id, order_details FROM orders WHERE status='approved' AND created_at::date >= $1::date AND created_at::date <= $2::date`,
    [start, end],
  );
  const buyers = new Map<number, number>();
  for (const o of orders) {
    const m = /ORDER:\s*(\d+)x/.exec(o.order_details);
    const qty = m ? Number(m[1]) : 1;
    buyers.set(Number(o.user_id), (buyers.get(Number(o.user_id)) ?? 0) + qty);
  }
  const topBuyers = Array.from(buyers.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([user_id, total]) => ({ user_id, total: String(total) }));

  const withNames = async (rows: { user_id: number; total: string }[]) =>
    Promise.all(
      rows.map(async (r) => ({
        user_id: Number(r.user_id),
        username: (await userById(Number(r.user_id)))?.username ?? `#${r.user_id}`,
        total: num(r.total),
      })),
    );

  return {
    earners: await withNames(earners),
    encash: await withNames(encash),
    sponsors: await withNames(sponsors),
    buyers: await withNames(topBuyers),
  };
}

export async function salesReport(start: string, end: string) {
  const priceMap = await packagePriceMap();
  const rows = await q<OrderRow>(
    `SELECT * FROM orders WHERE status='approved' AND created_at::date >= $1::date AND created_at::date <= $2::date ORDER BY created_at DESC`,
    [start, end],
  );
  const out = [];
  let total = 0;
  for (const r of rows) {
    const u = await userById(Number(r.user_id));
    const amount = orderSalesAmount(r.order_details, priceMap, u);
    total += amount;
    const code = /Code:\s*([A-Z0-9]+)/.exec(r.order_details)?.[1] ?? 'N/A';
    out.push({ ...r, username: u?.username ?? 'Unknown', item: orderSalesItemName(r.order_details), code, amount });
  }
  return { rows: out, total };
}

export async function encashReport(start: string, end: string) {
  const rows = await q<LedgerRow>(
    `SELECT * FROM ledger WHERE note LIKE '%APPROVED & PAID%' AND amount < 0
       AND created_at::date >= $1::date AND created_at::date <= $2::date ORDER BY created_at DESC`,
    [start, end],
  );
  const out = [];
  let totalNet = 0;
  for (const r of rows) {
    const u = await userById(Number(r.user_id));
    const gross = Math.abs(num(r.amount));
    const fees = num(r.tax_deducted) + num(r.fee_deducted);
    const net = gross - fees;
    totalNet += net;
    out.push({ ...r, username: u?.username ?? 'Unknown', gross, fees, net });
  }
  return { rows: out, totalNet };
}

/* ------------------------- system alerts ------------------------- */

export interface AdminAlert {
  level: 'critical' | 'warning';
  title: string;
  message: string;
  action: string;
}

export async function detectEarningAlerts(): Promise<AdminAlert[]> {
  const alerts: AdminAlert[] = [];

  const dupCount = num(
    (await scalar<string>(
      `SELECT COUNT(*) FROM (SELECT upline_id, position, COUNT(*) c FROM accounts WHERE upline_id > 0 GROUP BY upline_id, position HAVING COUNT(*) > 1) x`,
    )) ?? 0,
  );
  if (dupCount > 0) {
    alerts.push({
      level: 'critical',
      title: 'Duplicate genealogy placement slots detected',
      message: `${dupCount} upline/position slot(s) have more than one account. This can create wrong points or commissions.`,
      action: 'Review Genealogy / Network Override before recalculating.',
    });
  }

  // Wallet mismatch — one grouped pass over the ledger joined to users.
  const walletRows = await q<{ username: string; wallet: string; earned: string; withdrawn: string }>(
    `SELECT u.username,
            COALESCE(u.wallet_balance,0)::text AS wallet,
            COALESCE(SUM(CASE WHEN l.amount>0 AND l.type='cash' AND l.status NOT IN ('hang','forfeited') AND l.note NOT LIKE '%Encashment%' THEN l.amount ELSE 0 END),0)::text AS earned,
            COALESCE(SUM(CASE WHEN l.amount<0 THEN ABS(l.amount) ELSE 0 END),0)::text AS withdrawn
     FROM ledger l JOIN users u ON u.id = l.user_id
     GROUP BY u.id, u.username, u.wallet_balance`,
  );
  let mismatches = 0;
  const examples: string[] = [];
  for (const r of walletRows) {
    const expected = Math.max(0, num(r.earned) - num(r.withdrawn));
    if (Math.abs(num(r.wallet) - expected) > 0.05) {
      mismatches++;
      if (examples.length < 5) examples.push(`@${r.username} wallet ${num(r.wallet).toFixed(2)} vs ledger ${expected.toFixed(2)}`);
    }
  }
  if (mismatches > 0) {
    alerts.push({
      level: 'warning',
      title: 'Wallet balance mismatch detected',
      message: `${mismatches} member wallet(s) do not match ledger totals.${examples.length ? ' Examples: ' + examples.join('; ') : ''}`,
      action: 'Run Start Batch Recalculate or wallet resync.',
    });
  }

  // Unilevel paid to currently-ineligible members
  const periodFilter = unilevelMonthlyResetOn()
    ? `AND to_char(created_at AT TIME ZONE 'Asia/Manila','YYYY-MM') = '${phMonthKey()}'`
    : '';
  const uniUsers = await q<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM ledger WHERE note LIKE '%Unilevel Comm%' ${periodFilter}`,
  );
  let badUni = 0;
  const badExamples: string[] = [];
  for (const r of uniUsers) {
    const uid = Number(r.user_id);
    if (uid <= 0) continue;
    if ((await getUnilevelLp(uid)) < 5) {
      badUni++;
      if (badExamples.length < 5) badExamples.push(`@${(await userById(uid))?.username ?? uid}`);
    }
  }
  if (badUni > 0) {
    alerts.push({
      level: 'critical',
      title: 'Possible wrong unilevel earnings detected',
      message: `${badUni} member(s) have unilevel earnings but currently do not meet the 5 LP eligibility rule.${badExamples.length ? ' Examples: ' + badExamples.join(', ') : ''}`,
      action: 'Run Start Batch Recalculate to rebuild unilevel using current rules.',
    });
  }

  // Pending encashment with invalid ID
  const pendingIds = await q<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM ledger WHERE amount < 0 AND note LIKE '%Encashment%' AND note LIKE '%Pending%'`,
  );
  let invalidPending = 0;
  const invExamples: string[] = [];
  for (const r of pendingIds) {
    const uid = Number(r.user_id);
    const status = await memberIdStatus(uid);
    if (!status.valid) {
      invalidPending++;
      if (invExamples.length < 5) invExamples.push(`@${(await userById(uid))?.username ?? uid} (${status.reason})`);
    }
  }
  if (invalidPending > 0) {
    alerts.push({
      level: 'warning',
      title: 'Pending encashment with invalid ID',
      message: `${invalidPending} pending encashment request(s) belong to members with missing/expired ID details.${invExamples.length ? ' Examples: ' + invExamples.join('; ') : ''}`,
      action: 'Verify ID details before approving payout.',
    });
  }

  const missingActivator = num(
    (await scalar<string>(`SELECT COUNT(*) FROM pins WHERE is_product=1 AND status='used' AND (used_by IS NULL OR used_by=0)`)) ?? 0,
  );
  if (missingActivator > 0) {
    alerts.push({
      level: 'warning',
      title: 'Activated product codes missing activator',
      message: `${missingActivator} used product code(s) have no activated-by user. This can affect LP and unilevel audits.`,
      action: 'Review Product Entries and rebuild if needed.',
    });
  }

  const orphanLedger = num(
    (await scalar<string>(`SELECT COUNT(*) FROM ledger l LEFT JOIN users u ON u.id = l.user_id WHERE u.id IS NULL`)) ?? 0,
  );
  if (orphanLedger > 0) {
    alerts.push({
      level: 'warning',
      title: 'Ledger rows for deleted/missing users',
      message: `${orphanLedger} ledger row(s) belong to missing users.`,
      action: 'Review deleted members/backups; these rows may affect accounting exports.',
    });
  }

  const orphanAccounts = num(
    (await scalar<string>(`SELECT COUNT(*) FROM accounts a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL`)) ?? 0,
  );
  if (orphanAccounts > 0) {
    alerts.push({
      level: 'critical',
      title: 'Genealogy accounts with missing users',
      message: `${orphanAccounts} account node(s) point to missing users.`,
      action: 'Fix or remove orphan account nodes before recalculating.',
    });
  }

  const missingUsedAt = num(
    (await scalar<string>(`SELECT COUNT(*) FROM pins WHERE is_product=1 AND status='used' AND used_at IS NULL`)) ?? 0,
  );
  if (missingUsedAt > 0) {
    alerts.push({
      level: 'warning',
      title: 'Activated product codes missing activation date',
      message: `${missingUsedAt} used product code(s) are missing used_at. This affects monthly LP reset and cutoff accounting.`,
      action: 'Review Product Entries and consider recalculation after correcting activation dates.',
    });
  }

  return alerts;
}

/* ------------------------- alert history ------------------------- */

export interface AlertHistoryRow extends AdminAlert {
  signature: string;
  first_seen: string;
  last_seen: string;
  last_resolved: string;
  seen_count: number;
  status: 'active' | 'resolved';
}

function alertSignature(a: AdminAlert): string {
  return createHash('sha256').update(`${a.level}|${a.title}|${a.message}`.toLowerCase()).digest('hex');
}

export async function getAlertHistory(): Promise<Record<string, AlertHistoryRow>> {
  await ensureSettings();
  try {
    const parsed = JSON.parse(setting('mlm_admin_alert_history', '{}'));
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export async function updateAlertHistory(alerts: AdminAlert[]): Promise<Record<string, AlertHistoryRow>> {
  const history = await getAlertHistory();
  const now = phFormat(new Date(), 'Y-m-d H:i:s');
  const active = new Set<string>();
  for (const a of alerts) {
    const sig = alertSignature(a);
    active.add(sig);
    if (!history[sig]) {
      history[sig] = { ...a, signature: sig, first_seen: now, last_seen: now, last_resolved: '', seen_count: 1, status: 'active' };
    } else {
      history[sig] = { ...history[sig], ...a, last_seen: now, seen_count: history[sig].seen_count + 1, status: 'active' };
    }
  }
  for (const [sig, row] of Object.entries(history)) {
    if (row.status === 'active' && !active.has(sig)) {
      row.status = 'resolved';
      row.last_resolved = now;
    }
  }
  const trimmed = Object.fromEntries(
    Object.entries(history)
      .sort((a, b) => (b[1].last_seen > a[1].last_seen ? 1 : -1))
      .slice(0, 300),
  );
  await exec(`INSERT INTO settings (key, value, updated_at) VALUES ('mlm_admin_alert_history', $1, now())
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(trimmed)]);
  return trimmed;
}

export async function clearAlertHistory(): Promise<void> {
  await exec(`INSERT INTO settings (key, value, updated_at) VALUES ('mlm_admin_alert_history', '{}', now())
              ON CONFLICT (key) DO UPDATE SET value = '{}', updated_at = now()`);
}

/* ------------------------- report export rows ------------------------- */

export async function buildReportRows(
  report: string,
  start: string,
  end: string,
): Promise<{ headers: string[]; rows: Record<string, string | number>[] }> {
  const dateOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const s = dateOk(start) ? start : phFormat(new Date(), 'Y-m-01');
  const e = dateOk(end) ? end : phFormat(new Date(), 'Y-m-t');

  if (report === 'sales') {
    const { rows } = await salesReport(s, e);
    return {
      headers: ['Date', 'Purchaser', 'User ID', 'Details', 'Code', 'Amount', 'Status'],
      rows: rows.map((r) => ({
        Date: phFormat(r.created_at, 'Y-m-d H:i:s'),
        Purchaser: r.username,
        'User ID': r.user_id,
        Details: r.item,
        Code: r.code,
        Amount: r.amount,
        Status: r.status,
      })),
    };
  }
  if (report === 'encashments') {
    const { rows } = await encashReport(s, e);
    return {
      headers: ['Date Paid', 'Member', 'User ID', 'Gross Amount', 'Tax and Fees', 'Net Disbursed', 'Details'],
      rows: rows.map((r) => ({
        'Date Paid': phFormat(r.created_at, 'Y-m-d H:i:s'),
        Member: r.username,
        'User ID': r.user_id,
        'Gross Amount': r.gross,
        'Tax and Fees': r.fees,
        'Net Disbursed': r.net,
        Details: r.note.replace(' - APPROVED & PAID', ''),
      })),
    };
  }
  if (report === 'ledger') {
    const rows = await q<LedgerRow>(
      `SELECT * FROM ledger WHERE created_at::date >= $1::date AND created_at::date <= $2::date ORDER BY created_at DESC, id DESC`,
      [s, e],
    );
    const out = [];
    for (const r of rows) {
      const u = await userById(Number(r.user_id));
      out.push({
        Date: phFormat(r.created_at, 'Y-m-d H:i:s'),
        Member: u?.username ?? 'Unknown',
        'User ID': r.user_id,
        Amount: num(r.amount),
        Type: r.type,
        Status: r.status,
        'Tax Deducted': num(r.tax_deducted),
        'Fee Deducted': num(r.fee_deducted),
        Note: r.note,
      });
    }
    return { headers: ['Date', 'Member', 'User ID', 'Amount', 'Type', 'Status', 'Tax Deducted', 'Fee Deducted', 'Note'], rows: out };
  }
  if (report === 'members') {
    const users = await q<UserRow>('SELECT * FROM users ORDER BY created_at DESC');
    const out = [];
    for (const u of users) {
      const sponsor = u.sponsor_id ? await userById(Number(u.sponsor_id)) : null;
      const free = isFreeAccountUser(u);
      const acct = await primaryAccountForUser(Number(u.id));
      out.push({
        'User ID': u.id,
        Username: u.username,
        Name: `${u.first_name} ${u.last_name}`.trim(),
        Email: u.email,
        Sponsor: sponsor?.username ?? '',
        Rank: u.rank,
        LP: await getUnilevelLp(Number(u.id)),
        'Account Type': acct ? (isCA(acct.account_type) ? 'Child Account' : 'Mother Account') : '',
        'Free Account': free ? 'YES' : 'NO',
        'Can Receive A+B/Trifinity': free ? (u.free_receive_pairing ? 'YES' : 'NO') : 'N/A',
        'Can Be Used By Uplines': free ? (u.free_count_for_upline_pairing ? 'YES' : 'NO') : 'N/A',
        'Pay Direct Referral': free ? (u.free_pay_direct_referral ? 'YES' : 'NO') : 'N/A',
        'Member ID Number': u.member_id_number,
        'ID Expiration': u.member_id_expires ? phFormat(u.member_id_expires as Date, 'Y-m-d') : '',
        Registered: phFormat(u.created_at, 'Y-m-d H:i:s'),
      });
    }
    return {
      headers: ['User ID', 'Username', 'Name', 'Email', 'Sponsor', 'Rank', 'LP', 'Account Type', 'Free Account', 'Can Receive A+B/Trifinity', 'Can Be Used By Uplines', 'Pay Direct Referral', 'Member ID Number', 'ID Expiration', 'Registered'],
      rows: out,
    };
  }
  if (report === 'package_entries' || report === 'product_entries') {
    const isProduct = report === 'product_entries' ? 1 : 0;
    const rows = await q<PinRow & { purchaser_name: string; activator_name: string }>(
      `SELECT p.*, COALESCE(pu.username,'') AS purchaser_name, COALESCE(au.username,'') AS activator_name
       FROM pins p LEFT JOIN users pu ON pu.id = p.purchaser_id LEFT JOIN users au ON au.id = p.used_by
       WHERE p.is_product = $1 ORDER BY p.id DESC`,
      [isProduct],
    );
    return {
      headers: ['ID', 'Code', 'Item', 'Purchased By', 'Purchaser ID', 'Activated By', 'Status', 'Date Created', 'Date Activated'],
      rows: rows.map((r) => ({
        ID: r.id,
        Code: r.pin_code,
        Item: r.package_type,
        'Purchased By': r.purchaser_name || 'Admin',
        'Purchaser ID': r.purchaser_id,
        'Activated By': r.activator_name || (r.status === 'used' ? 'Unknown' : ''),
        Status: r.status,
        'Date Created': phFormat(r.created_at, 'Y-m-d H:i:s'),
        'Date Activated': r.used_at ? phFormat(r.used_at, 'Y-m-d H:i:s') : '',
      })),
    };
  }
  if (report === 'orders') {
    const priceMap = await packagePriceMap();
    const rows = await q<OrderRow>(
      `SELECT * FROM orders WHERE created_at::date >= $1::date AND created_at::date <= $2::date ORDER BY created_at DESC`,
      [s, e],
    );
    const out = [];
    for (const r of rows) {
      const u = await userById(Number(r.user_id));
      out.push({
        Date: phFormat(r.created_at, 'Y-m-d H:i:s'),
        Member: u?.username ?? 'Unknown',
        'User ID': r.user_id,
        Details: r.order_details,
        Status: r.status,
        Amount: orderSalesAmount(r.order_details, priceMap, u),
      });
    }
    return { headers: ['Date', 'Member', 'User ID', 'Details', 'Status', 'Amount'], rows: out };
  }
  if (report === 'audit_logs') {
    const rows = await q(
      `SELECT * FROM audit_logs WHERE created_at::date >= $1::date AND created_at::date <= $2::date ORDER BY id DESC`,
      [s, e],
    );
    return {
      headers: ['Date', 'Actor', 'Role', 'Category', 'Action', 'Target', 'Details', 'IP'],
      rows: rows.map((r) => ({
        Date: phFormat(r.created_at as Date, 'Y-m-d H:i:s'),
        Actor: r.actor_username as string,
        Role: r.actor_role as string,
        Category: r.category as string,
        Action: r.action as string,
        Target: r.target_username as string,
        Details: r.details as string,
        IP: r.ip_address as string,
      })),
    };
  }
  if (report === 'alerts') {
    const alerts = await detectEarningAlerts();
    return {
      headers: ['Level', 'Title', 'Message', 'Recommended Action'],
      rows: alerts.map((a) => ({ Level: a.level, Title: a.title, Message: a.message, 'Recommended Action': a.action })),
    };
  }
  if (report === 'alerts_history') {
    const history = await getAlertHistory();
    return {
      headers: ['Status', 'Level', 'Title', 'Message', 'Recommended Action', 'Times Seen', 'First Seen', 'Last Seen', 'Resolved At'],
      rows: Object.values(history).map((h) => ({
        Status: h.status,
        Level: h.level,
        Title: h.title,
        Message: h.message,
        'Recommended Action': h.action,
        'Times Seen': h.seen_count,
        'First Seen': h.first_seen,
        'Last Seen': h.last_seen,
        'Resolved At': h.last_resolved,
      })),
    };
  }
  return { headers: ['Error'], rows: [{ Error: 'Unknown report type' }] };
}

/* ------------------------- tree view data ------------------------- */

export interface GenealogyPayload {
  focus: TreeCell | null;
  rootAccountId: number;
  focusAccountId: number;
  rowsComplete: boolean;
  spillView: boolean;
  downlineOptions: { account_id: number; label: string; depth: number }[];
}

export async function genealogyPayload(
  ownerAccountId: number,
  focusAccountId: number,
): Promise<GenealogyPayload> {
  const focus = await getTreeCells(Number(focusAccountId), 2);
  const rowsComplete = await firstRowsComplete(Number(ownerAccountId));
  const { subtreeByDepth } = await import('./engine/accounts');
  const levels = await subtreeByDepth(Number(ownerAccountId), 9);
  const options: GenealogyPayload['downlineOptions'] = [];
  const ids: number[] = [];
  for (const [depth, atDepth] of Object.entries(levels)) {
    if (Number(depth) === 0) continue;
    ids.push(...atDepth);
  }
  if (ids.length) {
    const rows = await q<{ id: number; user_id: number; account_type: string }>(
      'SELECT id, user_id, account_type FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id ASC',
      [ids],
    );
    const depthOf = new Map<number, number>();
    for (const [depth, atDepth] of Object.entries(levels)) for (const id of atDepth) depthOf.set(id, Number(depth));
    const optUserIds = [...new Set(rows.filter((r) => r.account_type === 'MA').map((r) => Number(r.user_id)))];
    const optUsers = optUserIds.length
      ? await q<UserRow>('SELECT * FROM users WHERE id = ANY($1::bigint[])', [optUserIds])
      : [];
    const optUserById = new Map(optUsers.map((u) => [Number(u.id), u]));
    for (const r of rows) {
      if (r.account_type !== 'MA') continue;
      const u = optUserById.get(Number(r.user_id));
      if (!u) continue;
      options.push({
        account_id: Number(r.id),
        label: `${u.display_name || u.username} (@${u.username}) — Row ${depthOf.get(Number(r.id)) ?? ''}`,
        depth: depthOf.get(Number(r.id)) ?? 0,
      });
    }
  }
  return {
    focus,
    rootAccountId: Number(ownerAccountId),
    focusAccountId: Number(focusAccountId),
    rowsComplete,
    spillView: Number(focusAccountId) !== Number(ownerAccountId) && rowsComplete,
    downlineOptions: options,
  };
}

export async function downlineEarningsTable(ownerAccountId: number) {
  const { subtreeByDepth } = await import('./engine/accounts');
  const levels = await subtreeByDepth(Number(ownerAccountId), 9);
  const rows: {
    account_id: number;
    user_id: number;
    username: string;
    name: string;
    rank: string;
    depth: number;
    joined: string;
    dr: number;
    pairing: number;
    tri: number;
    unilevel: number;
    gc: number;
    total: number;
  }[] = [];

  // Collect candidate account ids by depth, then batch-load accounts,
  // users and ledger aggregates (was 7+ queries PER downline member).
  const depthOf = new Map<number, number>();
  const accountIds: number[] = [];
  for (const [depth, ids] of Object.entries(levels)) {
    if (Number(depth) === 0) continue;
    for (const id of ids) { depthOf.set(Number(id), Number(depth)); accountIds.push(Number(id)); }
  }
  if (!accountIds.length) return { rows, grand: 0 };

  const accs = await q<AccountRow>('SELECT * FROM accounts WHERE id = ANY($1::bigint[])', [accountIds]);
  const accById = new Map(accs.map((a) => [Number(a.id), a]));
  const userIds: number[] = [];
  for (const id of accountIds) {
    const acc = accById.get(id);
    if (acc && !isCA(acc.account_type)) userIds.push(Number(acc.user_id));
  }
  const uniqUserIds = [...new Set(userIds)];
  const users = uniqUserIds.length ? await q<UserRow>('SELECT * FROM users WHERE id = ANY($1::bigint[])', [uniqUserIds]) : [];
  const userByIdMap = new Map(users.map((u) => [Number(u.id), u]));
  const sums = uniqUserIds.length
    ? await q<{ user_id: number; dr: string; pairing: string; tri: string; unilevel: string; gc: string }>(
        `SELECT user_id,
                COALESCE(SUM(CASE WHEN note LIKE '%Direct Referral%' AND type='cash' THEN amount ELSE 0 END),0)::text AS dr,
                COALESCE(SUM(CASE WHEN type='cash' AND note LIKE '%A+B Pair%' AND note NOT LIKE '%Flush Out%' THEN amount ELSE 0 END),0)::text AS pairing,
                COALESCE(SUM(CASE WHEN note LIKE '%Tri-Leg Release%' AND type='cash' THEN amount ELSE 0 END),0)::text AS tri,
                COALESCE(SUM(CASE WHEN note LIKE '%Unilevel%' THEN amount ELSE 0 END),0)::text AS unilevel,
                COALESCE(SUM(CASE WHEN type='gc' THEN amount ELSE 0 END),0)::text AS gc
         FROM ledger WHERE user_id = ANY($1::bigint[]) GROUP BY user_id`,
        [uniqUserIds],
      )
    : [];
  const sumByUser = new Map(sums.map((s) => [Number(s.user_id), s]));

  const seen = new Set<number>();
  let grand = 0;
  for (const id of accountIds) {
    const acc = accById.get(id);
    if (!acc || isCA(acc.account_type)) continue;
    const uid = Number(acc.user_id);
    if (seen.has(uid)) continue;
    seen.add(uid);
    const u = userByIdMap.get(uid);
    if (!u) continue;
    const s = sumByUser.get(uid);
    const dr = num(s?.dr);
    const pairing = num(s?.pairing);
    const tri = num(s?.tri);
    const unilevel = num(s?.unilevel);
    const gc = Math.trunc(num(s?.gc));
    const total = dr + pairing + tri + unilevel;
    grand += total;
    rows.push({
      account_id: id,
      user_id: uid,
      username: u.username,
      name: u.display_name || u.username,
      rank: u.rank,
      depth: depthOf.get(id) ?? 0,
      joined: phFormat(u.created_at, 'Y-m-d'),
      dr,
      pairing,
      tri,
      unilevel,
      gc,
      total,
    });
  }
  return { rows, grand };
}

export { resyncWallet };

/* ------------------------- unilevel / product-comm reports (admin) ------------------------- */

export interface UnilevelReportRow {
  user_id: number;
  username: string;
  rank: string;
  lp: number;
  eligible: boolean;
  released: number;
  pending: number;
}

export interface UnilevelReport {
  released: number;
  pending: number;
  earners: number;
  cutoffHold: boolean;
  monthlyReset: boolean;
  rates: number[];
  rows: UnilevelReportRow[];
  recent: (LedgerRow & { username: string })[];
  codeRequests: (OrderRow & { username: string })[];
}

export async function unilevelReport(): Promise<UnilevelReport> {
  const agg = await q<{ user_id: number; released: string; pending: string }>(
    `SELECT user_id,
            COALESCE(SUM(CASE WHEN status NOT IN ('hang','forfeited') THEN amount ELSE 0 END), 0)::text AS released,
            COALESCE(SUM(CASE WHEN status='hang' THEN amount ELSE 0 END), 0)::text AS pending
       FROM ledger WHERE note LIKE 'Unilevel Comm%' GROUP BY user_id`,
  );
  const rows: UnilevelReportRow[] = [];
  for (const a of agg) {
    const u = await userById(Number(a.user_id));
    const lp = await getUnilevelLp(Number(a.user_id));
    rows.push({
      user_id: Number(a.user_id),
      username: u?.username ?? `#${a.user_id}`,
      rank: u?.rank ?? '',
      lp,
      eligible: lp >= 5,
      released: num(a.released),
      pending: num(a.pending),
    });
  }
  rows.sort((x, y) => y.released + y.pending - (x.released + x.pending));
  const recent = await q<LedgerRow & { username: string }>(
    `SELECT l.*, COALESCE(u.username, '') AS username
       FROM ledger l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.note LIKE 'Unilevel Comm%' ORDER BY l.id DESC LIMIT 50`,
  );
  const codeRequests = await q<OrderRow & { username: string }>(
    `SELECT o.*, COALESCE(u.username, '') AS username
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.order_details LIKE 'UNILEVEL CODE REQUEST:%' ORDER BY o.id DESC LIMIT 50`,
  );
  return {
    released: rows.reduce((s, r) => s + r.released, 0),
    pending: rows.reduce((s, r) => s + r.pending, 0),
    earners: rows.length,
    cutoffHold: settingBool('mlm_sys_unilevel_cutoff_hold', true),
    monthlyReset: unilevelMonthlyResetOn(),
    rates: unilevelMatrix(),
    rows: rows.slice(0, 100),
    recent,
    codeRequests,
  };
}

export interface ProductCommReportRow {
  user_id: number;
  username: string;
  rank: string;
  bottles: number;
  released: number;
  pending: number;
}

export interface ProductCommReport {
  released: number;
  pending: number;
  bottles: number;
  earners: number;
  perBottle: number;
  rows: ProductCommReportRow[];
  recent: (LedgerRow & { username: string })[];
  codeRequests: (OrderRow & { username: string })[];
}

export async function productCommReport(): Promise<ProductCommReport> {
  const agg = await q<{ user_id: number; bottles: number; released: string; pending: string }>(
    `SELECT user_id,
            COALESCE(SUM((regexp_match(note, 'Qty: ([0-9]+)'))[1]::int), 0)::int AS bottles,
            COALESCE(SUM(CASE WHEN status NOT IN ('hang','forfeited') THEN amount ELSE 0 END), 0)::text AS released,
            COALESCE(SUM(CASE WHEN status='hang' THEN amount ELSE 0 END), 0)::text AS pending
       FROM ledger WHERE note LIKE 'Product Comm%' GROUP BY user_id`,
  );
  const rows: ProductCommReportRow[] = [];
  for (const a of agg) {
    const u = await userById(Number(a.user_id));
    rows.push({
      user_id: Number(a.user_id),
      username: u?.username ?? `#${a.user_id}`,
      rank: u?.rank ?? '',
      bottles: Number(a.bottles),
      released: num(a.released),
      pending: num(a.pending),
    });
  }
  rows.sort((x, y) => y.released + y.pending - (x.released + x.pending));
  const recent = await q<LedgerRow & { username: string }>(
    `SELECT l.*, COALESCE(u.username, '') AS username
       FROM ledger l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.note LIKE 'Product Comm%' ORDER BY l.id DESC LIMIT 50`,
  );
  const codeRequests = await q<OrderRow & { username: string }>(
    `SELECT o.*, COALESCE(u.username, '') AS username
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.order_details LIKE 'CODE REQUEST:%' ORDER BY o.id DESC LIMIT 50`,
  );
  return {
    released: rows.reduce((s, r) => s + r.released, 0),
    pending: rows.reduce((s, r) => s + r.pending, 0),
    bottles: rows.reduce((s, r) => s + r.bottles, 0),
    earners: rows.length,
    perBottle: settingNum('mlm_sys_product_comm_starter', 20),
    rows: rows.slice(0, 100),
    recent,
    codeRequests,
  };
}
