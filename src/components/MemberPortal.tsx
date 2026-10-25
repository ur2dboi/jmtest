'use client';

import React from 'react';
import { api, Badge, confirmDialog, cx, Empty, Modal, peso, rankBadge, reloadSoon, Stat, Toast, useToast } from './ui';
import TreeView, { type SlotInfo } from './TreeView';
import { phFormat } from '@/lib/time';
import type { MemberPortalData } from '@/lib/queries';
import type { AccountRow, LedgerRow, PinRow } from '@/lib/types';
import type { TreeCell } from '@/lib/engine/tree';

interface AssociatesData {
  direct: AssocRow[];
  spillover: AssocRow[];
  spilledIn: AssocRow[];
  counts: { direct: number; spillover: number; spilledIn: number };
}
interface AssocRow {
  id: number; user_id: number; username: string; name: string; rank: string;
  type: string; position: string; slot: string; registered_at: string;
}
interface DownlineEarningRow {
  account_id: number; user_id: number; username: string; name: string; rank: string;
  depth: number; joined: string; dr: number; pairing: number; tri: number; unilevel: number; gc: number; total: number;
}

export interface MemberPortalProps {
  data: MemberPortalData;
  node: string;
  focusAccountId: number;
  treeRoot: TreeCell | null;
  slotStates: Record<string, SlotInfo>;
  downlineOptions: { account_id: number; label: string; depth: number }[];
  associates: AssociatesData | null;
  downlineEarnings: { rows: DownlineEarningRow[]; grand: number };
  encashSettings: { taxRate: number; fee: number; min: number; transferFee: number };
  caSlotsOpen: number;
  nowText: string;
  initialTab: string;
}

const TABS: { id: string; label: string; icon: string; hideForChild?: boolean }[] = [
  { id: 'mtab-overview', label: 'Dashboard', icon: '📊' },
  { id: 'mtab-transactions', label: 'Transactions', icon: '📃' },
  { id: 'mtab-reports', label: 'Income Reports', icon: '📈' },
  { id: 'mtab-tree', label: 'Genealogy', icon: '🌳' },
  { id: 'mtab-encash', label: 'Encashment', icon: '💸' },
  { id: 'mtab-purchasing', label: 'Purchasing', icon: '🛒' },
  { id: 'mtab-product-vault', label: 'My Products', icon: '🎁', hideForChild: true },
  { id: 'mtab-associates', label: 'My Associates', icon: '🤝', hideForChild: true },
  { id: 'mtab-profile', label: 'Profile', icon: '⚙️' },
];

function dt(v: unknown, fmt = 'M d, Y - g:i A'): string {
  return v ? phFormat(v as string, fmt) : '';
}

export default function MemberPortal(props: MemberPortalProps) {
  const { data, encashSettings } = props;
  const user = data.user;
  const earn = data.earnings;
  const isChild = data.isChildLogin;
  const [tab, setTab] = React.useState(props.initialTab || 'mtab-overview');
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [toast, setToast] = useToast();
  const [busy, setBusy] = React.useState(false);

  // Starter Child Accounts cannot access Purchasing (commissions stay Mother-only).
  const activeRankNorm = ((data.activeAccount?.rank_snapshot || user.rank || '') as string).replace(/\s+/g, '').toLowerCase();
  const visibleTabs = TABS.filter((t) => !(isChild && t.hideForChild));

  async function post(payload: Record<string, unknown>, successMsg?: string) {
    setBusy(true);
    try {
      const res = await api<{ message?: string }>('/api/member', { node: props.node, ...payload });
      setToast({ kind: 'ok', text: res.message || successMsg || 'Done.' });
      reloadSoon(1000);
      return res;
    } catch (e) {
      setToast({ kind: 'err', text: (e as Error).message });
      setBusy(false);
      throw e;
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/member-login';
  }

  async function switchNode(node: string) {
    await api('/api/member', { action: 'switch-node', node });
    window.location.href = '/member-portal';
  }

  const nodeDisplayUser =
    props.node === 'C_L' ? `C1${user.username}` : props.node === 'C_C' ? `C2${user.username}` : props.node === 'C_R' ? `C3${user.username}` : user.username;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Toast toast={toast} onClose={() => setToast(null)} />
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/70 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* ---------- sidebar ---------- */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-line bg-card transition-transform md:static md:w-[260px] md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="border-b border-line p-5 text-center">
          <div className="mx-auto mb-2 flex h-[70px] w-[70px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-gold to-goldsoft text-2xl font-extrabold text-black">
            {user.profile_picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.profile_picture} alt="Avatar" className="h-full w-full object-cover" />
            ) : (
              (user.display_name || user.username).slice(0, 1).toUpperCase()
            )}
          </div>
          <h3 className="text-[16px] font-bold text-zinc-50">{user.display_name || user.username}</h3>
          <p className="text-[12px] text-zinc-500">@{nodeDisplayUser}</p>
          <div className="mt-2">{rankBadge(user.rank)}</div>
          {data.canUpgrade && (
            <button type="button" className="btn mt-3 !bg-amber-600 font-bold text-black hover:!bg-amber-500" onClick={() => setTab('mtab-profile')}>
              ⬆️ UPGRADE ACCOUNT
            </button>
          )}
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cx('side-link', tab === t.id && 'active')}
              onClick={() => { setTab(t.id); setSidebarOpen(false); }}
            >
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
          <button type="button" className="side-link !text-red-400 hover:!bg-red-950/40" onClick={logout}>
            <span>🚪</span> LOG OUT
          </button>
        </nav>
      </aside>

      {/* ---------- main ---------- */}
      <main className="min-w-0 flex-1 p-3 sm:p-5 lg:p-7">
        <div className="sticky top-0 z-30 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-black/90 pb-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <button type="button" className="btn-dark btn-sm md:hidden" onClick={() => setSidebarOpen(true)}>☰</button>
            {data.cas.length > 0 && !isChild ? (
              <label className="flex items-center gap-2 text-[14px] font-semibold text-zinc-200">
                Dashboard Node:
                <select className="select !w-auto" value={props.node} onChange={(e) => switchNode(e.target.value)}>
                  <option value="MA">Mother Account</option>
                  {data.cas.map((c) => (
                    <option key={c.id} value={`C_${c.position}`}>
                      {c.position === 'L' ? 'C1 (Left Child)' : c.position === 'C' ? 'C2 (Center Child)' : 'C3 (Right Child)'}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <h2 className="text-[16px] font-bold text-zinc-100">{isChild ? 'Child Account Node' : 'Mother Dashboard Node'}</h2>
            )}
          </div>
          <span className="badge-gold !normal-case">🕐 {props.nowText}</span>
        </div>

        {isChild && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-center text-[13px] font-semibold text-red-300">
            🔒 CHILD ACCOUNT ACTIVE: This node is exclusively for network pairing and encashment. Direct referrals, purchasing, and profile management must be executed via your Mother Account — but you may upgrade this Child Account's package under Profile ⬆️.
          </div>
        )}

        {tab === 'mtab-overview' && (
          <OverviewTab {...props} post={post} busy={busy} setTab={setTab} caSlotsOpen={props.caSlotsOpen} />
        )}
        {tab === 'mtab-transactions' && <TransactionsTab data={data} />}
        {tab === 'mtab-reports' && <ReportsTab data={data} />}
        {tab === 'mtab-tree' && <TreeTab {...props} post={post} busy={busy} />}
        {tab === 'mtab-encash' && <EncashTab {...props} post={post} busy={busy} />}
        {tab === 'mtab-purchasing' && <PurchasingTab {...props} post={post} busy={busy} setTab={setTab} />}
        {tab === 'mtab-product-vault' && !isChild && <ProductVaultTab {...props} post={post} busy={busy} />}
        {tab === 'mtab-associates' && !isChild && <AssociatesTab associates={props.associates} />}
        {tab === 'mtab-profile' && <ProfileTab {...props} post={post} busy={busy} />}
      </main>
    </div>
  );
}

type PostFn = (payload: Record<string, unknown>, successMsg?: string) => Promise<{ message?: string }>;

/* ============================ OVERVIEW ============================ */
function OverviewTab({ data, post, busy, setTab, caSlotsOpen }: MemberPortalProps & { post: PostFn; busy: boolean; setTab: (t: string) => void; caSlotsOpen: number }) {
  const earn = data.earnings;
  const [caOpen, setCaOpen] = React.useState(false);
  return (
    <div className="animate-fadeIn space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total Earnings" value={peso(earn.totalEarned)} />
        <Stat label="Available Commissions" value={peso(earn.balance)} accent sub="Released & withdrawable" />
        <Stat label="Encashment" value={peso(earn.totalEncashed)} sub="Withdrawals from available commission" />
      </div>

      {!(data.isChildLogin || data.activeAccount.account_type === 'CA') && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Stat label="FLOATING Unilevel Commission (LP)" value={<span className="text-amber-300">{peso(earn.unilevelPendingCutoff)}</span>} />
          <Stat label="FLOATING Product Commission (PC)" value={<span className="text-amber-300">{peso(earn.productCommPending)}</span>} />
        </div>
      )}

      {!data.isChildLogin && caSlotsOpen > 0 && (
        <div className="card" style={{ borderColor: '#3b82f6' }}>
          <h3 className="text-[15px] font-bold text-blue-400">⚙️ Child Account Activation (Optional — {caSlotsOpen} of 3 slots available)</h3>
          <p className="mt-1 text-[12px] text-zinc-500">Child Accounts are optional. Available slots decrease when filled by CAs, members, or spillovers.</p>
          <button type="button" className="btn mt-3 !bg-blue-800 font-semibold text-white hover:!bg-blue-700" onClick={() => setCaOpen(true)}>
            Activate Child Account ({caSlotsOpen} slot{caSlotsOpen > 1 ? 's' : ''} left)
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <h3 className="panel-title !text-gold">Summary of Earnings</h3>
          <SummaryRow label="Direct Referral Bonus" value={peso(earn.dr)} onClick={() => setTab('mtab-reports')} />
          <SummaryRow label="A+B Pairing Bonus" value={peso(earn.pairingReleased)} onClick={() => setTab('mtab-reports')} />
          <SummaryRow label="Tri-Leg Bonus" value={peso(earn.tri)} onClick={() => setTab('mtab-reports')} />
          <SummaryRow label="Unilevel Comm" value={peso(earn.unilevel)} onClick={() => setTab(data.isChildLogin ? 'mtab-reports' : 'mtab-purchasing')} />
          <SummaryRow label="Product Comm (Starter Direct)" value={peso(earn.productComm)} onClick={() => setTab(data.isChildLogin ? 'mtab-reports' : 'mtab-purchasing')} />
          <div className="flex items-center justify-between py-1 text-[13px]">
            <span className="text-emerald-400">Available GC</span><strong className="text-emerald-400">{earn.gc}</strong>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-dashed border-line pt-2 text-[13px] text-sky-400">
            <span>Downline Count (total)</span><strong>{data.downlineCount}</strong>
          </div>
          <div className="flex items-center justify-between py-1 text-[13px]">
            <span>LP (Unilevel eligibility)</span>
            <strong className={data.lpEligible ? 'text-emerald-400' : 'text-zinc-300'}>
              {data.lp} LP {data.lpEligible ? '· Eligible ✓' : '· Need 5 LP'}
            </strong>
          </div>
        </div>

        <div className="card">
          <h3 className="panel-title !text-sky-400">Network Metrics</h3>
          <p className="text-[12px] text-zinc-500">
            Downline Member Count (A/B/C) — {data.activeAccount.account_type === 'CA' ? 'Child Account' : 'MA'}:
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {(['A', 'B', 'C'] as const).map((leg) => (
              <div key={leg} className="rounded-lg border border-line bg-[#0a0a0a] px-2 py-3">
                <div className="text-[11px] uppercase text-zinc-500">{leg} leg</div>
                <div className="text-xl font-extrabold text-zinc-50">{data.legCounts[leg]}</div>
                <div className="text-[10px] text-zinc-600">
                  pts {leg === 'A' ? data.activeAccount.left_points : leg === 'B' ? data.activeAccount.center_points : data.activeAccount.right_points}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-zinc-500">
            Waiting points (L/C/R): {data.activeAccount.left_points} / {data.activeAccount.center_points} / {data.activeAccount.right_points}
            {' '}· Tri-Leg triggers: {data.activeAccount.pairing_count}
          </p>
          <p className="mt-1 text-[12px] text-zinc-500">
            Spillover gate (3+9): {data.gateComplete ? <span className="text-emerald-400">Complete — Right→Right→Right active</span> : <span className="text-amber-300">Not yet complete</span>}
          </p>
        </div>
      </div>

      <StarterBenefitsCard data={data} setTab={setTab} />

      {!data.isChildLogin && (
        <div className="card text-center">
          <h3 className="text-[15px] font-bold text-zinc-100">🔑 Available Codes (Summary)</h3>
          <div className="my-2 text-4xl font-extrabold text-gold">{data.vaultCounts.all}</div>
          <p className="text-[12px] text-zinc-500">
            {data.vaultCounts.packages} package · {data.vaultCounts.products} product codes unused
          </p>
        </div>
      )}

      <CaModal open={caOpen} onClose={() => setCaOpen(false)} pins={data.packagePins} post={post} busy={busy} />
    </div>
  );
}

/* ============ STARTER BENEFITS & PRODUCT COMMISSION ============ */
function StarterBenefitsCard({ data, setTab }: { data: MemberPortalData; setTab: (t: string) => void }) {
  const b = data.starterBenefits ?? { dr: 50, productCommPerBottle: 20 };
  const earn = data.earnings;
  const rankNorm = (data.user.rank || '').replace(/\s+/g, '').toLowerCase();
  const isStarter = rankNorm.includes('starter');
  const isPremiumTier = !isStarter && rankNorm.includes('premium');
  const lpNeeded = Math.max(0, 5 - data.lp);
  const drRows: [string, string][] = [
    ['Starter', 'Starter'],
    ['Starter', 'Premium'],
    ['Starter', 'StarPremium'],
    ['Premium', 'Starter'],
    ['StarPremium', 'Starter'],
  ];
  return (
    <div className="card">
      <h3 className="panel-title !text-gold">🌱 Starter Benefits &amp; Product Commission</h3>
      <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-wide text-zinc-400">
            Receivable Direct Referral — {peso(b.dr)}
          </p>
          <div className="mt-1">
            {drRows.map(([s, r]) => (
              <div key={`${s}-${r}`} className="flex items-center justify-between border-b border-dashed border-line/60 py-1 text-[13px]">
                <span className="text-zinc-400">{s} <span className="text-zinc-600">→</span> {r}</span>
                <strong className="text-zinc-100">{peso(b.dr)}</strong>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[12px] font-bold uppercase tracking-wide text-zinc-400">
            Product Commission — {peso(b.productCommPerBottle)} per bottle
          </p>
          {isPremiumTier ? (
            <div className="mt-2 space-y-1 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Your LP (maintenance)</span>
                <strong className={data.lpEligible ? 'text-emerald-400' : 'text-amber-300'}>
                  {data.lp} LP {data.lpEligible ? '· Eligible ✓' : `· Need ${lpNeeded} more LP`}
                </strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Product Comm earned</span>
                <strong className="text-zinc-100">{peso(earn.productComm)}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">FLOATING (LP)</span>
                <strong className="text-amber-300">{peso(earn.productCommPending)}</strong>
              </div>
              <button type="button" className="text-[12px] text-gold underline-offset-2 hover:underline" onClick={() => setTab(data.isChildLogin ? 'mtab-reports' : 'mtab-purchasing')}>
                View Purchasing tab →
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  return (
    <div className="flex items-center justify-between py-1 text-[13px]">
      <button type="button" onClick={onClick} className="text-zinc-400 underline-offset-2 hover:text-gold hover:underline">
        {label.toUpperCase()}
      </button>
      <strong className="text-zinc-100">{value}</strong>
    </div>
  );
}

function groupPins(pins: PinRow[]) {
  const map = new Map<string, { count: number; firstId: number }>();
  for (const p of pins) {
    const cur = map.get(p.package_type) ?? { count: 0, firstId: p.id };
    cur.count++;
    map.set(p.package_type, cur);
  }
  return Array.from(map.entries()).map(([type, info]) => ({ type, ...info }));
}

export function CaModal({ open, onClose, pins, post, busy }: { open: boolean; onClose: () => void; pins: PinRow[]; post: PostFn; busy: boolean }) {
  const [pinId, setPinId] = React.useState<number>(0);
  const [caUser, setCaUser] = React.useState('');
  const [caPass, setCaPass] = React.useState('');
  const grouped = groupPins(pins);
  return (
    <Modal open={open} onClose={onClose} title="Activate Child Account">
      <p className="text-[12px] text-zinc-500">The system will automatically place this new CA node into the next available slot under your Mother Account.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await post({ action: 'activate-ca', pin_id: pinId, ca_user: caUser, ca_pass: caPass });
          onClose();
        }}
        className="mt-3 space-y-3"
      >
        <div>
          <span className="lbl">Select Package (From Vault)</span>
          <select className="select" required value={pinId} onChange={(e) => setPinId(Number(e.target.value))}>
            <option value={0}>-- Choose Package Type --</option>
            {grouped.map((g) => (
              <option key={g.type} value={g.firstId}>{g.type} ({g.count} available)</option>
            ))}
          </select>
          {grouped.length === 0 && <p className="mt-1 text-[11px] text-amber-300">No Packages Available — purchase one first.</p>}
        </div>
        <div>
          <span className="lbl">Child Account Username</span>
          <input className="input" value={caUser} onChange={(e) => setCaUser(e.target.value)} placeholder="e.g. myname_c1" required />
        </div>
        <div>
          <span className="lbl">Child Account Password</span>
          <input className="input" type="password" value={caPass} onChange={(e) => setCaPass(e.target.value)} minLength={6} pattern="[A-Za-z0-9]{6,}" required />
        </div>
        <button type="submit" disabled={busy || !pinId} className="btn w-full !bg-blue-700 font-bold text-white hover:!bg-blue-600 disabled:opacity-40">
          Confirm &amp; Activate
        </button>
      </form>
    </Modal>
  );
}

/* ============================ TRANSACTIONS ============================ */
function TransactionsTab({ data }: { data: MemberPortalData }) {
  const rows = data.encashLedger;
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-zinc-50">📃 Encashment Transactions</h3>
      <p className="text-[12px] text-zinc-500">Displays encashment payouts, fees, and deductions only.</p>
      {data.earnings.pendingEncash > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3">
          <span className="font-bold text-amber-300">⏳ Pending Encashment</span>
          <span className="text-amber-300">{peso(data.earnings.pendingEncash)}</span>
        </div>
      )}
      <div className="tbl-wrap mt-4">
        <table className="tbl">
          <thead><tr><th>Date &amp; Time</th><th>Description</th><th>Amount</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={3} className="text-center text-zinc-500">No encashment transactions found.</td></tr>}
            {rows.map((l) => (
              <tr key={l.id}>
                <td className="text-zinc-500">{dt(l.created_at, 'M d, Y h:i A')}</td>
                <td className="!whitespace-normal">{l.note}</td>
                <td className={Number(l.amount) > 0 ? 'money-pos' : 'money-neg'}>
                  {Number(l.amount) > 0 ? '+' : ''}{peso(l.amount).replace('₱', '₱')}
                  {Number(l.tax_deducted) > 0 && <span className="block text-[10px] text-zinc-500">(Tax+Fee: -{peso(l.tax_deducted)})</span>}
                  {Number(l.fee_deducted) > 0 && <span className="block text-[10px] text-zinc-500">(Transfer: -{peso(l.fee_deducted)})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ REPORTS ============================ */
const REPORT_FILTERS = ['All', 'Direct Referral', 'Pairing', 'Trifinity Pair', 'Unilevel', 'Product Commission', 'FLOATING Commission (LP)', 'GC', 'Flush'] as const;
const FILTER_TERMS: Record<string, string[]> = {
  Pairing: ['a+b', 'pairing bonus'],
  'Trifinity Pair': ['tri-leg'],
  'Direct Referral': ['direct referral'],
  Unilevel: ['unilevel'],
  'Product Commission': ['product comm'],
  GC: ['gc'],
  Flush: ['flush out', 'exceeded daily limit'],
};

function ReportsTab({ data }: { data: MemberPortalData }) {
  const [filter, setFilter] = React.useState<(typeof REPORT_FILTERS)[number]>('All');
  const rows = data.ledger;
  const matched = rows.filter((l) => {
    if (filter === 'All') return true;
    if (filter === 'FLOATING Commission (LP)') {
      const desc = (l.note || '').toLowerCase();
      return l.status === 'hang' && (desc.includes('unilevel comm') || desc.includes('product comm'));
    }
    const desc = (l.note || '').toLowerCase();
    return FILTER_TERMS[filter].some((t) => desc.includes(t));
  });
  let cashTotal = 0, gcCount = 0, flushCount = 0;
  for (const l of matched) {
    const isFlush = /flush out/i.test(l.note);
    if (isFlush) flushCount++;
    else if (l.type === 'gc') gcCount += Number(l.amount);
    // FLOATING (hang) and forfeited rows list in the reports but never count
    // toward income totals; the FLOATING report totals the held amount itself.
    else if (filter === 'FLOATING Commission (LP)' ? l.status === 'hang' : l.status !== 'hang' && l.status !== 'forfeited') cashTotal += Number(l.amount);
  }
  return (
    <div className="card animate-fadeIn">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <h3 className="text-[16px] font-bold text-gold">📈 Income Report: {filter}</h3>
        <select className="select !w-auto" value={filter} onChange={(e) => setFilter(e.target.value as never)}>
          {REPORT_FILTERS.map((f) => (
            <option key={f} value={f}>{f === 'All' ? 'All Earnings' : f === 'Pairing' ? 'A+B Pairing Bonus' : f === 'Trifinity Pair' ? 'Trifinity Pair' : f === 'Unilevel' ? 'Unilevel Comm' : f === 'Product Commission' ? 'Product Commission' : f === 'FLOATING Commission (LP)' ? 'FLOATING Commission (LP)' : f === 'GC' ? 'Available GC' : f === 'Flush' ? 'Daily Limit' : 'Direct Referral Bonus'}</option>
          ))}
        </select>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Date &amp; Time</th><th>Earning Type &amp; Details</th><th>Amount</th></tr></thead>
          <tbody>
            {matched.length === 0 && <tr><td colSpan={3} className="text-center text-zinc-500">No earnings found.</td></tr>}
            {matched.map((l) => {
              const isFlush = /flush out/i.test(l.note);
              return (
                <tr key={l.id}>
                  <td className="text-zinc-500">{dt(l.created_at)}</td>
                  <td className="!whitespace-normal">{l.note}</td>
                  <td style={{ color: isFlush ? '#ef4444' : '#10b981', fontWeight: 700 }}>
                    {isFlush ? 'FLUSHED / LIMIT EXCEEDED' : l.status === 'forfeited' ? 'FORFEITED / NO MAINTENANCE' : l.type === 'gc' ? `${Math.trunc(Number(l.amount))} GC` : `+${peso(l.amount)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 rounded-lg border border-line bg-[#0a0a0a] px-4 py-3 text-right text-[15px]">
        Total for this report:{' '}
        <strong className="text-emerald-400">
          {filter === 'GC' ? `${gcCount} GC` : `${peso(cashTotal)}${gcCount ? ` (+ ${gcCount} GC)` : ''}${flushCount ? ` / ${flushCount} flushed` : ''}`}
        </strong>
      </div>
    </div>
  );
}

/* ==================== UNILEVEL & PRODUCT COMMISSION ==================== */
function UnilevelTab({ data }: MemberPortalProps) {
  const earn = data.earnings;
  const d = data.unilevelDetail;
  const pc = data.productCommDetail;
  const lpNeeded = Math.max(0, 5 - data.lp);
  // Regular (Mother) Starter accounts access Product Commission only;
  // Unilevel sections unlock when they upgrade to Premium/StarPremium.
  const isStarter = /starter/i.test((data.user.rank || '').replace(/\s+/g, ''));
  const history = (
    isStarter
      ? pc.rows.map((l) => ({ ...l, kind: 'Product Comm' as const }))
      : [
          ...d.rows.map((l) => ({ ...l, kind: 'Unilevel' as const })),
          ...pc.rows.map((l) => ({ ...l, kind: 'Product Comm' as const })),
        ]
  )
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 100);

  return (
    <div className="animate-fadeIn space-y-4">
      {isStarter ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Stat label="Product Comm Released" value={peso(earn.productComm)} accent sub="Credited to wallet" />
          <Stat label="My LP (Maintenance)" value={`${data.lp} LP`} sub={data.lpEligible ? 'Eligible ✓ (≥ 5 LP)' : `Need ${lpNeeded} more LP to qualify`} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Unilevel Released" value={peso(earn.unilevel)} accent sub="Credited to wallet" />
          <Stat label="Product Comm Released" value={peso(earn.productComm)} accent sub="Credited to wallet" />
          <Stat label="My LP (Maintenance)" value={`${data.lp} LP`} sub={data.lpEligible ? 'Eligible ✓ (≥ 5 LP)' : `Need ${lpNeeded} more LP to qualify`} />
          <Stat label="Starter Bottles Credited" value={String(pc.bottles)} sub="From direct Starter repeat orders" />
        </div>
      )}
      <div className={`grid grid-cols-1 gap-3 ${isStarter ? '' : 'sm:grid-cols-2'}`}>
        {!isStarter && <Stat label="FLOATING Unilevel Commission (LP)" value={<span className="text-amber-300">{peso(earn.unilevelPendingCutoff)}</span>} />}
        <Stat label="FLOATING Product Commission (PC)" value={<span className="text-amber-300">{peso(earn.productCommPending)}</span>} />
      </div>

      {!isStarter && d.levelTotals.length > 0 && (
        <div className="card">
          <h3 className="text-[15px] font-bold text-emerald-400">Earnings by Compressed Level</h3>
          <div className="tbl-wrap mt-2">
            <table className="tbl">
              <thead><tr><th>Compressed Level</th><th>Entries</th><th>Total Earned</th></tr></thead>
              <tbody>
                {d.levelTotals.map((l) => (
                  <tr key={l.level}>
                    <td>Level {l.level}</td>
                    <td>{l.count}</td>
                    <td className="font-bold text-emerald-400">{peso(l.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="text-[15px] font-bold text-emerald-400">{isStarter ? 'Product Commission History (latest 100)' : 'Commission History (latest 100)'}</h3>
        <div className="tbl-wrap mt-2">
          <table className="tbl">
            <thead><tr><th>Date &amp; Time</th><th>Type</th><th>Details</th><th>Status</th><th>Amount</th></tr></thead>
            <tbody>
              {history.length === 0 && (
                <tr><td colSpan={5} className="text-center text-zinc-500">{isStarter ? 'No Product Commission yet. Earnings from your direct Starters\' repeat orders appear here once you upgrade to Premium or StarPremium.' : 'No commissions yet. Earnings from your downlines\' product activations (Unilevel) and direct Starters\' repeat orders (Product Commission) appear here.'}</td></tr>
              )}
              {history.map((l) => (
                <tr key={`${l.kind}-${l.id}`}>
                  <td className="text-zinc-500">{dt(l.created_at)}</td>
                  <td>{l.kind === 'Unilevel'
                    ? <span className="font-semibold text-emerald-400">Unilevel</span>
                    : <span className="font-semibold text-cyan-300">Product Comm</span>}</td>
                  <td className="!whitespace-normal">{l.note}</td>
                  <td>{l.status === 'hang' ? <span className="font-semibold text-amber-300">FLOATING (LP)</span> : l.status === 'forfeited' ? <span className="font-semibold text-red-400">Forfeited</span> : <span className="font-semibold text-emerald-400">Released</span>}</td>
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

/* ============================ TREE ============================ */
function TreeTab(props: MemberPortalProps & { post: PostFn; busy: boolean }) {
  const { data, post, busy } = props;
  const [regOpen, setRegOpen] = React.useState(false);
  const [caOpen, setCaOpen] = React.useState(false);
  const [showEarnings, setShowEarnings] = React.useState(false);
  const [direct, setDirect] = React.useState<{ upline: number; pos: string } | null>(null);
  const canRegister = !data.isChildLogin;

  return (
    <div className="card animate-fadeIn">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[16px] font-bold text-gold">Genealogy Overview</h3>
        <div className="flex flex-wrap gap-2">
          {canRegister && props.caSlotsOpen > 0 && (
            <button type="button" className="btn !bg-amber-700 font-semibold text-white hover:!bg-amber-600" onClick={() => setCaOpen(true)}>
              + Activate Child Account (Optional)
            </button>
          )}
          {canRegister && (
            <button type="button" className="btn !bg-emerald-700 font-semibold text-white hover:!bg-emerald-600" onClick={() => { setDirect(null); setRegOpen(true); }}>
              + Register New Member
            </button>
          )}
        </div>
      </div>
      <p className="mb-3 rounded-lg border border-line bg-[#0a0a0a] px-3 py-2 text-center text-[11px] text-zinc-500">
        <strong className="text-zinc-300">Spillover = Right → Right → Right only</strong> (free &amp; paid, any depth). Before the gate: CA1/CA2 open R1–R6; MA3/Free Mother = Right-only for upline (they fill L/C on their own login). After the gate: only the pure Right chain to the deepest open Right.
      </p>

      <div className="mb-3 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-line bg-[#0a0a0a] px-3 py-2">
        <label className="text-[12px] text-zinc-500">🔍 View Downline Member&apos;s Tree:</label>
        <select
          className="select !w-auto max-w-[320px]"
          value={props.focusAccountId}
          onChange={(e) => { window.location.href = `?tab=mtab-tree&view_node=${e.target.value}`; }}
        >
          <option value={data.activeAccount.id}>⭐ My Node ({data.user.display_name || data.user.username})</option>
          {props.downlineOptions.map((o) => (
            <option key={o.account_id} value={o.account_id}>{o.label}</option>
          ))}
        </select>
        {props.focusAccountId !== Number(data.activeAccount.id) && (
          <a className="btn-dark btn-sm" href="?tab=mtab-tree">⬅ Return to My Dashboard Node</a>
        )}
        <button type="button" className="btn-dark btn-sm" onClick={() => setShowEarnings((s) => !s)}>
          {showEarnings ? 'Hide' : '📊 Downline Earnings'}
        </button>
      </div>

      {showEarnings && (
        <div className="mb-3 overflow-hidden rounded-xl border border-line">
          <div className="border-b border-line bg-[#0d0d0d] px-3 py-2 text-[13px] font-bold text-gold">
            📊 Downline Earnings Table <span className="font-normal text-zinc-500">(your downline only — uplines and other branches are never shown)</span>
          </div>
          <div className="tbl-wrap !border-0">
            <table className="tbl">
              <thead><tr><th>Member</th><th>Account</th><th>Row</th><th>Joined</th><th>Direct Referral</th><th>Pairing (A+B)</th><th>Tri-Leg</th><th>GC</th><th>Total Earnings</th></tr></thead>
              <tbody>
                {props.downlineEarnings.rows.length === 0 && <tr><td colSpan={9} className="text-center text-zinc-500">Wala pang downline members.</td></tr>}
                {props.downlineEarnings.rows.map((r) => (
                  <tr key={r.account_id}>
                    <td>
                      <a className="font-bold text-sky-400 hover:underline" href={`?tab=mtab-tree&view_node=${r.account_id}`}>{r.name}</a>
                      <span className="block text-[10px] text-zinc-500">@{r.username}</span>
                    </td>
                    <td>{rankBadge(r.rank)}</td>
                    <td>{r.depth}</td>
                    <td className="text-zinc-500">{r.joined}</td>
                    <td>{peso(r.dr)}</td><td>{peso(r.pairing)}</td><td>{peso(r.tri)}</td>
                    <td className="text-emerald-400">{r.gc}</td>
                    <td className="font-bold text-emerald-400">{peso(r.total)}</td>
                  </tr>
                ))}
                {props.downlineEarnings.rows.length > 0 && (
                  <tr>
                    <td colSpan={8} className="text-right font-bold">TOTAL (Downline)</td>
                    <td className="font-bold text-gold">{peso(props.downlineEarnings.grand)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[12px] text-sky-400">💡 Click on any Node to view its network. Green dashed slots are open for registration; violet slots are spillover.</p>
      {props.treeRoot ? (
        <TreeView
          root={props.treeRoot}
          slotStates={props.slotStates}
          onNodeClick={(id) => { window.location.href = `?tab=mtab-tree&view_node=${id}`; }}
          onSlotClick={canRegister ? (parentId, pos) => { setDirect({ upline: parentId, pos }); setRegOpen(true); } : undefined}
        />
      ) : (
        <Empty icon="🌳">No genealogy data for this node.</Empty>
      )}

      <RegisterMemberModal
        open={regOpen}
        onClose={() => setRegOpen(false)}
        pins={data.packagePins}
        post={post}
        busy={busy}
        direct={direct}
        viewRootAccountId={props.focusAccountId}
        node={props.node}
      />
      <CaModal open={caOpen} onClose={() => setCaOpen(false)} pins={data.packagePins} post={post} busy={busy} />
    </div>
  );
}

export function RegisterMemberModal({
  open, onClose, pins, post, busy, direct, viewRootAccountId, node,
}: {
  open: boolean; onClose: () => void; pins: PinRow[]; post: PostFn; busy: boolean;
  direct: { upline: number; pos: string } | null; viewRootAccountId: number; node: string;
}) {
  const grouped = groupPins(pins);
  const [pinId, setPinId] = React.useState(0);
  const [f, setF] = React.useState({ first_name: '', middle_name: '', last_name: '', bday: '', gender: '', phone: '', username: '', password: '', sponsor_username: '', placement_username: '' });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  React.useEffect(() => { if (open && grouped.length && !pinId) setPinId(grouped[0].firstId); }, [open ]); // eslint-disable-line
  return (
    <Modal open={open} onClose={onClose} title="Register New Member" wide>
      <p className="mb-3 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
        Spillover-safe: placement follows the same structure rules as admin (free or paid). After your gate is complete, only Right→Right→Right is allowed. Illegal slots are blocked and will not change the tree.
        {direct && <span className="mt-1 block font-bold">Selected slot: upline #{direct.upline} · {direct.pos}</span>}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await post({
            action: 'register-downline', pin_id: pinId, ...f,
            ...(direct ? { direct_upline_id: direct.upline, direct_position: direct.pos } : {}),
            view_root_account_id: viewRootAccountId, node,
          });
          onClose();
        }}
        className="space-y-3"
      >
        <div>
          <span className="lbl">Select Package Code from Vault</span>
          <select className="select" required value={pinId} onChange={(e) => setPinId(Number(e.target.value))}>
            <option value={0}>-- Choose Package Type --</option>
            {grouped.map((g) => <option key={g.type} value={g.firstId}>{g.type} ({g.count} available)</option>)}
          </select>
          {grouped.length === 0 && <p className="mt-1 text-[11px] text-amber-300">No Package Codes Available — purchase one first.</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div><span className="lbl">First Name</span><input className="input" required value={f.first_name} onChange={(e) => set('first_name', e.target.value)} /></div>
          <div><span className="lbl">Middle Name</span><input className="input" required value={f.middle_name} onChange={(e) => set('middle_name', e.target.value)} /></div>
          <div><span className="lbl">Last Name</span><input className="input" required value={f.last_name} onChange={(e) => set('last_name', e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div><span className="lbl">Birthday (MM/DD/YYYY)</span><input className="input" required placeholder="MM/DD/YYYY" pattern="\d{2}/\d{2}/\d{4}" value={f.bday} onChange={(e) => set('bday', e.target.value)} /></div>
          <div>
            <span className="lbl">Gender</span>
            <select className="select" required value={f.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">Select Gender...</option><option>Male</option><option>Female</option>
            </select>
          </div>
        </div>
        <div><span className="lbl">Phone Number</span><input className="input" required placeholder="09xxxxxxxxx" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="form-row">
          <div><span className="lbl !text-gold">New Username</span><input className="input" required placeholder="e.g. member_01" value={f.username} onChange={(e) => set('username', e.target.value)} /></div>
          <div><span className="lbl">Password</span><input className="input" type="password" required minLength={6} pattern="[A-Za-z0-9]{6,}" value={f.password} onChange={(e) => set('password', e.target.value)} /></div>
        </div>
        <div className="rounded-lg border border-line bg-[#0a0a0a] p-3">
          <span className="lbl !text-emerald-400">👥 Sponsor Username (optional)</span>
          <input className="input" placeholder="Leave blank to sponsor them yourself" value={f.sponsor_username} onChange={(e) => set('sponsor_username', e.target.value)} />
        </div>
        <div className="rounded-lg border border-line bg-[#0a0a0a] p-3">
          <span className="lbl !text-sky-400">📍 Placement Username (optional)</span>
          <input className="input" placeholder="Leave blank for auto-placement" value={f.placement_username} onChange={(e) => set('placement_username', e.target.value)} />
        </div>
        <button type="submit" disabled={busy || !pinId} className="btn w-full !bg-emerald-700 font-bold text-white hover:!bg-emerald-600 disabled:opacity-40">
          Confirm &amp; Register Member
        </button>
      </form>
    </Modal>
  );
}

/* ============================ ENCASH ============================ */
function EncashTab(props: MemberPortalProps & { post: PostFn; busy: boolean }) {
  const { data, encashSettings, post, busy } = props;
  const [amount, setAmount] = React.useState('');
  const [method, setMethod] = React.useState('Cash');
  const [account, setAccount] = React.useState('');
  const amt = Number(amount) || 0;
  const tax = amt * (encashSettings.taxRate / 100);
  const transfer = method === 'Fund Transfer' ? encashSettings.transferFee : 0;
  const net = Math.max(0, amt - tax - encashSettings.fee - transfer);
  const idOk = data.idStatus.valid;
  const history = data.encashLedger;

  return (
    <div className="animate-fadeIn space-y-4">
      <div className="card max-w-xl">
        <h3 className="text-[16px] font-bold text-red-400">💸 Encashment</h3>
        <p className="mt-1 text-[12px] text-zinc-500">Minimum {peso(encashSettings.min)}. Valid member ID is required before you can submit.</p>

        <div className={cx('mt-3 rounded-lg border px-3 py-2 text-[12px]', idOk ? 'border-emerald-700 bg-emerald-950/40 text-emerald-300' : 'border-red-800 bg-red-950/50 text-red-300')}>
          <strong>ID Status:</strong> {data.idStatus.reason}
          {data.idStatus.id_number && <span className="block">ID: {data.idStatus.id_number}</span>}
          {data.idStatus.expires && <span className="block">Expires: {data.idStatus.expires}</span>}
        </div>

        <div className="mt-3 rounded-lg border border-line bg-[#0a0a0a] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-zinc-500">Available Balance</span>
            <strong className="text-xl text-emerald-400">{peso(data.earnings.balance)}</strong>
          </div>
          <div className="mt-1 flex justify-between text-[12px] text-zinc-500"><span>Pending requests</span><strong className="text-amber-300">{peso(data.earnings.pendingEncash)}</strong></div>
          <div className="mt-1 flex justify-between text-[12px] text-zinc-500"><span>Total approved encashments</span><strong className="text-red-400">{peso(data.earnings.totalEncashed)}</strong></div>
        </div>

        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await post({ action: 'encash', amount: amt, method, account });
          }}
        >
          <div><span className="lbl">Amount</span><input className="input" type="number" min={encashSettings.min} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 1000" /></div>
          <div>
            <span className="lbl">Payment Method</span>
            <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="Cash">Cash (no transfer fee)</option>
              <option value="Fund Transfer">Fund Transfer (less {peso(encashSettings.transferFee)})</option>
            </select>
          </div>
          <div><span className="lbl">Account Details</span><input className="input" placeholder="Bank / GCash / account name & number" value={account} onChange={(e) => setAccount(e.target.value)} /></div>

          <div className="rounded-lg border border-dashed border-red-800 bg-red-950/30 p-3 text-[13px]">
            <div className="flex justify-between"><span>Tax ({encashSettings.taxRate}%):</span><strong>{peso(tax)}</strong></div>
            <div className="mt-1 flex justify-between"><span>System Fee:</span><strong>{peso(encashSettings.fee)}</strong></div>
            <div className="mt-1 flex justify-between"><span>Transfer Fee:</span><strong>{peso(transfer)}</strong></div>
            <div className="mt-2 flex justify-between border-t border-red-800 pt-2"><span>NET AMOUNT:</span><strong className="text-lg text-emerald-400">{peso(net)}</strong></div>
          </div>

          <button type="submit" disabled={busy || !idOk} className="btn-gold w-full disabled:cursor-not-allowed disabled:opacity-40">
            SUBMIT ENCASHMENT
          </button>
          {!idOk && <p className="text-[11px] text-red-300">Update your member ID expiration with admin before submitting.</p>}
        </form>
      </div>

      <div className="card">
        <h3 className="text-[15px] font-bold text-gold">📃 Encashment History</h3>
        <div className="tbl-wrap mt-3">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Details</th><th>Amount</th></tr></thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan={3} className="text-center text-zinc-500">No encashment requests yet.</td></tr>}
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="text-zinc-500">{dt(h.created_at)}</td>
                  <td className="!whitespace-normal">{h.note}</td>
                  <td className="money-neg">{peso(Math.abs(Number(h.amount)))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================ PACKAGE ORDERS ============================ */
/* ============================ PURCHASING ============================ */
function PurchasingTab(props: MemberPortalProps & { post: PostFn; busy: boolean; setTab: (t: string) => void }) {
  const { data, post, busy } = props;
  const [lpItem, setLpItem] = React.useState(0);
  const [lpQty, setLpQty] = React.useState(1);
  const [lpMop, setLpMop] = React.useState('Cash (Walk-in)');
  const [pkgItem, setPkgItem] = React.useState(0);
  const [pkgQty, setPkgQty] = React.useState(1);
  const [pkgMop, setPkgMop] = React.useState('Cash (Walk-in)');
  const orders = data.orders.filter((o) => !/^(UNILEVEL )?CODE REQUEST:/i.test(o.order_details || ''));
  const rankNormLocal = (data.user.rank || '').replace(/\s+/g, '').toLowerCase();
  const isStarterRankLocal = rankNormLocal.includes('starter');
  const childMode = data.isChildLogin;

  return (
    <div className="animate-fadeIn space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
{!childMode && (
        <div className="card" style={{ borderColor: '#5b21b6' }}>
          <h3 className="text-[15px] font-bold text-violet-400">🛒 LP (Retail)</h3>
          <form
            className="mt-3 space-y-3"
            onSubmit={async (e) => { e.preventDefault(); await post({ action: 'order', type: 'product', item_id: lpItem, qty: lpQty, payment_method: lpMop }); }}
          >
            <select className="select" required value={lpItem} onChange={(e) => setLpItem(Number(e.target.value))}>
              <option value={0}>Select Product...</option>
              {data.products.map((p) => <option key={p.id} value={p.id}>{p.pkg_name}</option>)}
            </select>
            <div className="form-row">
              <div><span className="lbl">Quantity</span><input className="input" type="number" min={1} value={lpQty} onChange={(e) => setLpQty(Number(e.target.value))} /></div>
              <div>
                <span className="lbl">Mode of Payment</span>
                <select className="select" value={lpMop} onChange={(e) => setLpMop(e.target.value)}>
                  <option>Cash (Walk-in)</option><option>Bank Transfer</option>
                </select>
              </div>
            </div>
            <button type="submit" disabled={busy || !lpItem} className="btn-gold w-full disabled:opacity-40">SUBMIT ORDER</button>
          </form>
        </div>
      )}

        <div className="card">
          <h3 className="text-[15px] font-bold text-gold">📦 Packages</h3>
          <form
            className="mt-3 space-y-3"
            onSubmit={async (e) => { e.preventDefault(); await post({ action: 'order', type: 'package', item_id: pkgItem, qty: pkgQty, payment_method: pkgMop }); }}
          >
            <select className="select" required value={pkgItem} onChange={(e) => setPkgItem(Number(e.target.value))}>
              <option value={0}>Select Package...</option>
              {data.packages.map((p) => <option key={p.id} value={p.id}>{p.pkg_name}</option>)}
            </select>
            <div className="form-row">
              <div><span className="lbl">Quantity</span><input className="input" type="number" min={1} value={pkgQty} onChange={(e) => setPkgQty(Number(e.target.value))} /></div>
              <div>
                <span className="lbl">Mode of Payment</span>
                <select className="select" value={pkgMop} onChange={(e) => setPkgMop(e.target.value)}>
                  <option>Cash (Walk-in)</option><option>Bank Transfer</option>
                </select>
              </div>
            </div>
            <button type="submit" disabled={busy || !pkgItem} className="btn-gold w-full disabled:opacity-40">SUBMIT ORDER</button>
          </form>
        </div>

{!childMode && (
        <div className="card" style={{ borderColor: '#5b21b6' }}>
          <h3 className="text-[15px] font-bold text-violet-400">🔑 LP Vault</h3>
          <div className="mt-3 rounded-lg border border-line bg-[#0a0a0a] px-3 py-3 text-center">
            <div className="text-[10px] uppercase text-zinc-500">LP Codes Available</div>
            <div className="text-2xl font-extrabold text-violet-400">{data.vaultCounts.products}</div>
          </div>
          <div className="tbl-wrap mt-3">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Product</th><th>Activate</th></tr></thead>
              <tbody>
                {data.productPins.length === 0 && <tr><td colSpan={3} className="text-center text-zinc-500">No unused LP codes.</td></tr>}
                {data.productPins.map((p) => (
                  <ProductPinRow key={p.id} pin={p} post={post} busy={busy} />
                ))}
              </tbody>
            </table>
          </div>

          <h4 className="mt-5 text-[13px] font-bold text-amber-300">✅ Products You Activated</h4>
          <div className="tbl-wrap mt-2">
            <table className="tbl">
              <thead><tr><th>Activated On</th><th>Product</th><th>Code</th><th>Activated For</th><th>Status</th></tr></thead>
              <tbody>
                {data.selfActivatedProducts.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500">No products activated by you yet.</td></tr>}
                {data.selfActivatedProducts.map((p) => (
                  <tr key={p.id}>
                    <td className="text-zinc-500">{dt(p.used_at, 'm/d/Y h:i A')}</td>
                    <td className="font-bold text-amber-300">{p.package_type}</td>
                    <td><code className="text-[11px]">{p.pin_code}</code></td>
                    <td>{p.recipient || ''}</td>
                    <td><Badge tone="ok">Active</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

        <div className="card" style={{ borderColor: '#8a6d1f' }}>
          <h3 className="text-[15px] font-bold text-gold">🔑 Package Vault</h3>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <VaultStat label="Activated (this month)" value={data.vaultCounts.activatedThisMonth} tone="text-emerald-400" />
            <VaultStat label="Available" value={data.vaultCounts.packages} tone="text-gold" />
            <VaultStat label="Premium" value={data.vaultCounts.premium} tone="text-sky-400" />
            <VaultStat label="StarPremium" value={data.vaultCounts.starpremium} tone="text-amber-500" />
          </div>
          <div className="tbl-wrap mt-3">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Package</th><th>Code</th><th>Transfer / Register</th></tr></thead>
              <tbody>
                {data.packagePins.length === 0 && <tr><td colSpan={4} className="text-center text-zinc-500">No unused package codes.</td></tr>}
                {data.packagePins.map((p) => (
                  <VaultPinRow key={p.id} pin={p} post={post} busy={busy} onRegister={() => props.setTab('mtab-tree')} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {!data.isChildLogin && (
        <>
          <h3 className="pt-2 text-[16px] font-bold text-gold">{isStarterRankLocal ? '💰 Product Commission' : '📶 Unilevel & Product Commission'}</h3>
          <UnilevelTab {...props} />
        </>
      )}

{!childMode && (
      <div className="card">
        <h3 className="text-[15px] font-bold text-emerald-400">⚡ Admin Activation History</h3>
        <div className="tbl-wrap mt-3">
          <table className="tbl">
            <thead><tr><th>Activated On</th><th>Product</th><th>Code</th><th>Status</th></tr></thead>
            <tbody>
              {data.adminActivatedProducts.length === 0 && <tr><td colSpan={4} className="text-center text-zinc-500">No products have been activated by an administrator yet.</td></tr>}
              {data.adminActivatedProducts.map((p) => (
                <tr key={p.id}>
                  <td className="text-zinc-500">{dt(p.used_at, 'm/d/Y h:i A')}</td>
                  <td className="font-bold text-emerald-300">{p.package_type}</td>
                  <td><code className="text-[11px]">{p.pin_code}</code></td>
                  <td><Badge tone="ok">Activated by Admin</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      <div className="card">
        <h3 className="text-[15px] font-bold text-zinc-100">🧾 Purchase History</h3>
        <OrderHistory orders={orders} tone="text-zinc-200" />
      </div>
    </div>
  );
}

function VaultStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-[#0a0a0a] px-2 py-3">
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cx('text-xl font-extrabold', tone)}>{value}</div>
    </div>
  );
}

function VaultPinRow({ pin, post, busy, onRegister }: { pin: PinRow; post: PostFn; busy: boolean; onRegister?: () => void }) {
  const [target, setTarget] = React.useState('');
  return (
    <tr>
      <td className="text-zinc-500">{dt(pin.created_at, 'm/d/Y')}</td>
      <td className="font-bold text-gold">{pin.package_type}</td>
      <td><code className="rounded bg-[#0a0a0a] px-1.5 py-0.5 text-[11px] text-zinc-300">{pin.pin_code}</code></td>
      <td>
        <div className="flex flex-wrap items-center gap-2">
          {onRegister && (
            <button type="button" className="btn-gold btn-xs" onClick={onRegister}>Register</button>
          )}
          <form
            className="flex items-center gap-1"
            onSubmit={async (e) => {
              e.preventDefault();
              await post({ action: 'transfer-pin', pin_id: pin.id, target });
            }}
          >
            <input className="input !w-[130px] !py-1.5" placeholder="Target Username" required value={target} onChange={(e) => setTarget(e.target.value)} />
            <button type="submit" disabled={busy} className="btn btn-xs !bg-blue-700 text-white hover:!bg-blue-600">Transfer</button>
          </form>
        </div>
      </td>
    </tr>
  );
}

export function isProductOrder(details: string, productNames: string[]): boolean {
  const m = /ORDER:\s*\d+x\s*(.+?)(?:\s*\||$)/.exec(details || '');
  if (!m) return false;
  return productNames.includes(m[1].trim());
}

export function OrderHistory({ orders, tone }: { orders: { id: number; created_at: unknown; order_details: string; status: string }[]; tone: string }) {
  return (
    <div className="tbl-wrap mt-3">
      <table className="tbl">
        <thead><tr><th>Date</th><th>Order Details</th><th>Status</th></tr></thead>
        <tbody>
          {orders.length === 0 && <tr><td colSpan={3} className="text-center text-zinc-500">No orders.</td></tr>}
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="text-zinc-500">{dt(o.created_at, 'm/d/Y')}</td>
              <td className={cx('!whitespace-normal', tone)}>{o.order_details.replace('ORDER: ', '').replace('FREE ACCOUNT:', 'REGISTRATION:')}</td>
              <td>
                {o.status === 'pending' ? <Badge tone="warn">Pending</Badge> : o.status === 'approved' ? <Badge tone="ok">Approved</Badge> : <Badge tone="bad">Rejected</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductPinRow({ pin, post, busy }: { pin: PinRow; post: PostFn; busy: boolean }) {
  const [target, setTarget] = React.useState('');
  return (
    <tr>
      <td className="text-zinc-500">{dt(pin.created_at, 'm/d/Y')}</td>
      <td className="font-bold text-sky-400">{pin.package_type}</td>
      <td>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className="btn btn-xs !bg-amber-600 font-semibold text-white hover:!bg-amber-500"
            onClick={async () => {
              if (!confirmDialog('Activate this product for your OWN account?')) return;
              await post({ action: 'activate-product', pin_id: pin.id });
            }}
          >
            Use for Self
          </button>
          <form
            className="flex items-center gap-1"
            onSubmit={async (e) => { e.preventDefault(); await post({ action: 'activate-product', pin_id: pin.id, target }); }}
          >
            <span className="text-[11px] text-zinc-500">or target:</span>
            <input className="input !w-[110px] !py-1.5" placeholder="Username" required value={target} onChange={(e) => setTarget(e.target.value)} />
            <button type="submit" disabled={busy} className="btn btn-xs !bg-emerald-700 text-white hover:!bg-emerald-600">Activate</button>
          </form>
        </div>
      </td>
    </tr>
  );
}

/* ============================ MY PRODUCTS VAULT ============================ */
function ProductVaultTab(props: MemberPortalProps & { post: PostFn; busy: boolean }) {
  const { data, post, busy } = props;
  const [transferPin, setTransferPin] = React.useState<PinRow | null>(null);
  const [target, setTarget] = React.useState('');
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-gold">🎁 My Products Vault</h3>
      <p className="mt-1 text-[13px] text-zinc-500">
        Your purchased products are held here. <b>Activate</b> a product to distribute unilevel commissions to your uplines, or <b>Transfer</b> it to another member who can activate it.
      </p>
      {data.productPins.length === 0 ? (
        <Empty icon="🛒">No products in your vault.</Empty>
      ) : (
        <div className="tbl-wrap mt-4">
          <table className="tbl">
            <thead><tr><th>Code</th><th>Product</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {data.productPins.map((p) => (
                <tr key={p.id}>
                  <td><code className="rounded bg-[#0a0a0a] px-1.5 py-0.5 text-[12px]">{p.pin_code}</code></td>
                  <td className="font-bold">{p.package_type}</td>
                  <td><Badge tone="info">Unused</Badge></td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <form onSubmit={async (e) => { e.preventDefault(); await post({ action: 'activate-product', pin_id: p.id }); }}>
                        <button type="submit" disabled={busy} className="btn btn-xs !bg-emerald-600 text-white hover:!bg-emerald-500">▶ Activate</button>
                      </form>
                      <button type="button" className="btn btn-xs !bg-amber-500 font-semibold text-black hover:!bg-amber-400" onClick={() => { setTransferPin(p); setTarget(''); }}>
                        📦 Transfer
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-zinc-500">
        💡 <b>Activate:</b> Use the product yourself. Commissions go to YOUR uplines. 💡 <b>Transfer:</b> Send to another member. They activate and commissions go to THEIR uplines.
      </p>

      <Modal open={!!transferPin} onClose={() => setTransferPin(null)} title="📦 Transfer Product">
        <p className="text-[13px] text-zinc-400">
          Transferring: <b className="text-zinc-100">{transferPin?.package_type}</b>
          <span className="block text-[11px] text-zinc-500">Code: {transferPin?.pin_code}</span>
        </p>
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!transferPin) return;
            await post({ action: 'transfer-product', pin_id: transferPin.id, target });
            setTransferPin(null);
          }}
        >
          <div><span className="lbl">Transfer to Username</span><input className="input" placeholder="@username" required value={target} onChange={(e) => setTarget(e.target.value)} /></div>
          <button type="submit" disabled={busy} className="btn-gold w-full">📦 Transfer Product</button>
        </form>
      </Modal>
    </div>
  );
}

/* ============================ ASSOCIATES ============================ */
function AssociatesTab({ associates }: { associates: AssociatesData | null }) {
  if (!associates) return <Empty>No associate data.</Empty>;
  const combined = [
    ...associates.direct.map((r) => ({ ...r, kind: 'DIRECT' as const })),
    ...associates.spillover.map((r) => ({ ...r, kind: 'SPILLOVER' as const })),
    ...associates.spilledIn.map((r) => ({ ...r, kind: 'SPILLED IN' as const })),
  ].sort((a, b) => String(b.registered_at).localeCompare(String(a.registered_at)));
  return (
    <div className="card animate-fadeIn">
      <h3 className="text-[16px] font-bold text-gold">🤝 My Associates</h3>
      <p className="mt-1 text-[12px] text-zinc-500">
        DIRECT includes members you personally sponsored through normal placement. SPILLOVER means members placed on your own Right downline spillover chain.
        SPILLED IN means members who landed in your network via spillover from an upline.
      </p>
      <div className="mt-2 flex gap-2 text-[12px]">
        <Badge tone="info">DIRECT {associates.counts.direct}</Badge>
        <Badge tone="ok">SPILLOVER {associates.counts.spillover}</Badge>
        <Badge tone="violet">SPILLED IN {associates.counts.spilledIn}</Badge>
      </div>
      <div className="tbl-wrap mt-3">
        <table className="tbl">
          <thead><tr><th>Reg. Date</th><th>Username</th><th>Full Name</th><th>Type</th><th>Account</th></tr></thead>
          <tbody>
            {combined.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500">You have no direct or spillover associates yet.</td></tr>}
            {combined.map((r) => (
              <tr key={`${r.kind}-${r.id}`}>
                <td className="text-zinc-500">{r.registered_at}</td>
                <td className="font-bold text-sky-400">@{r.username}</td>
                <td>{r.name}</td>
                <td>{r.kind === 'DIRECT' ? <Badge tone="info">DIRECT</Badge> : r.kind === 'SPILLOVER' ? <Badge tone="ok">SPILLOVER</Badge> : <Badge tone="violet">SPILLED IN</Badge>}</td>
                <td>{rankBadge(r.rank)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================ PROFILE ============================ */
function ProfileTab(props: MemberPortalProps & { post: PostFn; busy: boolean }) {
  const { data, post, busy } = props;
  const user = data.user;
  const earn = data.earnings;
  const [f, setF] = React.useState({
    gender: user.gender || 'Male', civil: user.civil || 'Single', bday: user.bday || '',
    address: user.address || '', phone: user.phone || '', email: user.email || '',
    new_password: '', confirm_password: '', profile_picture: user.profile_picture || '',
  });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const [upgradePinId, setUpgradePinId] = React.useState(0);

  function onPic(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 350_000) { alert('Image too large (max ~350KB for in-app storage).'); return; }
    const reader = new FileReader();
    reader.onload = () => set('profile_picture', String(reader.result));
    reader.readAsDataURL(file);
  }

  const upgradeCard = data.canUpgrade ? (
      <div className="card" style={{ borderColor: '#d97706' }}>
        <h3 className="text-[15px] font-bold text-amber-500">⬆️ Upgrade Account</h3>
        <p className="text-[12px] text-zinc-500">Use an eligible package code from your vault to upgrade. Starter can upgrade to Premium or StarPremium; Premium can upgrade to StarPremium.</p>
        <form
          className="mt-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!confirmDialog('Upgrade your account? This will consume the selected code.')) return;
            await post({ action: 'upgrade', pin_id: upgradePinId });
          }}
        >
          <span className="lbl">Select Upgrade Code from Vault</span>
          <select className="select" required value={upgradePinId} onChange={(e) => setUpgradePinId(Number(e.target.value))}>
            <option value={0}>-- Choose Upgrade Code --</option>
            {data.upgradePins.map((p) => <option key={p.id} value={p.id}>{p.package_type} (Code #{p.id})</option>)}
            {data.upgradePins.length === 0 && <option value={0} disabled>No eligible upgrade codes available — purchase one first</option>}
          </select>
          <button type="submit" disabled={busy || !upgradePinId} className="btn mt-3 w-full !bg-amber-600 font-bold text-black hover:!bg-amber-500 disabled:opacity-40">
            ⬆️ Confirm Upgrade
          </button>
        </form>
      </div>
  ) : null;

  if (data.isChildLogin) {
    return (
      <div className="animate-fadeIn space-y-4">
        <div className="card">
          <h3 className="text-[16px] font-bold text-gold">Child Account Details</h3>
          <div className="mt-3 space-y-2 text-[13px]">
            <div className="flex justify-between"><span className="text-zinc-500">Username</span><strong>@{user.username}</strong></div>
            <div className="flex justify-between"><span className="text-zinc-500">ID#</span><strong>{data.idStatus.id_number || 'Pending Admin Setup'}</strong></div>
            <div className="flex justify-between"><span className="text-zinc-500">Name</span><strong>{user.first_name} {user.last_name}</strong></div>
            <div className="flex justify-between"><span className="text-zinc-500">Current Rank</span><strong className="text-gold">{user.rank}</strong></div>
          </div>
          <p className="mt-3 text-[12px] text-zinc-500">Profile details and other settings for this node are managed through your Mother Account. You can upgrade this Child Account's package below using a Premium/StarPremium code from this Child Account's own vault.</p>
        </div>
        {upgradeCard ?? (
          <div className="card">
            <h3 className="text-[15px] font-bold text-amber-500">⬆️ Upgrade Account</h3>
            <p className="mt-1 text-[12px] text-zinc-500">No upgrade is currently available for this Child Account.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fadeIn space-y-4">
      <div className="card">
        <h3 className="text-[16px] font-bold text-gold">Details (From Registration)</h3>
        <form
          className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"
          onSubmit={async (e) => { e.preventDefault(); await post({ action: 'profile', ...f }); }}
        >
          <div>
            <h4 className="mb-2 text-[13px] font-bold text-red-400">Read-Only Data</h4>
            <span className="lbl">Username</span><input className="input" readOnly value={user.username} />
            <div className="form-row mt-1">
              <div><span className="lbl">ID#</span><input className="input" readOnly value={data.idStatus.id_number || 'Pending Admin Setup'} /></div>
              <div><span className="lbl">Expiration</span><input className="input" readOnly value={data.idStatus.expires || 'Pending Admin Setup'} /></div>
            </div>
            <span className="lbl mt-1">First Name</span><input className="input" readOnly value={user.first_name} />
            <span className="lbl mt-1">Middle Name</span><input className="input" readOnly value={user.middle_name} />
            <span className="lbl mt-1">Lastname</span><input className="input" readOnly value={user.last_name} />
          </div>
          <div className="rounded-lg border border-line bg-[#0a0a0a] p-4">
            <h4 className="mb-2 text-[13px] font-bold text-emerald-400">Editable Information</h4>
            <div className="rounded-lg border border-dashed border-gold/60 p-3">
              <span className="lbl !text-gold">Profile Picture (JPG/PNG max ~350KB)</span>
              <input type="file" accept="image/jpeg,image/png" className="input !py-2" onChange={onPic} />
            </div>
            <div className="form-row mt-3">
              <div><span className="lbl">Bday</span><input className="input" type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(f.bday) ? f.bday : ''} onChange={(e) => set('bday', e.target.value)} /></div>
              <div>
                <span className="lbl">Gender</span>
                <select className="select" value={f.gender} onChange={(e) => set('gender', e.target.value)}><option>Male</option><option>Female</option></select>
              </div>
            </div>
            <span className="lbl mt-1">Single/Married</span>
            <select className="select" value={f.civil} onChange={(e) => set('civil', e.target.value)}><option>Single</option><option>Married</option></select>
            <span className="lbl mt-1">Phone Number</span><input className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="09xxxxxxxxx" />
            <span className="lbl mt-1">Email</span><input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
            <span className="lbl mt-1">Address</span><textarea className="textarea" value={f.address} onChange={(e) => set('address', e.target.value)} />
            <div className="mt-3 rounded-lg border border-dashed border-red-800 bg-red-950/30 p-3">
              <h4 className="text-[13px] font-bold text-red-400">🔐 Change Password</h4>
              <span className="lbl mt-2">New Password</span><input className="input" type="password" placeholder="Leave blank to keep current" value={f.new_password} onChange={(e) => set('new_password', e.target.value)} />
              <span className="lbl mt-1">Confirm Password</span><input className="input" type="password" placeholder="Re-enter new password" value={f.confirm_password} onChange={(e) => set('confirm_password', e.target.value)} />
            </div>
            <button type="submit" disabled={busy} className="btn-gold mt-3 w-full">SAVE PROFILE CHANGES</button>
          </div>
        </form>
      </div>

      {upgradeCard}

      <div className="card">
        <h3 className="border-b border-line pb-2 text-[15px] font-bold text-emerald-400">📊 Earnings Summary</h3>
        <div className="mt-2 space-y-1 text-[13px]">
          <div className="flex justify-between"><span>Direct Referral Bonus</span><strong>{peso(earn.dr)}</strong></div>
          <div className="flex justify-between"><span>A+B Pairing Bonus</span><strong>{peso(earn.pairingReleased)}</strong></div>
          <div className="flex justify-between"><span>Tri-Leg / Right-Leg Bonus</span><strong>{peso(earn.tri)}</strong></div>
          <div className="flex justify-between"><span>Waiting Points (L / C / R)</span><strong className="text-amber-300">{data.activeAccount.left_points} / {data.activeAccount.center_points} / {data.activeAccount.right_points}</strong></div>
          <div className="flex justify-between rounded-lg border border-violet-700/60 bg-violet-950/30 px-2 py-1.5">
            <span className="text-violet-300">🔗 Total A+B + Tri-Leg</span>
            <strong className="text-violet-300">{peso(earn.pairingReleased + earn.tri)} <small className="font-normal">({data.activeAccount.pairing_count} tri-leg triggers / {earn.gc} GC)</small></strong>
          </div>
          <div className="flex justify-between"><span>Unilevel Commission</span><strong>{peso(earn.unilevel)}</strong></div>
          {data.activeAccount.account_type !== 'CA' && (<>
          <div className="flex justify-between text-amber-300"><span>FLOATING Unilevel Commission (LP)</span><strong>{peso(earn.unilevelPendingCutoff)}</strong></div>
          <div className="flex justify-between text-amber-300"><span>FLOATING Product Commission (PC)</span><strong>{peso(earn.productCommPending)}</strong></div>
          </>)}
          <div className="flex justify-between"><span>Available GC</span><strong className="text-sky-400">{earn.gc}</strong></div>
          <div className="flex justify-between border-t border-dashed border-line pt-2 font-bold"><span>TOTAL EARNINGS</span><strong className="text-gold">{peso(earn.totalEarned)}</strong></div>
          <div className="flex justify-between"><span>Total Encashed</span><strong className="text-red-400">-{peso(earn.totalEncashed)}</strong></div>
          <div className="flex justify-between"><span>Pending Encashment</span><strong className="text-amber-300">-{peso(earn.pendingEncash)}</strong></div>
          <div className="flex justify-between border-t-2 border-gold pt-2 text-[15px] font-bold"><span>NET AVAILABLE</span><strong className="text-emerald-400">{peso(earn.balance)}</strong></div>
        </div>
      </div>
    </div>
  );
}
