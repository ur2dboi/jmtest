import { q } from '@/lib/db';
import RegisterWizard from '@/components/RegisterWizard';
import type { PackageRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function MemberRegistrationPage() {
  let packages: PackageRow[] = [];
  try {
    packages = await q<PackageRow>("SELECT * FROM packages WHERE status=1 AND is_product=0 ORDER BY pkg_price ASC");
  } catch {
    packages = [];
  }
  return (
    <div className="grid-bg min-h-screen">
      <div className="mx-auto max-w-2xl px-4 pt-8 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-gold to-goldsoft text-xl font-extrabold text-black">
          MJ
        </div>
        <h1 className="text-2xl font-extrabold">
          Join MJ<span className="text-gold">Premium</span>
        </h1>
        <p className="text-[12px] text-zinc-500">Strict manual placement · A+B pairing · Tri-Leg · Unilevel</p>
      </div>
      <RegisterWizard packages={JSON.parse(JSON.stringify(packages))} />
    </div>
  );
}
