import { q, scalar } from '@/lib/db';
import { ensureSettings, settingBool } from '@/lib/settings';
import { releaseMaturedUnilevelCommissions } from '@/lib/engine/unilevel';
import { getSession, getUserById } from '@/lib/auth';
import { phFormat } from '@/lib/time';
import {
  adminOverview,
  encashReport,
  productCommReport,
  unilevelReport,
  leaderboards,
  orderIsProduct,
  packagesByName,
  salesReport,
  updateAlertHistory,
  detectEarningAlerts,
} from '@/lib/queries';
import {
  isCA,
  isFreeAccountUser,
  maAccountForUser,
  memberIdStatus,
  primaryAccountForUser,
  userById,
} from '@/lib/engine/accounts';
import { getRebuildState } from '@/lib/engine/rebuild';
import { listEncashments } from '@/lib/engine/encash';
import { getTreeCells } from '@/lib/engine/tree';
import AdminDashboard, { type MemberDirRow } from '@/components/AdminDashboard';
import LoginForm from '@/components/LoginForm';
import type { AccountRow, AuditRow, OrderRow, PackageRow, PinRow, UserRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

const serial = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  const user = session ? await getUserById(session.uid) : null;

  if (!session || session.r !== 'admin' || !user?.is_admin) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-10">
        <div className="mb-4 text-center">
          <h1 className="text-xl font-extrabold text-gold">Restricted Access</h1>
          <p className="text-[12px] text-zinc-500">Please enter gateway credentials to access the Admin Panel.</p>
        </div>
        <LoginForm initialMode="admin" />
      </div>
    );
  }

  await ensureSettings();
  await releaseMaturedUnilevelCommissions(); // monthly Floating (LP) settlement
  const sp = await searchParams;
  const monthStart = phFormat(new Date(), 'Y-m-01');
  const monthEnd = phFormat(new Date(), 'Y-m-t');

  const overview = await adminOverview();
  const lbStart = sp.lb_start || monthStart;
  const lbEnd = sp.lb_end || monthEnd;
  const boards = await leaderboards(lbStart, lbEnd);

  const packages = await q<PackageRow>('SELECT * FROM packages WHERE is_product=0 ORDER BY pkg_price ASC');
  const products = await q<PackageRow>('SELECT * FROM packages WHERE is_product=1 ORDER BY pkg_price ASC');
  const byName = await packagesByName();

  const packageEntries = await q<PinRow>('SELECT * FROM pins WHERE is_product=0 ORDER BY id DESC LIMIT 500');
  const productEntries = await q<PinRow>('SELECT * FROM pins WHERE is_product=1 ORDER BY id DESC LIMIT 500');
  const cnt = async (sql: string) => Number((await scalar<string>(sql)) ?? 0);
  const entriesSummary = {
    unusedPkg: await cnt(`SELECT COUNT(*) FROM pins WHERE status='unused' AND is_product=0`),
    usedPkg: await cnt(`SELECT COUNT(*) FROM pins WHERE status='used' AND is_product=0`),
    unusedProd: await cnt(`SELECT COUNT(*) FROM pins WHERE status='unused' AND is_product=1`),
    usedProd: await cnt(`SELECT COUNT(*) FROM pins WHERE status='used' AND is_product=1`),
    loose: await cnt(`SELECT COUNT(*) FROM pins WHERE is_product=1 AND status='unused' AND purchaser_id > 1`),
  };

  // Member directory — primary accounts batch-loaded for all members at once
  const allUsers = await q<UserRow>('SELECT * FROM users ORDER BY created_at DESC');
  const allUserIds = allUsers.map((u) => Number(u.id));
  const primaryRows = allUserIds.length
    ? await q<AccountRow>(
        `SELECT DISTINCT ON (user_id) * FROM accounts
         WHERE user_id = ANY($1::bigint[])
         ORDER BY user_id, CASE WHEN account_type = 'MA' THEN 0 ELSE 1 END, id ASC`,
        [allUserIds],
      )
    : [];
  const primaryByUser = new Map(primaryRows.map((a) => [Number(a.user_id), a]));
  const usersById = new Map(allUsers.map((u) => [Number(u.id), u]));
  const members: MemberDirRow[] = [];
  for (const u of allUsers) {
    const primary = primaryByUser.get(Number(u.id)) ?? null;
    const free = isFreeAccountUser(u);
    const kind = primary ? (isCA(primary.account_type) ? 'Child' : 'Mother') : 'Mother';
    const sponsor = u.sponsor_id ? usersById.get(Number(u.sponsor_id)) ?? null : null;
    const idStatus = await memberIdStatus(Number(u.id));
    members.push({
      user: u,
      sponsorName: sponsor ? `@${sponsor.username}` : '-',
      accountLabel: free ? `Free ${kind}` : kind,
      isFree: free,
      freeKind: kind,
      freeFlags: free
        ? `Pair: ${u.free_receive_pairing ? 'Y' : 'N'} | Upline: ${u.free_count_for_upline_pairing ? 'Y' : 'N'} | DR: ${u.free_pay_direct_referral ? 'Y' : 'N'}`
        : '',
      held: !!u.account_held,
      idValid: idStatus.valid,
      idExpires: idStatus.expires,
    });
  }

  // Pending orders split
  const pendingOrders = await q<OrderRow>(`SELECT * FROM orders WHERE status='pending' ORDER BY id ASC`);
  const withUser = async (o: OrderRow) => ({ ...o, username: (await userById(Number(o.user_id)))?.username ?? 'Unknown' });
  const pendingPkgOrders: (OrderRow & { username: string })[] = [];
  const pendingProdOrders: (OrderRow & { username: string })[] = [];
  for (const o of pendingOrders) {
    (orderIsProduct(o.order_details, byName) ? pendingProdOrders : pendingPkgOrders).push(await withUser(o));
  }

  // Product activation history
  const historyRows = await q<PinRow>(
    `SELECT * FROM pins WHERE is_product=1 AND status='used' ORDER BY used_at DESC NULLS LAST, id DESC LIMIT 100`,
  );
  const activationHistory = await Promise.all(
    historyRows.map(async (p) => {
      const owner = p.purchaser_id ? await userById(Number(p.purchaser_id)) : null;
      const recipient = p.used_by ? await userById(Number(p.used_by)) : null;
      const actorU = p.activated_by_user_id ? await userById(Number(p.activated_by_user_id)) : null;
      return {
        ...p,
        owner: owner ? `@${owner.username}` : `Member #${p.purchaser_id}`,
        recipient: recipient ? `@${recipient.username}` : `Member #${p.used_by}`,
        actor: actorU ? `@${actorU.username}` : p.activation_source === 'admin' ? 'Admin' : 'Legacy / unknown',
      };
    }),
  );

  const pendingEncash = await listEncashments({ state: 'pending', limit: 200 });

  const salesStart = sp.sales_start || monthStart;
  const salesEnd = sp.sales_end || monthEnd;
  const encashStart = sp.encash_start || monthStart;
  const encashEnd = sp.encash_end || monthEnd;
  const sales = await salesReport(salesStart, salesEnd);
  const encashRep = await encashReport(encashStart, encashEnd);
  const uniReport = await unilevelReport();
  const prodCommReport = await productCommReport();

  // Genealogy viewer
  const adminUser = await userById(1);
  const treeTarget = sp.admin_target_user || adminUser?.username || user.username;
  const targetUser = await q<UserRow>('SELECT * FROM users WHERE username=$1', [treeTarget]).then((r) => r[0] ?? null);
  let treeRoot = null;
  let treeRootId = 0;
  let treeFocusId = 0;
  if (targetUser) {
    const ma = await maAccountForUser(Number(targetUser.id));
    if (ma) {
      treeRootId = Number(ma.id);
      treeFocusId = sp.admin_view_node ? Number(sp.admin_view_node) : treeRootId;
      treeRoot = await getTreeCells(treeFocusId, 2);
      if (!treeRoot) {
        treeFocusId = treeRootId;
        treeRoot = await getTreeCells(treeRootId, 2);
      }
    }
  }

  // Alerts + history (history updates on view, like the plugin)
  const alerts = await detectEarningAlerts();
  const historyMap = await updateAlertHistory(alerts);
  const alertHistory = Object.values(historyMap).sort((a, b) => (b.last_seen > a.last_seen ? 1 : -1)).slice(0, 150);

  // Logs
  const logCategory = sp.log_category || 'all';
  const logs =
    logCategory === 'all'
      ? await q<AuditRow>('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500')
      : await q<AuditRow>('SELECT * FROM audit_logs WHERE category=$1 ORDER BY id DESC LIMIT 500', [logCategory]);

  // Settings values
  const settingRows = await q<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key LIKE 'mlm_%'`);
  const settingsValues: Record<string, string> = {};
  for (const r of settingRows) settingsValues[r.key] = r.value;

  return (
    <AdminDashboard
      overview={serial(overview)}
      leaderboards={serial(boards)}
      lbStart={lbStart}
      lbEnd={lbEnd}
      packages={serial(packages)}
      products={serial(products)}
      packageEntries={serial(packageEntries)}
      productEntries={serial(productEntries)}
      entriesSummary={entriesSummary}
      members={serial(members)}
      pendingPkgOrders={serial(pendingPkgOrders)}
      pendingProdOrders={serial(pendingProdOrders)}
      activationHistory={serial(activationHistory)}
      pendingEncash={serial(pendingEncash.rows)}
      sales={serial(sales)}
      encashReportData={serial(encashRep)}
      unilevelReport={serial(uniReport)}
      productCommReport={serial(prodCommReport)}
      salesStart={salesStart}
      salesEnd={salesEnd}
      encashStart={encashStart}
      encashEnd={encashEnd}
      treeTarget={treeTarget}
      treeRoot={serial(treeRoot)}
      treeFocusId={treeFocusId}
      treeRootId={treeRootId}
      alerts={serial(alerts)}
      alertHistory={serial(alertHistory)}
      logs={serial(logs)}
      logCategory={logCategory}
      settingsValues={settingsValues}
      rebuildState={serial(await getRebuildState())}
      maintenance={settingBool('mlm_maintenance_mode', false)}
      nowText={phFormat(new Date(), 'M d, Y - g:i A')}
      initialTab={sp.tab || 'tab-overview'}
    />
  );
}
