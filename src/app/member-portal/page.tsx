import { redirect } from 'next/navigation';
import { one, scalar } from '@/lib/db';
import { ensureSettings, settingBool, settingNum } from '@/lib/settings';
import { getActiveNode, getSession, getUserById } from '@/lib/auth';
import { phFormat } from '@/lib/time';
import {
  downlineEarningsTable,
  genealogyPayload,
  memberPortalData,
} from '@/lib/queries';
import { associatesForUser } from '@/lib/engine/tree';
import { treeSlotStates } from '@/lib/engine/tree';
import MemberPortal from '@/components/MemberPortal';
import PendingActivation from '@/components/PendingActivation';

export const dynamic = 'force-dynamic';

const serial = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export default async function MemberPortalPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view_node?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/member-login');
  await ensureSettings();

  const user = await getUserById(session.uid);
  if (!user) redirect('/member-login');
  const sp = await searchParams;

  if (settingBool('mlm_maintenance_mode', false) && !user.is_admin) {
    return (
      <div className="mx-auto flex min-h-[80vh] w-full max-w-lg items-center px-4 py-10">
        <div className="card w-full !p-6 text-center">
          <h2 className="text-xl font-extrabold text-red-400">🔧 System Under Maintenance</h2>
          <p className="mt-2 text-[13px] text-zinc-400">
            The system is currently being updated. Your data and network are safe — no changes will be lost.
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-red-800 bg-red-950/40 p-3 text-[12px] text-red-300">
            We are performing system improvements. Please check back shortly.
          </div>
          <form action="/api/auth/logout" method="post">
            <button className="btn-ghost mt-4 text-[12px] underline" type="submit">Log Out</button>
          </form>
        </div>
      </div>
    );
  }

  if (user.activation_status === 'pending') {
    const pin = await one<{ id: number }>(
      `SELECT id FROM pins WHERE purchaser_id=$1 AND is_product=0 AND status='unused' ORDER BY id ASC LIMIT 1`,
      [user.id],
    );
    return <PendingActivation hasApprovedCode={!!pin} pkgName={user.rank} />;
  }

  if (user.account_held) {
    return (
      <div className="mx-auto flex min-h-[80vh] w-full max-w-lg items-center px-4 py-10">
        <div className="card w-full !p-6 text-center">
          <h2 className="text-xl font-extrabold text-red-400">🔒 Account On Hold</h2>
          <p className="mt-2 text-[13px] text-zinc-400">
            Your account has been temporarily placed on hold by the Administrator. You cannot access the dashboard while on hold.
          </p>
          <form action="/api/auth/logout" method="post">
            <button className="btn mt-4 !bg-red-600 font-semibold text-white hover:!bg-red-500" type="submit">Log Out</button>
          </form>
        </div>
      </div>
    );
  }

  const node = await getActiveNode();
  const data = await memberPortalData(Number(user.id), node);
  if (!data || !data.activeAccount) {
    return (
      <div className="mx-auto flex min-h-[80vh] w-full max-w-lg items-center px-4 py-10">
        <div className="card w-full !p-6 text-center">
          <h3 className="text-lg font-bold text-red-400">Account Not Found</h3>
          <p className="mt-1 text-[13px] text-zinc-400">Your MLM account record is missing. Please contact the Administrator.</p>
          <form action="/api/auth/logout" method="post">
            <button className="btn-gold mt-4" type="submit">Log Out</button>
          </form>
        </div>
      </div>
    );
  }

  const activeId = Number(data.activeAccount.id);
  let focusId = sp.view_node ? Number(sp.view_node) : activeId;
  if (!Number.isFinite(focusId) || focusId <= 0) focusId = activeId;

  const payload = await genealogyPayload(activeId, focusId);
  if (!payload.focus) {
    focusId = activeId;
  }
  const treePayload = payload.focus ? payload : await genealogyPayload(activeId, activeId);

  const slotStates =
    data.isChildLogin || !data.ma ? {} : await treeSlotStates(focusId, Number(data.ma.id));
  const associates = data.isChildLogin ? null : await associatesForUser(Number(user.id));
  const downlineEarnings = await downlineEarningsTable(activeId);

  const directChildren = data.ma
    ? Number((await scalar<string>('SELECT COUNT(*) FROM accounts WHERE upline_id=$1', [data.ma.id])) ?? 0)
    : 3;
  const caSlotsOpen = data.isChildLogin ? 0 : Math.max(0, 3 - Math.min(3, directChildren));

  return (
    <MemberPortal
      data={serial(data)}
      node={serial(node)}
      focusAccountId={focusId}
      treeRoot={serial(treePayload.focus)}
      slotStates={serial(slotStates)}
      downlineOptions={serial(treePayload.downlineOptions)}
      associates={serial(associates)}
      downlineEarnings={serial(downlineEarnings)}
      encashSettings={{
        taxRate: settingNum('mlm_sys_tax', 10),
        fee: settingNum('mlm_sys_fee', 20),
        min: settingNum('mlm_sys_min_encash', 1000),
        transferFee: settingNum('mlm_sys_fund_transfer_fee', 25),
      }}
      caSlotsOpen={caSlotsOpen}
      nowText={phFormat(new Date(), 'M d, Y - g:i A')}
      initialTab={sp.tab || 'mtab-overview'}
    />
  );
}
