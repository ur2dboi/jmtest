'use client';

import React from 'react';
import { api, Badge, confirmDialog, cx, Empty, Modal, peso, rankBadge, reloadSoon, Stat, Toast, useToast } from './ui';
import TreeView, { type SlotInfo } from './TreeView';
import { phFormat } from '@/lib/time';
import type { AdminAlert, AlertHistoryRow, AdminOverview, ProductCommReport, UnilevelReport } from '@/lib/queries';
import type { AuditRow, OrderRow, PackageRow, PinRow, UserRow } from '@/lib/types';
import type { TreeCell } from '@/lib/engine/tree';
import type { EncashRow } from '@/lib/engine/encash';
import type { RebuildRow } from '@/lib/engine/rebuild';

export interface MemberDirRow {
  user: UserRow;
  sponsorName: string;
  accountLabel: string;
  isFree: boolean;
  freeKind: string;
  freeFlags: string;
  held: boolean;
  idValid: boolean;
  idExpires: string;
}

export interface AdminProps {
  overview: AdminOverview;
  leaderboards: { earners: LbRow[]; encash: LbRow[]; sponsors: LbRow[]; buyers: LbRow[] };
  lbStart: string; lbEnd: string;
  packages: PackageRow[];
  products: PackageRow[];
  packageEntries: PinRow[];
  productEntries: PinRow[];
  entriesSummary: { unusedPkg: number; usedPkg: number; unusedProd: number; usedProd: number; loose: number };
  members: MemberDirRow[];
  pendingPkgOrders: (OrderRow & { username: string })[];
  pendingProdOrders: (OrderRow & { username: string })[];
  activationHistory: (PinRow & { owner?: string; recipient?: string; actor?: string })[];
  pendingEncash: EncashRow[];
  sales: { rows: (OrderRow & { username: string; item: string; code: string; amount: number })[]; total: number };
  encashReportData: { rows: (Record<string, unknown> & { username: string; gross: number; fees: number; net: number; note: string })[]; totalNet: number };
  unilevelReport: UnilevelReport;
  productCommReport: ProductCommReport;
  salesStart: string; salesEnd: string; encashStart: string; encashEnd: string;
  treeTarget: string;
  treeRoot: TreeCell | null;
  treeFocusId: number;
  treeRootId: number;
  alerts: AdminAlert[];
  alertHistory: AlertHistoryRow[];
  logs: AuditRow[];
  logCategory: string;
  settingsValues: Record<string, string>;
  rebuildState: RebuildRow;
  maintenance: boolean;
  nowText: string;
  initialTab: string;
}

interface LbRow { user_id: number; username: string; total: number }

const dt = (v: unknown, fmt = 'M d, Y h:i A') => (v ? phFormat(v as string, fmt) : '');

const TABS: { id: string; label: string; icon: string; badge?: (p: AdminProps) => number }[] = [
  { id: 'tab-overview', label: 'Overview / Leaderboard', icon: '📊' },
  { id: 'tab-alerts', label: 'System Alerts', icon: '⚠️', badge: (p) => p.alerts.length },
  { id: 'tab-accounting-exports', label: 'Accounting Exports', icon: '💾' },
  { id: 'tab-packages', label: 'Packages Manager', icon: '📦' },
  { id: 'tab-products', label: 'Products Manager', icon: '🛍️' },
  { id: 'tab-pins', label: 'Package Entries', icon: '🔑' },
  { id: 'tab-product-entries', label: 'Product Entries', icon: '🎁' },
  { id: 'tab-members', label: 'Member Directory', icon: '👥' },
  { id: 'tab-placement', label: 'Network Override', icon: '🛠️' },
  { id: 'tab-orders', label: 'Pkg Orders', icon: '🛒', badge: (p) => p.pendingPkgOrders.length },
  { id: 'tab-product-orders', label: 'Product Orders', icon: '🧺', badge: (p) => p.pendingProdOrders.length },
  { id: 'tab-encash', label: 'Encash Requests', icon: '💸', badge: (p) => p.pendingEncash.length },
  { id: 'tab-sales-report', label: 'Sales Report', icon: '📈' },
  { id: 'tab-encashment-report', label: 'Encashment Report', icon: '🧾' },
  { id: 'tab-payables-report', label: 'Payables Report', icon: '💵' },
  { id: 'tab-unilevel', label: 'Unilevel', icon: '📶', badge: (p) => p.unilevelReport.codeRequests.filter((r) => r.status === 'pending').length },
  { id: 'tab-prodcomm', label: 'Product Commission', icon: '🧴', badge: (p) => p.productCommReport.codeRequests.filter((r) => r.status === 'pending').length },
  { id: 'tab-tree', label: 'Genealogy Viewer', icon: '🌳' },
  { id: 'tab-logs', label: 'Activity Logs', icon: '📜' },
  { id: 'tab-settings', label: 'Comp. Plan', icon: '⚙️' },
  { id: 'tab-instructions', label: 'System Guide', icon: '📖' },
];

type PostFn = (payload: Record<string, unknown>, successMsg?: string) => Promise<{ message?: string; state?: RebuildRow }>;

export default function AdminDashboard(props: AdminProps) {
  const [tab, setTab] = React.useState(props.initialTab || 'tab-overview');
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [toast, setToast] = useToast();
  const [busy, setBusy] = React.useState(false);

  async function post(payload: Record<string, unknown>, successMsg?: string) {
    setBusy(true);
    try {
      const res = await api<{ message?: string; state?: RebuildRow }>('/api/admin', payload);
      if (res.message) setToast({ kind: 'ok', text: res.message });
      else if (successMsg) setToast({ kind: 'ok', text: successMsg });
      if (!String(payload.action).startsWith('rebuild')) reloadSoon(1100);
      return res;
    } catch (e) {
      setToast({ kind: 'err', text: (e as Error).message });
      setBusy(false);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/member-login';
  }

  const go = (t: string, extra = '') => { window.location.href = `?tab=${t}${extra}`; };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Toast toast={toast} onClose={() => setToast(null)} />
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/70 md:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside className={cx('fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-line bg-card transition-transform md:static md:w-[264px] md:translate-x-0', sidebarOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div className="border-b border-line p-5 text-center">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-gold to-goldsoft text-xl font-extrabold text-black">MJ</div>
          <h3 className="text-[16px] font-bold text-zinc-50">System Admin</h3>
          <p className="text-[12px] text-zinc-500">Command Center</p>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {TABS.map((t) => {
            const count = t.badge?.(props) ?? 0;
            return (
              <button key={t.id} type="button" className={cx('side-link', tab === t.id && 'active')} onClick={() => { setTab(t.id); setSidebarOpen(false); }}>
                <span>{t.icon}</span>
                <span className="flex-1 text-left">{t.label}</span>
                {count > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">{count}</span>}
              </button>
            );
          })}
          <button type="button" className="side-link !text-red-400 hover:!bg-red-950/40" onClick={logout}><span>🚪</span> LOG OUT</button>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 p-3 sm:p-5 lg:p-7">
        <div className="sticky top-0 z-30 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-black/90 pb-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <button type="button" className="btn-dark btn-sm md:hidden" onClick={() => setSidebarOpen(true)}>☰</button>
            <h2 className="text-[17px] font-bold text-zinc-50">Administrator Dashboard</h2>
          </div>
          <span className="badge-gold !normal-case">🕐 {props.nowText}</span>
        </div>

        {props.maintenance && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-[13px] font-semibold text-red-300">
            🔧 MAINTENANCE MODE IS ON — members are currently blocked. Turn it off in Comp. Plan settings.
          </div>
        )}

        {tab === 'tab-overview' && <Overview {...props} go={go} setTab={setTab} />}
        {tab === 'tab-alerts' && <AlertsTab {...props} post={post} busy={busy} />}
        {tab === 'tab-accounting-exports' && <ExportsTab />}
        {(tab === 'tab-packages' || tab === 'tab-products') && (
          <CatalogTab items={tab === 'tab-packages' ? props.packages : props.products} isProduct={tab === 'tab-products'} post={post} busy={busy} />
        )}
        {tab === 'tab-pins' && <PinsTab entries={props.packageEntries} summary={props.entriesSummary} isProduct={false} items={props.packages} post={post} busy={busy} />}
        {tab === 'tab-product-entries' && <PinsTab entries={props.productEntries} summary={props.entriesSummary} isProduct items={props.products} post={post} busy={busy} />}
        {tab === 'tab-members' && <MembersTab {...props} post={post} busy={busy} />}
        {tab === 'tab-placement' && <PlacementTab post={post} busy={busy} />}
        {tab === 'tab-orders' && <OrdersTab orders={props.pendingPkgOrders} isProduct={false} post={post} busy={busy} />}
        {tab === 'tab-product-orders' && <ProductOrdersTab {...props} post={post} busy={busy} />}
        {tab === 'tab-encash' && <EncashTab rows={props.pendingEncash} post={post} busy={busy} />}
        {tab === 'tab-sales-report' && <SalesTab {...props} go={go} />}
        {tab === 'tab-encashment-report' && <EncashReportTab {...props} go={go} />}
        {tab === 'tab-payables-report' && <PayablesTab overview={props.overview} />}
        {tab === 'tab-unilevel' && <UnilevelAdminTab report={props.unilevelReport} post={post} busy={busy} />}
        {tab === 'tab-prodcomm' && <ProductCommAdminTab report={props.productCommReport} post={post} busy={busy} />}
        {tab === 'tab-tree' && <TreeTabAdmin {...props} />}
        {tab === 'tab-logs' && <LogsTab {...props} post={post} busy={busy} />}
        {tab === 'tab-settings' && <SettingsTab {...props} post={post} busy={busy} />}
        {tab === 'tab-instructions' && <InstructionsTab />}
      </main>
    </div>
  );
}

/* ============================ OVERVIEW ============================ */
function Overview(props: AdminProps & { go: (t: string, extra?: string) => void; setTab: (t: string) => void }) {
  const o = props.overview;
  const [start, setStart] = React.useState(props.lbStart);
  const [end, setEnd] = React.useState(props.lbEnd);
  return (
    <div className="animate-fadeIn space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div onClick={() => props.setTab('tab-sales-report')} className="cursor-pointer"><Stat label="Total Revenue (Pkgs + Products)" value={peso(o.totalSales)} accent sub="View Sales Report" /></div>
        <div onClick={() => props.setTab('tab-encashment-report')} className="cursor-pointer"><Stat label="Total Payouts" value={<span className="text-red-400">{peso(o.totalPayouts)}</span>} sub="View Encashment Report" /></div>
        <Stat label="Gross Income" value={<span className="text-emerald-400">{peso(o.grossIncome)}</span>} sub="Revenue − Encashments" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div onClick={() => props.setTab('tab-payables-report')} className="cursor-pointer"><Stat label="Total Bonuses Payables" value={<span className="text-amber-300">{peso(o.payables.total)}</span>} sub="All positive available balances" /></div>
        <div onClick={() => props.setTab('tab-payables-report')} className="cursor-pointer"><Stat label="Uncashed" value={<span className="text-emerald-400">{peso(o.payables.uncashed)}</span>} sub="≥ minimum encashment" /></div>
        <div onClick={() => props.setTab('tab-payables-report')} className="cursor-pointer"><Stat label="Floating Payout" value={<span className="text-violet-300">{peso(o.payables.floating)}</span>} sub="Below minimum encashment" /></div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div onClick={() => props.setTab('tab-members')} className="cursor-pointer">
          <Stat label="Member Count" value={<span className="text-sky-400">{o.memberCount.toLocaleString()}</span>} sub={<>Premium: <b className="text-amber-300">{o.premiumCount}</b> · StarPremium: <b className="text-zinc-100">{o.starpremiumCount}</b></>} />
        </div>
        <Stat label="Pending Orders" value={o.pendingOrders} sub={`${o.pendingPkgOrders} package · ${o.pendingProdOrders} product`} />
        <Stat label="Pending Payouts" value={<span className="text-red-400">{o.pendingPayouts}</span>} sub="Awaiting approval" />
      </div>

      <div className="card" style={{ borderColor: '#8a6d1f' }}>
        <h3 className="text-[16px] font-bold text-gold">🏆 Ultimate Leaderboard Dashboard</h3>
        <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3" onSubmit={(e) => { e.preventDefault(); props.go('tab-overview', `&lb_start=${start}&lb_end=${end}`); }}>
          <div><span className="lbl">Search Start Date</span><input type="date" className="input !w-auto" value={start} onChange={(e) => setStart(e.target.value)} required /></div>
          <div><span className="lbl">Search End Date</span><input type="date" className="input !w-auto" value={end} onChange={(e) => setEnd(e.target.value)} required /></div>
          <button className="btn-gold" type="submit">Refresh Rankings</button>
        </form>
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <LbCard title="💰 Top Earners" color="text-emerald-400" rows={props.leaderboards.earners} format={(v) => peso(v)} />
          <LbCard title="💸 Top Encashment" color="text-red-400" rows={props.leaderboards.encash} format={(v) => peso(v)} />
          <LbCard title="🤝 Top Direct Sponsors" color="text-sky-400" rows={props.leaderboards.sponsors} format={(v) => `${v} members`} />
          <LbCard title="🛒 Top Purchasers" color="text-gold" rows={props.leaderboards.buyers} format={(v) => `${v} items`} />
        </div>
      </div>
    </div>
  );
}

function LbCard({ title, rows, format, color }: { title: string; rows: LbRow[]; format: (v: number) => string; color: string }) {
  return (
    <div className="rounded-lg border border-line bg-[#0d0d0d] p-3">
      <h4 className={cx('mb-2 text-[14px] font-bold', color)}>{title}</h4>
      <div className="tbl-wrap !border-0">
        <table className="tbl !min-w-0">
          <thead><tr><th>#</th><th>Member</th><th>Total</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={3} className="text-center text-zinc-500">No data</td></tr>}
            {rows.map((r, i) => (
              <tr key={r.user_id}><td className="text-zinc-500">{i + 1}</td><td className="font-bold">@{r.username}</td><td className={color}>{format(r.total)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ ALERTS ============================ */
function AlertsTab(props: AdminProps & { post: PostFn; busy: boolean }) {
  const { alerts, alertHistory, post, busy } = props;
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-amber-300">⚠️ Admin Earnings/System Alerts</h3>
      <p className="mt-1 text-[12px] text-zinc-500">Checks for possible wrong earnings, wallet mismatches, duplicate slots, invalid encashment IDs, and product activation traceability issues.</p>
      {alerts.length === 0 ? (
        <div className="mt-4 rounded-lg border border-emerald-700 bg-emerald-950/40 px-4 py-3 text-emerald-300">✅ No earnings/system alerts detected.</div>
      ) : (
        <div className="mt-4 space-y-2">
          {alerts.map((a, i) => (
            <div key={i} className={cx('rounded-lg border px-4 py-3', a.level === 'critical' ? 'border-red-800 bg-red-950/40' : 'border-amber-700 bg-amber-950/30')}>
              <strong className={a.level === 'critical' ? 'text-red-300' : 'text-amber-300'}>{a.level === 'critical' ? '🔴' : '🟠'} {a.title}</strong>
              <p className="mt-0.5 text-[12px] text-zinc-300">{a.message}</p>
              <p className="text-[11px] text-sky-400">Recommended: {a.action}</p>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <a className="btn-dark btn-sm" href="/api/admin/export?report=alerts&format=csv">Download Current Alerts CSV</a>
        <a className="btn-dark btn-sm" href="/api/admin/export?report=alerts&format=xls">Download Current Alerts Excel</a>
        <a className="btn-dark btn-sm" href="/api/admin/export?report=alerts_history&format=csv">Download History CSV</a>
        <a className="btn-dark btn-sm" href="/api/admin/export?report=alerts_history&format=xls">Download History Excel</a>
        <button type="button" disabled={busy} className="btn-danger btn-sm" onClick={async () => { if (confirmDialog('Clear all stored alert history?')) await post({ action: 'alerts-clear-history' }); }}>
          Clear History
        </button>
      </div>
      <h4 className="mt-6 text-[14px] font-bold text-amber-300">📜 Alert Error History</h4>
      <div className="tbl-wrap mt-2 max-h-[420px] overflow-y-auto">
        <table className="tbl">
          <thead><tr><th>Status</th><th>Level</th><th>Alert</th><th>Times</th><th>First Seen</th><th>Last Seen</th><th>Resolved</th></tr></thead>
          <tbody>
            {alertHistory.length === 0 && <tr><td colSpan={7} className="text-center text-zinc-500">No alert history recorded yet.</td></tr>}
            {alertHistory.map((h) => (
              <tr key={h.signature}>
                <td>{h.status === 'active' ? <Badge tone="bad">ACTIVE</Badge> : <Badge tone="ok">RESOLVED</Badge>}</td>
                <td>{h.level.toUpperCase()}</td>
                <td className="!whitespace-normal"><strong>{h.title}</strong><span className="block text-[11px] text-zinc-500">{h.message}</span></td>
                <td>{h.seen_count}</td>
                <td className="text-zinc-500">{h.first_seen}</td>
                <td className="text-zinc-500">{h.last_seen}</td>
                <td className="text-zinc-500">{h.last_resolved || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ EXPORTS ============================ */
const REPORT_LIST: [string, string, boolean][] = [
  ['sales', 'Sales Revenue', true], ['encashments', 'Encashments / Payouts', true],
  ['ledger', 'Full Ledger / Earnings', true], ['orders', 'All Orders', true],
  ['members', 'Member Directory', false], ['package_entries', 'Package Entries', false],
  ['product_entries', 'Product Entries', false], ['audit_logs', 'Activity Logs', true],
  ['alerts', 'System Alerts', false], ['alerts_history', 'System Alert History', false],
];

function ExportsTab() {
  const [start, setStart] = React.useState(phFormat(new Date(), 'Y-m-01'));
  const [end, setEnd] = React.useState(phFormat(new Date(), 'Y-m-t'));
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-sky-400">💾 Accounting CSV / Excel Exports</h3>
      <p className="mt-1 text-[12px] text-zinc-500">Download accounting-ready reports. CSV opens in Excel; Excel downloads are .xls-compatible tables.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3">
        <div><span className="lbl">Start Date</span><input type="date" className="input !w-auto" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div><span className="lbl">End Date</span><input type="date" className="input !w-auto" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      <div className="tbl-wrap mt-3">
        <table className="tbl">
          <thead><tr><th>Report</th><th>Description</th><th>CSV</th><th>Excel</th></tr></thead>
          <tbody>
            {REPORT_LIST.map(([key, label, dated]) => (
              <tr key={key}>
                <td className="font-bold">{label}</td>
                <td className="text-zinc-500">{dated ? 'Uses selected date range.' : 'Full current data.'}</td>
                <td><a className="btn-dark btn-xs" href={`/api/admin/export?report=${key}&format=csv${dated ? `&start=${start}&end=${end}` : ''}`}>CSV</a></td>
                <td><a className="btn-dark btn-xs" href={`/api/admin/export?report=${key}&format=xls${dated ? `&start=${start}&end=${end}` : ''}`}>Excel</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ CATALOG (packages/products) ============================ */
function CatalogTab({ items, isProduct, post, busy }: { items: PackageRow[]; isProduct: boolean; post: PostFn; busy: boolean }) {
  const [editing, setEditing] = React.useState<PackageRow | null>(null);
  const [showAdd, setShowAdd] = React.useState(false);
  const [f, setF] = React.useState({ name: '', price: '', desc: '', variants: '', status: 1 });
  const actionName = isProduct ? 'product-save' : 'package-save';

  const openEdit = (p: PackageRow) => {
    setEditing(p);
    setF({ name: p.pkg_name, price: String(p.pkg_price), desc: p.pkg_desc, variants: p.pkg_variants, status: Number(p.status) });
    setShowAdd(true);
  };
  const openAdd = () => { setEditing(null); setF({ name: '', price: '', desc: '', variants: '', status: 1 }); setShowAdd(true); };

  return (
    <div className="animate-fadeIn">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[17px] font-bold text-gold">{isProduct ? '🛍️ Retail Products Manager' : '📦 Registration Packages Manager'}</h3>
        <button type="button" className="btn-gold btn-sm" onClick={openAdd}>+ Add {isProduct ? 'Product' : 'Package'}</button>
      </div>
      <div className="card">
        <p className="text-[12px] text-zinc-500">{isProduct ? 'Loose retail products that members can order. They do not trigger registration.' : 'Packages used for new user registrations and upgrades.'}</p>
        <div className="tbl-wrap mt-3">
          <table className="tbl">
            <thead><tr><th>ID</th><th>{isProduct ? 'Product' : 'Package'} Name</th><th>Price (₱)</th><th>Description</th><th>Variants</th><th>Status</th><th>Date Created</th><th>Actions</th></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={8} className="text-center text-zinc-500">None created.</td></tr>}
              {items.map((p) => (
                <tr key={p.id}>
                  <td className="text-zinc-500">{p.id}</td>
                  <td className="font-bold text-gold">{p.pkg_name}</td>
                  <td className="font-bold">{peso(p.pkg_price)}</td>
                  <td className="!whitespace-normal text-[12px]">{p.pkg_desc}</td>
                  <td className="!whitespace-normal whitespace-pre-wrap text-[11px] text-zinc-400">{p.pkg_variants}</td>
                  <td>{Number(p.status) === 1 ? <span className="text-emerald-400">Active</span> : <span className="text-red-400">Inactive</span>}</td>
                  <td className="text-zinc-500">{p.created_at ? dt(p.created_at) : '—'}</td>
                  <td>
                    <div className="flex gap-1">
                      <button type="button" className="btn-dark btn-xs" onClick={() => openEdit(p)}>Edit</button>
                      <button type="button" disabled={busy} className="btn-danger btn-xs" onClick={async () => { if (confirmDialog('Delete permanently?')) await post({ action: isProduct ? 'product-delete' : 'package-delete', id: p.id }); }}>Del</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={editing ? `Edit ${isProduct ? 'Product' : 'Package'}` : `Add ${isProduct ? 'Product' : 'Package'}`}>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await post({ action: actionName, id: editing?.id ?? 0, name: f.name, price: Number(f.price), desc: f.desc, variants: f.variants, status: f.status });
            setShowAdd(false);
          }}
        >
          <div><span className="lbl">Name</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><span className="lbl">Price (₱)</span><input className="input" type="number" step="0.01" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></div>
          <div><span className="lbl">Description</span><input className="input" value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} /></div>
          <div><span className="lbl">Variants (one per line)</span><textarea className="textarea" value={f.variants} onChange={(e) => setF({ ...f, variants: e.target.value })} /></div>
          <div>
            <span className="lbl">Status</span>
            <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: Number(e.target.value) })}><option value={1}>Active</option><option value={0}>Inactive</option></select>
          </div>
          <button type="submit" disabled={busy} className="btn-gold w-full">💾 Save Changes</button>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ PIN ENTRIES ============================ */
function PinsTab({ entries, summary, isProduct, items, post, busy }: {
  entries: PinRow[]; summary: AdminProps['entriesSummary']; isProduct: boolean; items: PackageRow[]; post: PostFn; busy: boolean;
}) {
  const [selected, setSelected] = React.useState<number[]>([]);
  const [genItem, setGenItem] = React.useState(items[0]?.pkg_name ?? '');
  const [genCount, setGenCount] = React.useState(1);
  const [transferFor, setTransferFor] = React.useState<PinRow | null>(null);
  const [transferTarget, setTransferTarget] = React.useState('');
  const unused = isProduct ? summary.unusedProd : summary.unusedPkg;
  const used = isProduct ? summary.usedProd : summary.usedPkg;

  const toggle = (id: number, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));

  return (
    <div className="card animate-fadeIn">
      <h3 className={cx('text-[16px] font-bold', isProduct ? 'text-violet-400' : 'text-gold')}>{isProduct ? '🎁 Product Entries (Codes)' : '🔑 Package Entries (Pins)'}</h3>

      {isProduct && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-700 bg-violet-950/30 px-4 py-3">
          <div>
            <h4 className="font-bold text-violet-300">🔄 Loose Products Auto-Activation</h4>
            <p className="text-[11px] text-zinc-400">{summary.loose} unused product code(s) owned by members — auto-activate all at once.</p>
          </div>
          <button
            type="button" disabled={busy || summary.loose < 1}
            className="btn !bg-violet-700 font-semibold text-white hover:!bg-violet-600 disabled:opacity-40"
            onClick={async () => { if (confirmDialog(`Auto-activate all ${summary.loose} loose product codes? This will distribute commissions and LP.`)) await post({ action: 'product-auto-activate-all' }); }}
          >
            ⚡ Auto-Activate All ({summary.loose})
          </button>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-line bg-[#0a0a0a] px-3 py-3 text-center">
          <div className="text-[10px] uppercase text-zinc-500">Unused {isProduct ? 'Products' : 'Packages'}</div>
          <div className="text-2xl font-extrabold text-amber-300">{unused}</div>
        </div>
        <div className="rounded-lg border border-line bg-[#0a0a0a] px-3 py-3 text-center">
          <div className="text-[10px] uppercase text-zinc-500">{isProduct ? 'Products Activated' : 'Used (Registrations)'}</div>
          <div className="text-2xl font-extrabold text-emerald-400">{used}</div>
        </div>
      </div>

      <form
        className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await post({ action: 'pin-generate', package_type: genItem, count: genCount, is_product: isProduct });
          void res;
        }}
      >
        <div className="min-w-[220px] flex-1">
          <span className="lbl">Generate New {isProduct ? 'Product Code' : 'Package Pin'}</span>
          <select className="select" value={genItem} onChange={(e) => setGenItem(e.target.value)} required>
            {items.map((p) => <option key={p.id} value={p.pkg_name}>{p.pkg_name}</option>)}
          </select>
        </div>
        <div><span className="lbl">Count</span><input type="number" min={1} max={500} className="input !w-24" value={genCount} onChange={(e) => setGenCount(Number(e.target.value))} /></div>
        <button type="submit" disabled={busy} className={isProduct ? 'btn !bg-violet-700 text-white hover:!bg-violet-600' : 'btn-gold'}>Generate Code</button>
      </form>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={busy || !selected.length} className="btn-danger btn-sm" onClick={async () => { if (confirmDialog('Delete all selected codes?')) await post({ action: 'pins-bulk-delete', pin_ids: selected }); }}>
          Delete Selected
        </button>
        <span className="text-[12px] text-zinc-500">{selected.length} selected · showing latest {entries.length}</span>
      </div>

      <div className="tbl-wrap mt-2 max-h-[560px] overflow-y-auto">
        <table className="tbl">
          <thead><tr><th><input type="checkbox" className="check" onChange={(e) => setSelected(e.target.checked ? entries.map((x) => x.id) : [])} /></th><th>ID</th><th>Code</th><th>{isProduct ? 'Product' : 'Package'}</th><th>Purchased By</th><th>Activated By</th><th>Status</th><th>Date Created</th><th>Date Activated</th><th>Actions</th></tr></thead>
          <tbody>
            {entries.length === 0 && <tr><td colSpan={10} className="text-center text-zinc-500">No codes found.</td></tr>}
            {entries.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" className="check" checked={selected.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /></td>
                <td>{p.id}</td>
                <td><strong className={isProduct ? 'text-violet-300' : 'text-gold'}>{p.pin_code}</strong></td>
                <td>{p.package_type}</td>
                <td>{p.purchaser_id ? `#${p.purchaser_id}` : 'Admin'}</td>
                <td>{p.used_by ? `#${p.used_by}` : p.status === 'used' ? 'Unknown' : '-'}</td>
                <td>{p.status === 'unused' ? <Badge tone="warn">unused</Badge> : p.status === 'used' ? <Badge tone="ok">used</Badge> : <Badge tone="info">{p.status}</Badge>}</td>
                <td className="text-zinc-500">{p.created_at ? dt(p.created_at) : '—'}</td>
                <td className="text-zinc-500">{p.used_at ? dt(p.used_at) : '-'}</td>
                <td>
                  <div className="flex gap-1">
                    {isProduct && p.status === 'unused' && Number(p.purchaser_id) > 1 && (
                      <button type="button" disabled={busy} className="btn-dark btn-xs" onClick={() => post({ action: 'product-activate-entry', pin_id: p.id })}>Activate</button>
                    )}
                    {p.status === 'unused' && (
                      <button type="button" className="btn-dark btn-xs" onClick={() => { setTransferFor(p); setTransferTarget(''); }}>Transfer</button>
                    )}
                    <button type="button" disabled={busy} className="btn-danger btn-xs" onClick={async () => { if (confirmDialog('Delete this code permanently?')) await post({ action: 'pin-delete', pin_id: p.id }); }}>Del</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!transferFor} onClose={() => setTransferFor(null)} title="Transfer Code Ownership">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!transferFor) return;
            await post({ action: 'pin-transfer', pin_id: transferFor.id, target: transferTarget });
            setTransferFor(null);
          }}
        >
          <p className="text-[13px] text-zinc-400">Code <b className="text-zinc-100">{transferFor?.pin_code}</b> ({transferFor?.package_type})</p>
          <div><span className="lbl">New Purchaser Username</span><input className="input" required value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)} placeholder="Username" /></div>
          <button type="submit" disabled={busy} className="btn-gold w-full">Transfer Ownership</button>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ MEMBERS ============================ */
function MembersTab(props: AdminProps & { post: PostFn; busy: boolean }) {
  const { members, post, busy, packages } = props;
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<number[]>([]);
  const [editing, setEditing] = React.useState<MemberDirRow | null>(null);
  const [ef, setEf] = React.useState<Record<string, string>>({});

  const filtered = members.filter((m) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return [m.user.username, m.user.display_name, `${m.user.first_name} ${m.user.last_name}`, m.user.email].join(' ').toLowerCase().includes(q);
  });

  const [reg, setReg] = React.useState({
    username: '', password: '', first_name: '', middle_name: '', last_name: '', email: '', phone: '',
    sponsor: '', upline: '', upline_node: 'MA', leg: 'L', pkg_id: 0, is_free: false,
    free_kind: 'MA', free_receive: false, free_count: false, free_dr: false,
  });
  const setR = (k: string, v: unknown) => setReg((s) => ({ ...s, [k]: v }));

  const openEdit = (m: MemberDirRow) => {
    setEditing(m);
    setEf({
      username: m.user.username, email: m.user.email, first_name: m.user.first_name, last_name: m.user.last_name,
      phone: m.user.phone, bday: m.user.bday, achievement: m.user.achievement_rank, lp: String(m.user.monthly_lp),
      member_id_number: m.user.member_id_number, member_id_expires: m.idExpires || '', password: '',
    });
  };

  return (
    <div className="animate-fadeIn space-y-4">
      <div className="card">
        <h3 className="text-[16px] font-bold text-sky-400">👥 Member Directory</h3>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => e.preventDefault()}>
          <input className="input min-w-[200px] flex-1" placeholder="Search by username or name..." value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button type="button" className="btn-dark" onClick={() => setQuery('')}>Clear</button>}
        </form>
        <p className="mt-2 text-[11px] text-zinc-500">Showing {filtered.length} result(s){query ? ` for "${query}"` : ' (latest to oldest)'}</p>

        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy || !selected.length} className="btn-danger btn-sm" onClick={async () => { if (confirmDialog('WARNING: Delete ALL selected members permanently?')) await post({ action: 'bulk-delete-members', user_ids: selected }); }}>
            Delete Selected
          </button>
          <span className="text-[12px] text-zinc-500">{selected.length} selected</span>
        </div>

        <div className="tbl-wrap mt-2 max-h-[560px] overflow-y-auto">
          <table className="tbl">
            <thead><tr><th><input type="checkbox" className="check" onChange={(e) => setSelected(e.target.checked ? filtered.map((m) => Number(m.user.id)).filter((id) => id !== 1) : [])} /></th><th>ID</th><th>Username</th><th>Name</th><th>Email</th><th>Sponsor</th><th>Rank</th><th>Account Type</th><th>Registered</th><th>ID Validity</th><th>Actions</th></tr></thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={String(m.user.id)}>
                  <td>{Number(m.user.id) !== 1 && <input type="checkbox" className="check" checked={selected.includes(Number(m.user.id))} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, Number(m.user.id)] : s.filter((x) => x !== Number(m.user.id))))} />}</td>
                  <td>{String(m.user.id)}</td>
                  <td className="font-bold">@{m.user.username}</td>
                  <td>{`${m.user.first_name} ${m.user.last_name}`.trim()}</td>
                  <td className="text-[11px]">{m.user.email}</td>
                  <td className="text-sky-400">{m.sponsorName}</td>
                  <td>{rankBadge(m.user.rank)}</td>
                  <td>
                    <span className={cx('badge', m.isFree ? 'badge-info' : 'badge-ok')}>{m.accountLabel}</span>
                    {m.isFree && <span className="block text-[10px] text-zinc-500">{m.freeFlags}</span>}
                    {m.held && <span className="block"><Badge tone="bad">ON HOLD</Badge></span>}
                  </td>
                  <td className="text-zinc-500">{dt(m.user.created_at)}</td>
                  <td>{m.idValid ? <Badge tone="ok">Valid until {m.idExpires}</Badge> : <Badge tone="bad">{m.user.member_id_number ? 'Expired/Invalid' : 'No ID'}</Badge>}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="btn-dark btn-xs" onClick={() => openEdit(m)}>Edit</button>
                      <a className="btn-dark btn-xs" href={`?tab=tab-tree&admin_target_user=${encodeURIComponent(m.user.username)}`}>Tree</a>
                      {Number(m.user.id) !== 1 && (
                        <>
                          <button type="button" disabled={busy} className={cx('btn-xs btn', m.held ? 'btn-ok' : 'btn-danger')} onClick={async () => { if (confirmDialog(m.held ? 'Unhold this account?' : 'Put this account on hold?')) await post({ action: 'toggle-hold', user_id: m.user.id }); }}>
                            {m.held ? 'Unhold' : 'Hold'}
                          </button>
                          <button type="button" disabled={busy} className="btn-danger btn-xs" onClick={async () => { if (confirmDialog('WARNING: Delete this member entirely?')) await post({ action: 'delete-member', user_id: m.user.id }); }}>Del</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Direct registration */}
      <div className="card">
        <h4 className="text-[15px] font-bold text-emerald-400">➕ Admin Direct Registration</h4>
        <p className="mt-1 text-[11px] text-amber-300">Spillover-safe: free or paid placements must follow the same structure rules as member registration (CA under MA; after gate only Right→Right→Right). Invalid slots are blocked so admin cannot break spillover structure.</p>
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await post({ action: 'register', ...reg, pkg_id: reg.pkg_id });
          }}
        >
          <div className="form-row">
            <input className="input" placeholder="New Username" required value={reg.username} onChange={(e) => setR('username', e.target.value)} />
            <input className="input" type="password" placeholder="New Password" required minLength={6} pattern="[A-Za-z0-9]{6,}" value={reg.password} onChange={(e) => setR('password', e.target.value)} />
            <input className="input" placeholder="First Name" required value={reg.first_name} onChange={(e) => setR('first_name', e.target.value)} />
            <input className="input" placeholder="Middle Name" value={reg.middle_name} onChange={(e) => setR('middle_name', e.target.value)} />
            <input className="input" placeholder="Last Name" required value={reg.last_name} onChange={(e) => setR('last_name', e.target.value)} />
            <input className="input" type="email" placeholder="Email Address" value={reg.email} onChange={(e) => setR('email', e.target.value)} />
            <input className="input" placeholder="Phone Number" value={reg.phone} onChange={(e) => setR('phone', e.target.value)} />
          </div>
          <div className="form-row">
            <input className="input" placeholder="Sponsor Username" required value={reg.sponsor} onChange={(e) => setR('sponsor', e.target.value)} />
            <input className="input" placeholder="Target Upline Username" required value={reg.upline} onChange={(e) => setR('upline', e.target.value)} />
            <select className="select" value={reg.upline_node} onChange={(e) => setR('upline_node', e.target.value)}>
              <option value="MA">Place under Mother Account</option>
              <option value="CA_L">Place under Child L (C1)</option>
              <option value="CA_C">Place under Child C (C2)</option>
              <option value="CA_R">Place under Child R (C3)</option>
            </select>
            <select className="select" value={reg.leg} onChange={(e) => setR('leg', e.target.value)}>
              <option value="L">Left Leg</option><option value="C">Center Leg</option><option value="R">Right Leg</option>
            </select>
          </div>
          <select className="select" required value={reg.pkg_id} onChange={(e) => setR('pkg_id', Number(e.target.value))}>
            <option value={0}>Select Package...</option>
            {packages.map((p) => <option key={p.id} value={p.id}>{p.pkg_name} ({peso(p.pkg_price)})</option>)}
          </select>

          <div className="rounded-lg border border-dashed border-sky-700 bg-sky-950/20 p-3">
            <label className="flex cursor-pointer items-center gap-2 font-bold text-sky-300">
              <input type="checkbox" className="check" checked={reg.is_free} onChange={(e) => setR('is_free', e.target.checked)} />
              Register as FREE ACCOUNT (package/rank required, no package pin/payment)
            </label>
            <p className="mt-1 text-[11px] text-zinc-400">
              Free Account uses the selected package as rank/display, but no package pin/payment is generated. <strong className="text-sky-300">Structure is identical to paid accounts:</strong> Free Mother = Mother Account (MA), Free Child = Child Account (CA). Free flags below affect earnings only — never tree, spillover, or gate logic.
            </p>
            <span className="lbl mt-2">Free Account Registration Type</span>
            <select className="select" value={reg.free_kind} onChange={(e) => setR('free_kind', e.target.value)}>
              <option value="MA">Free Mother Account (same as regular Mother / MA)</option>
              <option value="CA">Free Child Account (same as regular Child / CA)</option>
            </select>
            <p className="mt-1 text-[11px] text-amber-300"><strong>Free Child Account:</strong> set Target Upline Node = <em>Mother Account</em> and Leg = empty L/C/R under that MA. Do <em>not</em> place Free Child under another CA.</p>
            <label className="mt-2 flex items-center gap-2 text-[12px]"><input type="checkbox" className="check" checked={reg.free_receive} onChange={(e) => setR('free_receive', e.target.checked)} /> Free account can receive A+B / Trifinity pairing bonus</label>
            <label className="mt-1 flex items-center gap-2 text-[12px]"><input type="checkbox" className="check" checked={reg.free_count} onChange={(e) => setR('free_count', e.target.checked)} /> Free account can be used by uplines for A+B / Trifinity pairing points <span className="text-zinc-500">(controls upline pairing)</span></label>
            <label className="mt-1 flex items-center gap-2 text-[12px]"><input type="checkbox" className="check" checked={reg.free_dr} onChange={(e) => setR('free_dr', e.target.checked)} /> Pay DIRECT REFERRAL only to this member&apos;s sponsor/upline <span className="text-zinc-500">(does not control pairing)</span></label>
          </div>

          <button type="submit" disabled={busy || !reg.pkg_id} className="btn-gold w-full disabled:opacity-40">Register Member (Spillover Rules)</button>
        </form>
      </div>

      {/* Edit member modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Member" wide>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editing) return;
            await post({ action: 'edit-member', user_id: editing.user.id, ...ef });
            setEditing(null);
          }}
        >
          <div className="form-row">
            <div><span className="lbl">Username</span><input className="input" value={ef.username} onChange={(e) => setEf({ ...ef, username: e.target.value })} /></div>
            <div><span className="lbl">Email</span><input className="input" type="email" value={ef.email} onChange={(e) => setEf({ ...ef, email: e.target.value })} /></div>
            <div><span className="lbl">First Name</span><input className="input" value={ef.first_name} onChange={(e) => setEf({ ...ef, first_name: e.target.value })} /></div>
            <div><span className="lbl">Last Name</span><input className="input" value={ef.last_name} onChange={(e) => setEf({ ...ef, last_name: e.target.value })} /></div>
            <div><span className="lbl">Phone</span><input className="input" value={ef.phone} onChange={(e) => setEf({ ...ef, phone: e.target.value })} /></div>
            <div><span className="lbl">Birthday</span><input className="input" value={ef.bday} onChange={(e) => setEf({ ...ef, bday: e.target.value })} placeholder="MM/DD/YYYY" /></div>
            <div>
              <span className="lbl">Current Package / Rank (read-only)</span>
              <input className="input" readOnly value={editing?.user.rank ?? ''} />
              <p className="mt-0.5 text-[10px] text-zinc-500">Package/rank is not changed when saving member details.</p>
            </div>
            <div><span className="lbl">Achievement Rank</span><input className="input" value={ef.achievement} onChange={(e) => setEf({ ...ef, achievement: e.target.value })} /></div>
            <div><span className="lbl">Monthly LP</span><input className="input" type="number" min={0} value={ef.lp} onChange={(e) => setEf({ ...ef, lp: e.target.value })} /></div>
            <div><span className="lbl">Member ID Number (auto if blank)</span><input className="input" value={ef.member_id_number} onChange={(e) => setEf({ ...ef, member_id_number: e.target.value })} /></div>
            <div><span className="lbl">Member ID Expiration (required for encashment)</span><input className="input" type="date" value={ef.member_id_expires} onChange={(e) => setEf({ ...ef, member_id_expires: e.target.value })} /></div>
            <div><span className="lbl">New Password (blank = no change)</span><input className="input" type="password" value={ef.password} placeholder="********" onChange={(e) => setEf({ ...ef, password: e.target.value })} /></div>
          </div>
          <button type="submit" disabled={busy} className="btn w-full !bg-blue-700 font-bold text-white hover:!bg-blue-600">Save Changes</button>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ PLACEMENT (MOVE) ============================ */
function PlacementTab({ post, busy }: { post: PostFn; busy: boolean }) {
  const [f, setF] = React.useState({ username: '', upline: '', upline_node: 'MA', leg: 'L' });
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-amber-500">🛠️ Network Override (Move Node)</h3>
      <p className="mt-1 text-[12px] text-zinc-500">Forcefully detach a user and reattach them (and their downline) to a new position.</p>
      <form
        className="mt-3 space-y-3 rounded-lg border border-dashed border-amber-700 bg-[#0a0a0a] p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!confirmDialog('WARNING: Moving a member alters the downline. Placement must still follow spillover rules. Proceed?')) return;
          await post({ action: 'move-node', ...f });
        }}
      >
        <div><span className="lbl">User to Move</span><input className="input" required placeholder="Username to move" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></div>
        <div><span className="lbl">New Upline Username</span><input className="input" required placeholder="Target Upline Username" value={f.upline} onChange={(e) => setF({ ...f, upline: e.target.value })} /></div>
        <div>
          <span className="lbl">Target Upline Node</span>
          <select className="select" value={f.upline_node} onChange={(e) => setF({ ...f, upline_node: e.target.value })}>
            <option value="MA">Mother Account</option><option value="CA_L">Child L (C1)</option><option value="CA_C">Child C (C2)</option><option value="CA_R">Child R (C3)</option>
          </select>
        </div>
        <div>
          <span className="lbl">Target Leg Placement</span>
          <select className="select" value={f.leg} onChange={(e) => setF({ ...f, leg: e.target.value })}>
            <option value="L">Left Leg</option><option value="C">Center Leg</option><option value="R">Right Leg</option>
          </select>
        </div>
        <p className="text-[11px] text-amber-300">Moves must follow spillover rules of the target tree (same free/paid structure rules). Invalid Right/Left placements are blocked.</p>
        <button type="submit" disabled={busy} className="btn w-full !bg-amber-700 font-bold text-white hover:!bg-amber-600">Move Member (Spillover Rules)</button>
      </form>
    </div>
  );
}

/* ============================ ORDERS ============================ */
function useSelection<T extends number>(rows: T[]) {
  const [selected, setSelected] = React.useState<number[]>([]);
  const all = (on: boolean) => setSelected(on ? rows : []);
  return { selected, setSelected, all };
}

function OrdersTab({ orders, isProduct, post, busy }: { orders: (OrderRow & { username: string })[]; isProduct: boolean; post: PostFn; busy: boolean }) {
  const { selected, setSelected, all } = useSelection(orders.map((o) => Number(o.id)));
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-gold">🛒 Pending Package Orders</h3>
      <p className="mt-1 text-[12px] text-zinc-500">Approve registration package orders to generate activation codes for the member.</p>
      <div className="tbl-wrap mt-3">
        <table className="tbl">
          <thead><tr><th><input type="checkbox" className="check" onChange={(e) => all(e.target.checked)} /></th><th>Date</th><th>Member</th><th>Order Details</th></tr></thead>
          <tbody>
            {orders.length === 0 && <tr><td colSpan={4} className="text-center text-zinc-500">No pending package orders.</td></tr>}
            {orders.map((o) => (
              <tr key={String(o.id)}>
                <td><input type="checkbox" className="check" checked={selected.includes(Number(o.id))} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, Number(o.id)] : s.filter((x) => x !== Number(o.id))))} /></td>
                <td className="text-zinc-500">{dt(o.created_at, 'm/d/Y H:i')}</td>
                <td className="font-bold text-sky-400">@{o.username}</td>
                <td className="!whitespace-normal text-gold">{o.order_details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {orders.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy || !selected.length} className="btn !bg-emerald-700 font-semibold text-white hover:!bg-emerald-600 disabled:opacity-40" onClick={async () => { if (confirmDialog('Approve selected package orders and generate codes?')) await post({ action: 'orders-batch', mode: 'approve', order_ids: selected }); }}>
            Approve Selected
          </button>
          <button type="button" disabled={busy || !selected.length} className="btn-danger disabled:opacity-40" onClick={async () => { if (confirmDialog('Reject selected orders?')) await post({ action: 'orders-batch', mode: 'reject', order_ids: selected }); }}>
            Reject Selected
          </button>
        </div>
      )}
      {void isProduct}
    </div>
  );
}

function ProductOrdersTab(props: AdminProps & { post: PostFn; busy: boolean }) {
  const { pendingProdOrders, activationHistory, post, busy } = props;
  const { selected, setSelected, all } = useSelection(pendingProdOrders.map((o) => Number(o.id)));
  const [transferTarget, setTransferTarget] = React.useState('');
  const [singleTransfer, setSingleTransfer] = React.useState<(OrderRow & { username: string }) | null>(null);
  const [singleTarget, setSingleTarget] = React.useState('');

  return (
    <div className="animate-fadeIn space-y-4">
      <div className="card">
        <h3 className="text-[16px] font-bold text-violet-400">🛒 Pending Product Orders</h3>
        <p className="mt-1 text-[12px] text-zinc-500">Approve, activate, or transfer product orders. <strong>Activate</strong> = approve + generate code + mark as used + trigger commissions instantly.</p>

        {pendingProdOrders.length > 0 && (
          <div className="mt-3 rounded-lg border border-violet-700 bg-violet-950/20 p-3">
            <h4 className="text-[13px] font-bold text-violet-300">⚡ Bulk Actions</h4>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-[#0a0a0a] px-2 py-1.5 text-[12px]">
                <input type="checkbox" className="check" onChange={(e) => all(e.target.checked)} /> Select All
              </label>
              <button type="button" disabled={busy || !selected.length} className="btn btn-sm !bg-emerald-700 text-white hover:!bg-emerald-600 disabled:opacity-40" onClick={async () => { if (confirmDialog('Activate selected orders? Codes will be generated, marked as used, and commissions distributed immediately.')) await post({ action: 'orders-batch', mode: 'activate', order_ids: selected }); }}>
                ⚡ Activate
              </button>
              <button type="button" disabled={busy || !selected.length} className="btn-dark btn-sm" onClick={async () => { if (confirmDialog('Approve selected? Codes generated as UNUSED — commissions NOT triggered.')) await post({ action: 'orders-batch', mode: 'approve', order_ids: selected }); }}>
                ✓ Approve
              </button>
              <button type="button" disabled={busy || !selected.length} className="btn-danger btn-sm disabled:opacity-40" onClick={async () => { if (confirmDialog('Reject selected orders?')) await post({ action: 'orders-batch', mode: 'reject', order_ids: selected }); }}>
                Reject
              </button>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[12px] text-zinc-500">Transfer to:</span>
                <input className="input !w-[150px] !py-1.5" placeholder="Username" value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)} />
                <button type="button" disabled={busy || !selected.length || !transferTarget} className="btn-dark btn-sm disabled:opacity-40" onClick={async () => { if (confirmDialog('Transfer selected orders to the specified user?')) await post({ action: 'orders-batch', mode: 'transfer', order_ids: selected, target: transferTarget }); }}>
                  🔀 Transfer
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="tbl-wrap mt-3">
          <table className="tbl">
            <thead><tr><th>Select</th><th>Date</th><th>Member</th><th>Order Details</th><th>Actions</th></tr></thead>
            <tbody>
              {pendingProdOrders.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500">No pending product orders.</td></tr>}
              {pendingProdOrders.map((o) => (
                <tr key={String(o.id)}>
                  <td><input type="checkbox" className="check" checked={selected.includes(Number(o.id))} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, Number(o.id)] : s.filter((x) => x !== Number(o.id))))} /></td>
                  <td className="text-zinc-500">{dt(o.created_at, 'm/d/Y H:i')}</td>
                  <td className="font-bold text-violet-300">@{o.username}</td>
                  <td className="!whitespace-normal text-violet-200">{o.order_details}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" disabled={busy} className="btn-dark btn-xs" onClick={async () => { if (confirmDialog('Approve this order? Codes generated as unused; member activates from vault.')) await post({ action: 'order-single', mode: 'approve', order_id: o.id }); }}>✓ Approve</button>
                      <button type="button" disabled={busy} className="btn btn-xs !bg-emerald-700 text-white hover:!bg-emerald-600" onClick={async () => { if (confirmDialog('Activate this order? Code will be generated, marked as used, and commissions distributed immediately.')) await post({ action: 'order-single', mode: 'activate', order_id: o.id }); }}>⚡ Activate</button>
                      <button type="button" className="btn-dark btn-xs" onClick={() => { setSingleTransfer(o); setSingleTarget(''); }}>🔀 Transfer</button>
                      <button type="button" disabled={busy} className="btn-danger btn-xs" onClick={async () => { if (confirmDialog('Reject this order?')) await post({ action: 'order-single', mode: 'reject', order_id: o.id }); }}>✗ Reject</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-emerald-400">📊 Product Activation History</h3>
        <p className="text-[12px] text-zinc-500">All activated product codes, including products activated by an administrator and products activated by members for another member.</p>
        <div className="tbl-wrap mt-3">
          <table className="tbl">
            <thead><tr><th>Activated On</th><th>Product</th><th>Code</th><th>Owner</th><th>Activated For</th><th>Activated By</th><th>Source</th></tr></thead>
            <tbody>
              {activationHistory.length === 0 && <tr><td colSpan={7} className="text-center text-zinc-500">No activated product records found.</td></tr>}
              {activationHistory.map((p) => (
                <tr key={String(p.id)}>
                  <td className="text-zinc-500">{dt(p.used_at, 'm/d/Y h:i A')}</td>
                  <td className="font-bold text-emerald-300">{p.package_type}</td>
                  <td><code className="text-[11px]">{p.pin_code}</code></td>
                  <td>{p.owner || ''}</td>
                  <td>{p.recipient || ''}</td>
                  <td>{p.actor || ''}</td>
                  <td>{p.activation_source === 'admin' ? <Badge tone="info">Admin</Badge> : p.activation_source === 'member' ? <Badge tone="ok">Member</Badge> : <Badge tone="free">Legacy</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={!!singleTransfer} onClose={() => setSingleTransfer(null)} title="🔀 Transfer Order">
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (!singleTransfer) return; await post({ action: 'order-single', mode: 'transfer', order_id: singleTransfer.id, target: singleTarget }); setSingleTransfer(null); }}>
          <p className="text-[12px] text-zinc-400">Transfer order <strong>#{String(singleTransfer?.id)}</strong> from <strong>@{singleTransfer?.username}</strong> to a new member.</p>
          <div><span className="lbl">New Owner Username</span><input className="input" required placeholder="Enter username" value={singleTarget} onChange={(e) => setSingleTarget(e.target.value)} /></div>
          <button type="submit" disabled={busy} className="btn-gold w-full">🔀 Transfer Order</button>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ ENCASH ============================ */
function EncashTab({ rows, post, busy }: { rows: EncashRow[]; post: PostFn; busy: boolean }) {
  const { selected, setSelected, all } = useSelection(rows.map((r) => Number(r.id)));
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-red-400">💸 Pending Encashment Requests</h3>
      <p className="mt-1 text-[12px] text-zinc-500">Ledger rows with Encashment + Pending status. Count: <strong className="text-red-400">{rows.length}</strong></p>
      {rows.length > 0 ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !selected.length} className="btn btn-sm !bg-emerald-600 text-white hover:!bg-emerald-500 disabled:opacity-40" onClick={async () => { if (confirmDialog('Approve all selected requests?')) await post({ action: 'encash-bulk', mode: 'approve', ledger_ids: selected }); }}>
              Approve Selected
            </button>
            <button type="button" disabled={busy || !selected.length} className="btn-danger btn-sm disabled:opacity-40" onClick={async () => { if (confirmDialog('Reject all selected requests?')) await post({ action: 'encash-bulk', mode: 'reject', ledger_ids: selected }); }}>
              Reject Selected
            </button>
            <span className="text-[12px] text-zinc-500">{selected.length} selected</span>
          </div>
          <div className="tbl-wrap mt-3">
            <table className="tbl">
              <thead><tr><th><input type="checkbox" className="check" onChange={(e) => all(e.target.checked)} /></th><th>Date</th><th>Member</th><th>Requested</th><th>Details</th><th>Action</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    <td><input type="checkbox" className="check" checked={selected.includes(Number(r.id))} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, Number(r.id)] : s.filter((x) => x !== Number(r.id))))} /></td>
                    <td className="text-zinc-500">{dt(r.created_at, 'm/d/Y H:i')}</td>
                    <td>
                      <strong>@{r.username}</strong>
                      {r.state === 'pending' && <span className="block text-[10px] text-amber-300">ID: {r.member_id_number || '—'}</span>}
                    </td>
                    <td><strong className="text-red-400">{peso(Math.abs(Number(r.amount)))}</strong></td>
                    <td className="!whitespace-normal text-[12px] text-zinc-400">{r.note}</td>
                    <td>
                      <div className="flex gap-1">
                        <button type="button" disabled={busy} className="btn btn-xs !bg-emerald-600 text-white hover:!bg-emerald-500" onClick={async () => { if (confirmDialog('Mark as paid?')) await post({ action: 'encash-single', mode: 'approve', ledger_id: r.id }); }}>Approve</button>
                        <button type="button" disabled={busy} className="btn-danger btn-xs" onClick={async () => { if (confirmDialog('Reject this request?')) await post({ action: 'encash-single', mode: 'reject', ledger_id: r.id }); }}>Reject</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <Empty icon="💸">No pending encashment requests. Members request encashment from the member portal.</Empty>
      )}
    </div>
  );
}

/* ============================ REPORTS ============================ */
function SalesTab(props: AdminProps & { go: (t: string, extra?: string) => void }) {
  const [start, setStart] = React.useState(props.salesStart);
  const [end, setEnd] = React.useState(props.salesEnd);
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-gold">📈 Sales Revenue Report</h3>
      <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3" onSubmit={(e) => { e.preventDefault(); props.go('tab-sales-report', `&sales_start=${start}&sales_end=${end}`); }}>
        <div><span className="lbl">Start Date</span><input type="date" className="input !w-auto" value={start} onChange={(e) => setStart(e.target.value)} required /></div>
        <div><span className="lbl">End Date</span><input type="date" className="input !w-auto" value={end} onChange={(e) => setEnd(e.target.value)} required /></div>
        <button type="submit" className="btn-gold">Generate Report</button>
        <a className="btn-dark" href={`/api/admin/export?report=sales&format=csv&start=${start}&end=${end}`}>CSV</a>
        <a className="btn-dark" href={`/api/admin/export?report=sales&format=xls&start=${start}&end=${end}`}>Excel</a>
      </form>
      <div className="tbl-wrap mt-3">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Purchaser</th><th>Details</th><th>Code</th><th>Amount</th></tr></thead>
          <tbody>
            {props.sales.rows.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500">No sales found.</td></tr>}
            {props.sales.rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="text-zinc-500">{dt(r.created_at)}</td>
                <td className="font-bold">@{r.username}</td>
                <td className="text-gold">{r.item}</td>
                <td><code className="text-sky-400">{r.code}</code></td>
                <td><strong className="text-emerald-400">{peso(r.amount)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 rounded-lg border border-line bg-[#0a0a0a] px-4 py-3 text-right text-[15px]">
        Total Sales Revenue: <strong className="text-xl text-emerald-400">{peso(props.sales.total)}</strong>
      </div>
    </div>
  );
}

function EncashReportTab(props: AdminProps & { go: (t: string, extra?: string) => void }) {
  const [start, setStart] = React.useState(props.encashStart);
  const [end, setEnd] = React.useState(props.encashEnd);
  const rows = props.encashReportData.rows;
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-red-400">🧾 Encashment &amp; Payouts Report</h3>
      <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3" onSubmit={(e) => { e.preventDefault(); props.go('tab-encashment-report', `&encash_start=${start}&encash_end=${end}`); }}>
        <div><span className="lbl">Start Date</span><input type="date" className="input !w-auto" value={start} onChange={(e) => setStart(e.target.value)} required /></div>
        <div><span className="lbl">End Date</span><input type="date" className="input !w-auto" value={end} onChange={(e) => setEnd(e.target.value)} required /></div>
        <button type="submit" className="btn-gold">Generate Report</button>
        <a className="btn-dark" href={`/api/admin/export?report=encashments&format=csv&start=${start}&end=${end}`}>CSV</a>
      </form>
      <div className="tbl-wrap mt-3">
        <table className="tbl">
          <thead><tr><th>Date Paid</th><th>Member</th><th>Gross Amount</th><th>Tax &amp; Fees</th><th>Net Disbursed</th><th>Details</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="text-center text-zinc-500">No payouts found.</td></tr>}
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="text-zinc-500">{dt(r.created_at)}</td>
                <td className="font-bold">@{r.username}</td>
                <td className="text-zinc-400">{peso(r.gross)}</td>
                <td className="text-red-300">-{peso(r.fees)}</td>
                <td><strong className="text-emerald-400">{peso(r.net)}</strong></td>
                <td className="!whitespace-normal text-[11px] text-zinc-500">{String(r.note).replace(' - APPROVED & PAID', '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 rounded-lg border border-line bg-[#0a0a0a] px-4 py-3 text-right text-[15px]">
        Total Net Disbursed: <strong className="text-xl text-red-400">{peso(props.encashReportData.totalNet)}</strong>
      </div>
    </div>
  );
}

function PayablesTab({ overview }: { overview: AdminOverview }) {
  const p = overview.payables;
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-amber-300">💵 Payables Report</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total Bonuses Payable" value={<span className="text-amber-300">{peso(p.total)}</span>} />
        <Stat label="Uncashed" value={<span className="text-emerald-400">{peso(p.uncashed)}</span>} />
        <Stat label="Floating Payout" value={<span className="text-violet-300">{peso(p.floating)}</span>} />
      </div>
      <div className="tbl-wrap mt-3">
        <table className="tbl">
          <thead><tr><th>Member</th><th>User ID</th><th>Category</th><th>Available</th><th>Total Earned</th><th>Deductions / Encashments</th></tr></thead>
          <tbody>
            {p.rows.length === 0 && <tr><td colSpan={6} className="text-center text-zinc-500">No payable balances found.</td></tr>}
            {p.rows.map((r) => (
              <tr key={r.user_id}>
                <td className="font-bold">@{r.username}</td>
                <td>{r.user_id}</td>
                <td>{r.category === 'Uncashed' ? <Badge tone="ok">Uncashed</Badge> : <Badge tone="violet">Floating Payout</Badge>}</td>
                <td className="font-bold text-emerald-400">{peso(r.available)}</td>
                <td>{peso(r.earned)}</td>
                <td className="text-red-400">-{peso(r.deducted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ ADMIN TREE ============================ */
function TreeTabAdmin(props: AdminProps) {
  const [target, setTarget] = React.useState(props.treeTarget);
  const focus = props.treeRoot;
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-gold">🌳 Genealogy Viewer</h3>
      <form
        className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3"
        onSubmit={(e) => { e.preventDefault(); window.location.href = `?tab=tab-tree&admin_target_user=${encodeURIComponent(target)}`; }}
      >
        <span className="lbl !mb-0">Search Node by Username:</span>
        <input className="input !w-[220px]" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Username" />
        <button type="submit" className="btn-gold">Load Tree</button>
        {props.treeFocusId !== props.treeRootId && (
          <a className="btn-dark btn-sm" href={`?tab=tab-tree&admin_target_user=${encodeURIComponent(props.treeTarget)}`}>Back to Top Node</a>
        )}
      </form>
      {focus && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-[#0a0a0a] px-3 py-2 text-[12px]">
          <strong className="text-gold">Waiting / Pairing Status:</strong>
          <span>Selected: <strong>@{focus.username}</strong></span>
          <span>Type: <strong>{focus.type}</strong></span>
          <span>Rank: <strong>{focus.rank}</strong></span>
          <span>L: <strong>{focus.points.L}</strong></span>
          <span>C: <strong>{focus.points.C}</strong></span>
          <span>R: <strong>{focus.points.R}</strong></span>
          <span>Tri triggers: <strong>{focus.pairing_count}</strong></span>
        </div>
      )}
      <p className="mt-2 text-[12px] text-sky-400">Click on any child node below to view its network. Use Network Override to move nodes.</p>
      {focus ? (
        <TreeView
          root={focus}
          slotStates={{} as Record<string, SlotInfo>}
          onNodeClick={(id) => { window.location.href = `?tab=tab-tree&admin_target_user=${encodeURIComponent(props.treeTarget)}&admin_view_node=${id}`; }}
        />
      ) : (
        <Empty icon="🌳">No accounts found for this user.</Empty>
      )}
    </div>
  );
}

/* ============================ LOGS ============================ */
const LOG_CATEGORIES: [string, string][] = [
  ['all', 'All Categories'], ['system', 'System / Rebuild'], ['registration', 'Registration'],
  ['purchase', 'Purchase / Orders'], ['transfer', 'Transfers'], ['encashment', 'Encashment'],
  ['profile', 'Profile / Details'], ['settings', 'Settings'], ['backup', 'Backup / Restore'],
  ['admin', 'Admin Actions'], ['member', 'Member Actions'], ['danger', 'Danger Zone'],
];

function LogsTab(props: AdminProps & { post: PostFn; busy: boolean }) {
  const { logs, logCategory, post, busy } = props;
  const { selected, setSelected, all } = useSelection(logs.map((l) => Number(l.id)));
  const [clearText, setClearText] = React.useState('');
  return (
    <div className="card animate-fadeIn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[16px] font-bold text-gold">📜 Activity Logs</h3>
        <select className="select !w-auto" value={logCategory} onChange={(e) => { window.location.href = `?tab=tab-logs&log_category=${encodeURIComponent(e.target.value)}`; }}>
          {LOG_CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <p className="mt-1 text-[12px] text-zinc-500">Tracks member and admin actions such as earnings recalculation, registrations, profile/detail changes, orders, transfers, encashments, backup/restore, and settings changes. Sensitive passwords are hidden.</p>

      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3">
        <form className="flex items-center gap-2" onSubmit={async (e) => { e.preventDefault(); if (confirmDialog('Delete ALL activity logs? This cannot be undone.')) await post({ action: 'logs-clear', confirm: clearText }); }}>
          <input className="input !w-[140px]" placeholder="Type CLEAR" value={clearText} onChange={(e) => setClearText(e.target.value)} />
          <button type="submit" disabled={busy} className="btn-danger btn-sm">Clear All Activity Logs</button>
        </form>
        <span className="text-[11px] text-amber-300">Tip: use checkboxes below to delete selected log rows only.</span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={busy || !selected.length} className="btn-danger btn-sm disabled:opacity-40" onClick={async () => { if (confirmDialog('Delete selected activity log rows?')) await post({ action: 'logs-delete', log_ids: selected }); }}>
          Delete Selected Logs
        </button>
        <span className="text-[11px] text-zinc-500">{selected.length} selected</span>
      </div>

      <div className="tbl-wrap mt-2 max-h-[600px] overflow-y-auto">
        <table className="tbl">
          <thead><tr><th><input type="checkbox" className="check" onChange={(e) => all(e.target.checked)} /></th><th>Date &amp; Time</th><th>Actor</th><th>Role</th><th>Category</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan={9} className="text-center text-zinc-500">No logs found.</td></tr>}
            {logs.map((l) => (
              <tr key={String(l.id)}>
                <td><input type="checkbox" className="check" checked={selected.includes(Number(l.id))} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, Number(l.id)] : s.filter((x) => x !== Number(l.id))))} /></td>
                <td className="text-zinc-500">{dt(l.created_at)}<span className="block text-[10px]">Log ID: {String(l.id)}</span></td>
                <td>@{l.actor_username}<span className="block text-[10px] text-zinc-500">ID: {String(l.actor_user_id)}</span></td>
                <td>{l.actor_role}</td>
                <td><Badge tone="gold">{l.category}</Badge></td>
                <td>{l.action}</td>
                <td>{l.target_username ? `@${l.target_username}` : '-'}</td>
                <td className="!whitespace-normal break-words text-[11px]">{String(l.details).slice(0, 350)}</td>
                <td className="text-zinc-500">{l.ip_address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ UNILEVEL (ADMIN) ============================ */
function UnilevelAdminTab({ report, post, busy }: { report: UnilevelReport; post: PostFn; busy: boolean }) {
  const r = report;
  return (
    <div className="animate-fadeIn space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Unilevel Released (All-Time)" value={peso(r.released)} />
        <Stat label="Pending Cutoff (Held)" value={<span className="text-amber-300">{peso(r.pending)}</span>} sub="Released at monthly cutoff" />
        <Stat label="Members Earning Unilevel" value={String(r.earners)} />
        <Stat label="Crediting Mode" value={r.cutoffHold ? 'Monthly Cutoff' : 'Instant'} sub={r.monthlyReset ? 'LP resets monthly (5 LP to qualify)' : 'Lifetime LP (5 LP to qualify)'} />
      </div>

      <div className="card">
        <h3 className="text-[16px] font-bold text-gold">📶 Unilevel Commission Matrix (₱ per bottle)</h3>
        <p className="mt-1 text-[12px] text-zinc-500">Dynamic compression: Starter / under-maintained / CA-connector uplines are skipped without consuming a paid tier. Edit the rates in Comp. Plan settings (Unilevel Levels 1–10).</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {r.rates.map((rate, i) => (
            <div key={i} className="rounded-lg border border-line bg-[#0a0a0a] px-3 py-2 text-center">
              <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Level {i + 1}</div>
              <div className="text-[15px] font-extrabold text-zinc-100">{peso(rate)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ borderColor: '#065f46' }}>
        <h3 className="text-[15px] font-bold text-emerald-400">🧾 Unilevel Code Requests</h3>
        <p className="mt-1 text-[12px] text-zinc-500">Members request Unilevel Codes (separate UNI-… series) from their Unilevel tab — no Product Orders checkout. Approving issues the codes straight into the member&apos;s My Products vault. Product Commission code requests (PCC-…) are handled in the Product Commission tab.</p>
        {report.codeRequests.filter((r) => r.status === 'pending').length === 0 && (
          <p className="mt-3 text-[13px] text-zinc-500">No pending requests.</p>
        )}
        <div className="mt-2 space-y-2">
          {report.codeRequests.filter((r) => r.status === 'pending').map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-[#0a0a0a] px-3 py-2">
              <div className="text-[13px]">
                <strong className="text-zinc-100">@{r.username}</strong>{' '}
                <span className="text-zinc-400">{String(r.order_details || '').replace(/^UNILEVEL CODE REQUEST:\s*/i, '')}</span>{' '}
                <span className="text-zinc-600">· {dt(r.created_at)}</span>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={busy} className="btn !bg-emerald-700 px-3 py-1.5 text-[12px] font-bold text-white hover:!bg-emerald-600 disabled:opacity-40" onClick={async () => { await post({ action: 'unilevel-code-approve', order_id: r.id }); }}>
                  ✓ Approve &amp; Issue Codes
                </button>
                <button type="button" disabled={busy} className="btn !bg-red-900 px-3 py-1.5 text-[12px] font-bold text-white hover:!bg-red-800 disabled:opacity-40" onClick={async () => { await post({ action: 'unilevel-code-reject', order_id: r.id }); }}>
                  ✕ Reject
                </button>
              </div>
            </div>
          ))}
        </div>
        {report.codeRequests.filter((r) => r.status !== 'pending').length > 0 && (
          <div className="tbl-wrap mt-3">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Member</th><th>Request</th><th>Status</th></tr></thead>
              <tbody>
                {report.codeRequests.filter((r) => r.status !== 'pending').map((r) => (
                  <tr key={r.id}>
                    <td className="text-zinc-500">{dt(r.created_at)}</td>
                    <td>@{r.username}</td>
                    <td className="!whitespace-normal">{String(r.order_details || '').replace(/^UNILEVEL CODE REQUEST:\s*/i, '')}</td>
                    <td>{r.status === 'approved' ? <span className="font-semibold text-emerald-400">✓ Approved</span> : <span className="font-semibold text-red-400">✕ Rejected</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-emerald-400">Per-Member Unilevel Earnings</h3>
        <div className="tbl-wrap mt-2">
          <table className="tbl">
            <thead><tr><th>Member</th><th>Rank</th><th>LP</th><th>Eligible (≥5 LP)</th><th>Released</th><th>Pending Cutoff</th><th>Total</th></tr></thead>
            <tbody>
              {r.rows.length === 0 && <tr><td colSpan={7} className="text-center text-zinc-500">No Unilevel earnings recorded yet.</td></tr>}
              {r.rows.map((m) => (
                <tr key={m.user_id}>
                  <td className="font-semibold text-zinc-100">@{m.username}</td>
                  <td>{m.rank}</td>
                  <td>{m.lp} LP</td>
                  <td>{m.eligible ? <span className="text-emerald-400">Yes ✓</span> : <span className="text-amber-300">No</span>}</td>
                  <td>{peso(m.released)}</td>
                  <td className="text-amber-300">{peso(m.pending)}</td>
                  <td className="font-bold text-zinc-100">{peso(m.released + m.pending)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-emerald-400">Recent Unilevel Entries</h3>
        <div className="tbl-wrap mt-2">
          <table className="tbl">
            <thead><tr><th>Date &amp; Time</th><th>Member</th><th>Details</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {r.recent.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500">No entries yet.</td></tr>}
              {r.recent.map((l) => (
                <tr key={l.id}>
                  <td className="text-zinc-500">{dt(l.created_at)}</td>
                  <td>@{l.username}</td>
                  <td className="!whitespace-normal">{l.note}</td>
                  <td>{l.status === 'hang' ? <span className="font-semibold text-amber-300">⏳ Pending Cutoff</span> : <span className="font-semibold text-emerald-400">Released</span>}</td>
                  <td className="font-bold text-emerald-400">+{peso(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================ PRODUCT COMMISSION (ADMIN) ============================ */
function ProductCommAdminTab({ report, post, busy }: { report: ProductCommReport; post: PostFn; busy: boolean }) {
  const r = report;
  return (
    <div className="animate-fadeIn space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Product Comm Released (All-Time)" value={peso(r.released)} />
        <Stat label="Pending Cutoff (Held)" value={<span className="text-amber-300">{peso(r.pending)}</span>} sub="Released monthly with Unilevel" />
        <Stat label="Starter Bottles Credited" value={String(r.bottles)} sub={`At ${peso(r.perBottle)} per bottle`} />
        <Stat label="Members Earning" value={String(r.earners)} />
      </div>

      <div className="card" style={{ borderColor: '#0e7490' }}>
        <h3 className="text-[16px] font-bold text-cyan-300">🧴 Product Commission Rule</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          Paid only to the <strong className="text-zinc-300">direct sponsor</strong> of a Starter member, on that Starter&apos;s repeat product
          activations (Product Codes from Product Orders — separate from package codes). The sponsor must be
          <strong className="text-zinc-300"> Premium or StarPremium</strong> with at least <strong className="text-zinc-300">5 LP maintenance</strong>.
          Earnings are held as Pending Cutoff and released monthly together with Unilevel. Rate is editable in
          Comp. Plan settings (Starter Repeat-Order Product Comm).
        </p>
      </div>

      <div className="card" style={{ borderColor: '#0e7490' }}>
        <h3 className="text-[15px] font-bold text-cyan-300">🧾 Product Code Requests</h3>
        <p className="mt-1 text-[12px] text-zinc-500">Members request Product Codes from their Product Commission tab (no Product Orders checkout). Approving issues the codes straight into the member&apos;s My Products vault.</p>
        {report.codeRequests.filter((r) => r.status === 'pending').length === 0 && (
          <p className="mt-3 text-[13px] text-zinc-500">No pending requests.</p>
        )}
        <div className="mt-2 space-y-2">
          {report.codeRequests.filter((r) => r.status === 'pending').map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-[#0a0a0a] px-3 py-2">
              <div className="text-[13px]">
                <strong className="text-zinc-100">@{r.username}</strong>{' '}
                <span className="text-zinc-400">{String(r.order_details || '').replace(/^CODE REQUEST:\s*/i, '')}</span>{' '}
                <span className="text-zinc-600">· {dt(r.created_at)}</span>
              </div>
              <div className="flex gap-2">
                <button type="button" disabled={busy} className="btn !bg-emerald-700 px-3 py-1.5 text-[12px] font-bold text-white hover:!bg-emerald-600 disabled:opacity-40" onClick={async () => { await post({ action: 'code-request-approve', order_id: r.id }); }}>
                  ✓ Approve &amp; Issue Codes
                </button>
                <button type="button" disabled={busy} className="btn !bg-red-900 px-3 py-1.5 text-[12px] font-bold text-white hover:!bg-red-800 disabled:opacity-40" onClick={async () => { await post({ action: 'code-request-reject', order_id: r.id }); }}>
                  ✕ Reject
                </button>
              </div>
            </div>
          ))}
        </div>
        {report.codeRequests.filter((r) => r.status !== 'pending').length > 0 && (
          <div className="tbl-wrap mt-3">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Member</th><th>Request</th><th>Status</th></tr></thead>
              <tbody>
                {report.codeRequests.filter((r) => r.status !== 'pending').map((r) => (
                  <tr key={r.id}>
                    <td className="text-zinc-500">{dt(r.created_at)}</td>
                    <td>@{r.username}</td>
                    <td className="!whitespace-normal">{String(r.order_details || '').replace(/^CODE REQUEST:\s*/i, '')}</td>
                    <td>{r.status === 'approved' ? <span className="font-semibold text-emerald-400">✓ Approved</span> : <span className="font-semibold text-red-400">✕ Rejected</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-cyan-300">Per-Member Product Commission</h3>
        <div className="tbl-wrap mt-2">
          <table className="tbl">
            <thead><tr><th>Member (Sponsor)</th><th>Rank</th><th>Bottles Credited</th><th>Released</th><th>Pending Cutoff</th><th>Total</th></tr></thead>
            <tbody>
              {r.rows.length === 0 && <tr><td colSpan={6} className="text-center text-zinc-500">No Product Commission recorded yet.</td></tr>}
              {r.rows.map((m) => (
                <tr key={m.user_id}>
                  <td className="font-semibold text-zinc-100">@{m.username}</td>
                  <td>{m.rank}</td>
                  <td>{m.bottles}</td>
                  <td>{peso(m.released)}</td>
                  <td className="text-amber-300">{peso(m.pending)}</td>
                  <td className="font-bold text-zinc-100">{peso(m.released + m.pending)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-cyan-300">Recent Product Commission Entries</h3>
        <div className="tbl-wrap mt-2">
          <table className="tbl">
            <thead><tr><th>Date &amp; Time</th><th>Member (Sponsor)</th><th>Details</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {r.recent.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500">No entries yet.</td></tr>}
              {r.recent.map((l) => (
                <tr key={l.id}>
                  <td className="text-zinc-500">{dt(l.created_at)}</td>
                  <td>@{l.username}</td>
                  <td className="!whitespace-normal">{l.note}</td>
                  <td>{l.status === 'hang' ? <span className="font-semibold text-amber-300">⏳ Pending Cutoff</span> : <span className="font-semibold text-emerald-400">Released</span>}</td>
                  <td className="font-bold text-emerald-400">+{peso(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================ SETTINGS ============================ */
function SettingsTab(props: AdminProps & { post: PostFn; busy: boolean }) {
  const { post } = props;
  const v = props.settingsValues;
  const [f, setF] = React.useState<Record<string, string>>({
    dr_starter: v.mlm_sys_dr_starter ?? '50', dr_premium: v.mlm_sys_dr_premium ?? '300', dr_star: v.mlm_sys_dr_starpremium ?? '1000',
    starter_prod_comm: v.mlm_sys_product_comm_starter ?? '20',
    bp_amount: v.mlm_sys_bp_amount ?? '200', tri_premium: v.mlm_sys_tri_premium ?? '300',
    rpts_premium: v.mlm_sys_rpts_premium ?? '1', rpts_star: v.mlm_sys_rpts_starpremium ?? '2',
    lim_premium: v.mlm_sys_limit_premium ?? '15', lim_star: v.mlm_sys_limit_starpremium ?? '30',
    lim_ca_premium: v.mlm_sys_limit_ca_premium ?? '10', lim_ca_star: v.mlm_sys_limit_ca_starpremium ?? '20',
    gc_every: v.mlm_sys_gc_every ?? '5', max_depth: v.mlm_sys_max_depth ?? '8',
    tax: v.mlm_sys_tax ?? '10', fee: v.mlm_sys_fee ?? '20', transfer_fee: v.mlm_sys_fund_transfer_fee ?? '25', min_encash: v.mlm_sys_min_encash ?? '1000',
    uni_monthly_reset: v.mlm_sys_unilevel_monthly_reset ?? '1', uni_cutoff_hold: v.mlm_sys_unilevel_cutoff_hold ?? '1', auto_approve: v.mlm_sys_auto_approve_products ?? '0',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`uni_l${i + 1}`, v[`mlm_sys_uni_l${i + 1}`] ?? String([5, 4, 3, 2, 1, 1, 1, 1, 1, 1][i])])),
  });
  const set = (k: string, val: string) => setF((s) => ({ ...s, [k]: val }));
  const [rebuildMsg, setRebuildMsg] = React.useState(props.rebuildState.message || 'Ready.');
  const [rebuildPct, setRebuildPct] = React.useState(0);
  const [wipeText, setWipeText] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [restoreText, setRestoreText] = React.useState('');

  async function runBatch() {
    if (!confirmDialog('BATCH EARNINGS REBUILD: This wipes and recalculates ALL pairing, Tri-Leg, Flush Out, GC, and Direct Referral bonuses, then resyncs wallets. Continue?')) return;
    const start = await post({ action: 'rebuild-start' }, 'Batch rebuild started.');
    let state = start.state;
    let guard = 0;
    while (state && state.status !== 'done' && state.status !== 'error' && guard++ < 400) {
      setRebuildMsg(state.message || `Step ${state.step}…`);
      setRebuildPct(Math.min(100, Math.round(((state.step - 1) * 100 + Math.min(99, state.total ? (state.offset / Math.max(1, state.total)) * 100 : 0)) / 5)));
      const next = await api<{ state: RebuildRow }>('/api/admin', { action: 'rebuild-step', batch_id: state.batch_id });
      state = next.state;
    }
    if (state) {
      setRebuildPct(state.status === 'done' ? 100 : rebuildPct);
      setRebuildMsg(state.status === 'done' ? `✅ ${state.message}` : `⛔ ${state.message}`);
      if (state.status === 'done') reloadSoon(1600);
    }
  }

  async function onRestoreFile(file: File) {
    if (restoreText !== 'RESTORE') { alert('Type RESTORE to confirm the restore operation.'); return; }
    if (!confirmDialog('CRITICAL: Restore will replace members, genealogy, pins, ledger earnings, orders, packages, and MLM settings with the backup file. Continue?')) return;
    const text = await file.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { alert('Invalid JSON file.'); return; }
    await post({ action: 'restore-backup', confirm: 'RESTORE', backup: json });
  }

  const numField = (label: string, key: string, step = '0.01') => (
    <div><span className="lbl">{label}</span><input type="number" step={step} className="input" value={f[key]} onChange={(e) => set(key, e.target.value)} /></div>
  );

  return (
    <div className="animate-fadeIn space-y-4">
      <div className="card">
        <h3 className="text-[16px] font-bold text-sky-400">⚙️ Compensation Plan Settings</h3>
        <p className="mt-1 text-[12px] text-zinc-500">
          All earning amounts below are live for new qualifying events. Current final limits: MA Premium 15/day, MA StarPremium 30/day, CA Premium 10/day, CA StarPremium 20/day. Daily reset is 12:01 AM Philippine time. For historical correction, run the Batch Recalculate after saving.
        </p>
        <form
          className="mt-4 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await post({
              action: 'settings-save',
              values: {
                mlm_sys_dr_starter: f.dr_starter, mlm_sys_dr_premium: f.dr_premium, mlm_sys_dr_starpremium: f.dr_star,
                mlm_sys_product_comm_starter: f.starter_prod_comm,
                mlm_sys_bp_amount: f.bp_amount, mlm_sys_tri_premium: f.tri_premium,
                mlm_sys_rpts_premium: f.rpts_premium, mlm_sys_rpts_starpremium: f.rpts_star,
                mlm_sys_limit_premium: f.lim_premium, mlm_sys_limit_starpremium: f.lim_star,
                mlm_sys_limit_ca_premium: f.lim_ca_premium, mlm_sys_limit_ca_starpremium: f.lim_ca_star,
                mlm_sys_gc_every: f.gc_every, mlm_sys_max_depth: f.max_depth,
                mlm_sys_tax: f.tax, mlm_sys_fee: f.fee, mlm_sys_fund_transfer_fee: f.transfer_fee, mlm_sys_min_encash: f.min_encash,
                mlm_sys_unilevel_monthly_reset: f.uni_monthly_reset === '1', mlm_sys_unilevel_cutoff_hold: f.uni_cutoff_hold === '1',
                mlm_sys_auto_approve_products: f.auto_approve === '1',
                ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`mlm_sys_uni_l${i + 1}`, f[`uni_l${i + 1}`]])),
              },
            });
          }}
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
              <h4 className="text-[14px] font-bold text-gold">🎁 Direct Referral Bonus</h4>
              <p className="text-[11px] text-zinc-500">Credited to the DIRECT SPONSOR ONLY. Any pairing involving a Starter pays the flat Starter DR: Starter sponsor → Starter/Premium/StarPremium = ₱50, and Premium/StarPremium sponsor → Starter = ₱50. Starter accounts earn no pairing points until they upgrade to Premium/StarPremium (upgrade pays no DR).</p>
              <div className="mt-2 space-y-2">
                {numField('Starter DR — any Starter pairing (₱)', 'dr_starter')}
                {numField('Premium Package DR (₱)', 'dr_premium')}
                {numField('StarPremium Package DR (₱)', 'dr_star')}
                {numField('Starter Repeat-Order Product Comm (₱/bottle)', 'starter_prod_comm')}
              </div>
              <p className="text-[11px] text-zinc-500">Product Comm: a Premium/StarPremium member earns this per bottle on direct Starter repeat orders, only after meeting the 5 LP maintenance requirement. Credited monthly together with Unilevel.</p>
            </div>
            <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
              <h4 className="text-[14px] font-bold text-gold">📋 Pairing Bonuses</h4>
              <p className="text-[11px] text-zinc-500">A+B is point-based: Premium=1 point, StarPremium=3 points. Each matched A+B point pays the A+B amount; every Nth matched point gives 1 GC. Tri-Leg uses completed A+B triggers plus C/right-leg points; payout follows receiver rank and right-source package.</p>
              <div className="mt-2 space-y-2">
                {numField('Binary Pair A+B Amount (₱)', 'bp_amount')}
                {numField('Tri-Leg C Bonus per Unit (₱)', 'tri_premium')}
                {numField('C/Right-Leg Points per Premium Member', 'rpts_premium', '1')}
                {numField('C/Right-Leg Points per StarPremium Member', 'rpts_star', '1')}
              </div>
              <p className="text-[11px] text-zinc-500">Premium receiver = 1 unit × this amount. StarPremium receiver + StarPremium source = 2 units × this amount (e.g. ₱300 × 2 = ₱600).</p>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
            <h4 className="text-[14px] font-bold text-gold">📈 Unilevel Commission Matrix (₱ per bottle)</h4>
            <p className="text-[11px] text-zinc-500">Commission earned per bottle sold at each genealogy level. Sponsor must have ≥5 LP in the current month to qualify.</p>
            <span className="lbl mt-3">Monthly LP Reset</span>
            <select className="select" value={f.uni_monthly_reset} onChange={(e) => set('uni_monthly_reset', e.target.value)}>
              <option value="1">ON — reset every month (must re-qualify ≥5 LP monthly)</option>
              <option value="0">OFF — lifetime LP (earnings released realtime, no reset)</option>
            </select>
            <span className="lbl mt-3">Unilevel Cutoff Hold</span>
            <select className="select" value={f.uni_cutoff_hold} onChange={(e) => set('uni_cutoff_hold', e.target.value)}>
              <option value="1">ON — visible immediately, withdrawable after monthly cutoff</option>
              <option value="0">OFF — withdrawable immediately</option>
            </select>
            <div className="mt-3 rounded-lg border border-line bg-black px-3 py-2 text-center text-[13px] font-bold text-emerald-400">
              🧩 DYNAMIC COMPRESSION — <span className="font-normal text-zinc-400">eligible sponsor-chain uplines are paid by compressed tier after CA connector nodes and ineligible MA uplines are skipped. This is the ONLY mode.</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i}><span className="lbl">Level {i + 1}</span><input type="number" step="0.01" min={0} className="input" value={f[`uni_l${i + 1}`]} onChange={(e) => set(`uni_l${i + 1}`, e.target.value)} /></div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
              <h4 className="text-[14px] font-bold text-gold">🕐 Daily Pairing Limits</h4>
              <div className="space-y-2">
                {numField('MA Premium — Max A+B / C Releases per Day', 'lim_premium', '1')}
                {numField('MA StarPremium — Max A+B / C Releases per Day', 'lim_star', '1')}
                {numField('CA Premium — Max A+B / C Releases per Day', 'lim_ca_premium', '1')}
                {numField('CA StarPremium — Max A+B / C Releases per Day', 'lim_ca_star', '1')}
              </div>
              <h4 className="mt-4 text-[14px] font-bold text-gold">🎟️ GC Rule (Every Nth)</h4>
              <p className="text-[11px] text-zinc-500">Every Nth A+B pair gives 1 GC instead of A+B cash. Every Nth Tri-Leg/C-leg unit also gives 1 GC instead of C-leg cash. Default is every 5th.</p>
              {numField('Award 1 GC every Nth pair/unit (default 5)', 'gc_every', '1')}
              <h4 className="mt-4 text-[14px] font-bold text-violet-300">📊 Trinary Structure Depth</h4>
              <p className="text-[11px] text-zinc-500">8 = full 3-Level framework (13 + 351 + 9,477 = 9,841 capacity). Each +3 adds another level group.</p>
              {numField('Max placement depth below root', 'max_depth', '1')}
            </div>
            <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
              <h4 className="text-[14px] font-bold text-red-400">💰 Encashment &amp; Deductions</h4>
              <div className="space-y-2">
                {numField('Minimum Encashment (₱)', 'min_encash')}
                {numField('Tax Deduction (%)', 'tax')}
                {numField('System Fee — Flat Rate (₱)', 'fee')}
                {numField('Fund Transfer Fee (₱)', 'transfer_fee')}
              </div>
              <h4 className="mt-4 text-[14px] font-bold text-emerald-400">⚡ Product Order Auto-Approval</h4>
              <p className="text-[11px] text-zinc-500">Automatically approve product orders (not registration packages) when submitted. Pins are generated as unused; commissions distribute when the member activates.</p>
              <select className="select" value={f.auto_approve} onChange={(e) => set('auto_approve', e.target.value)}>
                <option value="0">OFF — Manual approval required (admin reviews each order)</option>
                <option value="1">ON — Auto-approve product orders instantly</option>
              </select>
            </div>
          </div>

          <button type="submit" disabled={props.busy} className="btn-gold w-full">💾 Save All Compensation Settings</button>
        </form>
      </div>

      {/* Maintenance */}
      <div className="card">
        <h3 className="text-[15px] font-bold text-sky-400">🔄 System Maintenance</h3>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-[#0a0a0a] p-3">
          <div>
            <strong>🔧 Maintenance Mode</strong>
            <p className="text-[11px] text-zinc-500">When enabled, members see a &quot;System Under Maintenance&quot; screen. Admin access is NOT affected.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cx('badge', props.maintenance ? 'badge-bad' : 'badge-ok')}>{props.maintenance ? 'ON — Members Blocked' : 'OFF — System Live'}</span>
            <button type="button" disabled={props.busy} className={cx('btn btn-sm font-bold text-white', props.maintenance ? '!bg-emerald-600 hover:!bg-emerald-500' : '!bg-red-600 hover:!bg-red-500')} onClick={async () => { if (confirmDialog(props.maintenance ? 'Disable maintenance mode?' : 'Enable maintenance mode? Members will NOT be able to access the system.')) await props.post({ action: 'maintenance-toggle' }); }}>
              {props.maintenance ? 'Go Live' : 'Enable Maintenance'}
            </button>
          </div>
        </div>

        {/* Batch rebuild */}
        <p className="mt-4 text-[12px] text-zinc-400">
          <strong className="text-emerald-400">Batch Earnings Rebuild:</strong> wipes and replays ALL engine earnings from the network structure — A+B Pairs, Tri-Leg Releases, Flush Outs, <strong>GC awards</strong>, Direct Referral bonuses (direct sponsor only), then resyncs every wallet balance exactly to the ledger. <strong>Unilevel commissions are rebuilt from used product activations using the current dynamic compression + LP eligibility rules.</strong> Encashment history is preserved. Runs in batches to avoid slow/frozen page loading.
        </p>
        <div className="mt-2 rounded-lg border border-line bg-[#0a0a0a] p-3">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn !bg-emerald-700 font-semibold text-white hover:!bg-emerald-600" onClick={runBatch}>🔄 Start Batch Recalculate</button>
            <button type="button" disabled={props.busy} className="btn-dark btn-sm" onClick={async () => { if (confirmDialog('Run the one-shot FULL rebuild now? (Fine for small networks.)')) { const r = await props.post({ action: 'rebuild-full' }); setRebuildMsg(r.message || 'Full rebuild complete.'); } }}>
              One-shot Full Rebuild
            </button>
            <span className="text-[12px] text-zinc-400">{rebuildMsg}</span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full border border-line bg-black">
            <div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all" style={{ width: `${rebuildPct}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">This may take several minutes on a large network. Keep this tab open until complete.</p>
        </div>
      </div>

      {/* Backup / restore */}
      <div className="card" style={{ borderColor: '#1d4ed8' }}>
        <h3 className="text-[15px] font-bold text-sky-400">💾 Backup / Restore System Data</h3>
        <p className="mt-1 text-[12px] text-zinc-500">Download a full JSON backup of members, genealogy/accounts, pins/codes, ledger earnings, orders, packages, and MLM settings. Use Restore only for emergency recovery. Admin login user ID 1 is preserved to avoid lockout.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
            <h4 className="font-bold text-emerald-400">Export Backup</h4>
            <a className="btn mt-2 inline-flex !bg-emerald-700 font-semibold text-white hover:!bg-emerald-600" href="/api/admin/backup">Download Full Backup</a>
          </div>
          <div className="rounded-lg border border-red-900 bg-[#0a0a0a] p-4">
            <h4 className="font-bold text-red-300">Restore Backup</h4>
            <span className="lbl mt-2">Backup JSON file</span>
            <input ref={fileRef} type="file" accept=".json,application/json" className="input" />
            <span className="lbl mt-2">Type RESTORE to confirm</span>
            <input className="input" placeholder="RESTORE" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
            <button type="button" disabled={props.busy} className="btn mt-2 w-full !bg-red-800 font-semibold text-white hover:!bg-red-700" onClick={() => { const file = fileRef.current?.files?.[0]; if (file) void onRestoreFile(file); else alert('Please choose a backup file to restore.'); }}>
              Restore Full Backup
            </button>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div className="card" style={{ borderColor: '#7f1d1d' }}>
        <h3 className="text-[15px] font-bold text-red-400">⚠️ Danger Zone: System Wipes</h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <button type="button" disabled={props.busy} className="btn-danger" onClick={async () => { if (confirmDialog('WARNING: This will zero out ghost left/center/right points across the network. Proceed?')) await props.post({ action: 'wipe-points' }); }}>
            Wipe Ghost Points
          </button>
          <div className="flex items-end gap-2">
            <div><span className="lbl">Type WIPE to confirm</span><input className="input !w-[140px]" value={wipeText} onChange={(e) => setWipeText(e.target.value)} placeholder="WIPE" /></div>
            <button type="button" disabled={props.busy || wipeText !== 'WIPE'} className="btn !bg-red-800 font-semibold text-white hover:!bg-red-700 disabled:opacity-40" onClick={async () => { if (confirmDialog('CRITICAL WARNING: This deletes ALL ledger entries, earnings, wallet balances, orders/sales, used/pending pins, and resets pairing points. THIS CANNOT BE UNDONE. Proceed?')) await props.post({ action: 'wipe-ledger', confirm: wipeText }); }}>
              Total Financial Wipe
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ INSTRUCTIONS ============================ */
function InstructionsTab() {
  const sections: [string, string[]][] = [
    ['1. Account Types & Packages', [
      'Starter / ₱388: ₱50 Direct Referral on any sponsored package (Starter, Premium or StarPremium). No pairing points, no A+B, no Tri-Leg, no GC, no unilevel — until upgraded to Premium or StarPremium, when pairing points start counting (no DR on the upgrade itself).',
      'Premium: 1 point on A/B side, 1 point on C/right side; normal A+B and Tri-Leg participation.',
      'StarPremium: 3 points on A/B side, 2 points on C/right side; may receive two ₱300 Tri-Leg units when paired with a StarPremium right-source.',
      'Mother Account (MA): a normal member node that can build genealogy. A Free Mother Account uses the same structure and spillover, with earning restrictions set by Admin.',
      'Child Account (CA): optional C1/C2/C3 separate user nodes under the Mother Account. A Free Child Account uses the same child structure.',
    ]],
    ['2. Registration, Vault & Codes', [
      'Members register from the public registration page and wait for admin approval/payment confirmation.',
      'Activation codes are stored in the member\'s Package/Product Vault.',
      'Members can register downlines using available package codes and transfer codes to another username.',
      'Product retail codes can be activated for self or a target username; unilevel goes to the target\'s sponsor chain.',
      'Password rule: minimum 6 alphanumeric characters, no spaces or symbols.',
    ]],
    ['3. Genealogy & Placement', [
      'Placement is trinary: A/Left, B/Center, C/Right. Points for an account start from members under its direct children.',
      'Strict spillover: before the owner gate (3 direct + CA rows) completes, no spillover; after the gate, Right→Right→Right only.',
      'Default max placement depth is 8 below a root (Level 1: 13, Level 2: 351, Level 3: 9,477 per root).',
      'Genealogy colors: Child Account = blue, StarPremium = black, Premium = yellow.',
    ]],
    ['4. A+B Pairing', [
      'Point-based from Left + Center points. Premium = 1 point, StarPremium = 3 points.',
      'Each matched point pays the configured A+B amount (default ₱200); every Nth (default 5th) gives 1 GC instead of cash.',
      'Unmatched strong-leg points stay waiting — no total flush-out. Daily caps flush only matched excess.',
    ]],
    ['5. Tri-Leg / Right-Leg Bonus', [
      'Triggers from completed A+B triggers plus C/Right-leg points (Premium = 1 point, StarPremium = 2 points per right-leg member).',
      'Premium receiver = ₱300/unit. StarPremium receiver + StarPremium right-source = ₱300 + ₱300.',
      'Every Nth Tri-Leg unit gives 1 GC instead of cash. Daily limits: MA 15/30, CA 10/20 (GC included). Reset 12:01 AM PH time.',
    ]],
    ['6. Direct Referral & Unilevel', [
      'Direct Referral is paid only to the direct sponsor, never to the upline chain. Any pairing involving a Starter pays ₱50 (Starter→any package, Premium/StarPremium→Starter).',
      'Starter Product Commission: Premium/StarPremium members earn ₱20 per bottle on direct Starter repeat orders, credited monthly with Unilevel once the earner meets the 5 LP maintenance requirement.',
      'Unilevel uses Dynamic Compression: CA connector nodes and ineligible/Starter uplines are skipped without consuming a paid tier; 10 paid tiers max.',
      'Recipient must qualify with ≥5 LP in the current month (or lifetime when monthly reset is OFF). Only ACTIVATED (used) product codes create LP.',
      'With Cutoff Hold ON, unilevel is visible immediately but withdrawable only after the monthly cutoff.',
    ]],
    ['7. Admin Operations', [
      'Batch Recalculate replays all earnings from the persisted tree + used pins (DR → pairing → unilevel → wallets). Run it after any manual tree surgery.',
      'Network Override moves must follow the target tree\'s spillover rules; illegal placements are blocked.',
      'Backup/Restore exports members, genealogy, pins, ledger, orders, packages, settings and logs. Admin ID 1 is always preserved.',
      'Activity Logs hide password fields and record actions by category.',
    ]],
  ];
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-gold">📖 System Guide &amp; Logic (Current)</h3>
      <p className="mt-1 text-[12px] text-zinc-500">Summary of member/admin features, compensation rules, placement rules, reporting, maintenance, backup/restore, and security tools.</p>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {sections.map(([title, items]) => (
          <div key={title} className="rounded-lg border border-line bg-[#0a0a0a] p-4">
            <h4 className="text-[14px] font-bold text-gold">{title}</h4>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-zinc-400">
              {items.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
