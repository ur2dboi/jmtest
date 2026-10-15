import Link from 'next/link';
import { q } from '@/lib/db';
import type { PackageRow } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

const peso = (v: number | string) =>
  `₱${(Number(v) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadPackages(): Promise<{ pkgs: PackageRow[]; prods: PackageRow[] }> {
  try {
    const pkgs = await q<PackageRow>("SELECT * FROM packages WHERE status=1 AND is_product=0 ORDER BY pkg_price ASC");
    const prods = await q<PackageRow>("SELECT * FROM packages WHERE status=1 AND is_product=1 ORDER BY pkg_price ASC");
    return { pkgs, prods };
  } catch {
    return { pkgs: [], prods: [] };
  }
}

const FALLBACK_PKGS = [
  { name: 'Starter', price: 388, desc: 'Entry package — ₱50 Direct Referral on any package you sponsor.', perks: ['Direct Referral ₱50 (any package)', 'Member portal access', 'Upgrade to Premium/StarPremium anytime'] },
  { name: 'Premium', price: 3598, desc: 'The full compensation plan for builders.', perks: ['A+B Pairing ₱200/pt', 'Tri-Leg ₱300/unit', 'Unilevel up to 10 levels', 'Direct Referral ₱300'] },
  { name: 'StarPremium', price: 8998, desc: 'Maximum points and double Tri-Leg units.', perks: ['3 A+B points per member', '2× Tri-Leg units', 'Higher daily limits (30/day)', 'Direct Referral ₱1,000'] },
];

export default async function HomePage() {
  const { pkgs, prods } = await loadPackages();
  const pkgCards =
    pkgs.length > 0
      ? pkgs.map((p) => ({
          name: p.pkg_name,
          price: Number(p.pkg_price),
          desc: p.pkg_desc,
          perks: (p.pkg_variants || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4),
        }))
      : FALLBACK_PKGS;

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-40 border-b border-line bg-black/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-gold to-goldsoft font-extrabold text-black">MJ</span>
            <span className="text-[16px] font-extrabold tracking-wide">MJ<span className="text-gold">Premium</span></span>
          </Link>
          <nav className="hidden items-center gap-5 text-[13px] text-zinc-400 md:flex">
            <a href="#packages" className="hover:text-gold">Packages</a>
            <a href="#comp-plan" className="hover:text-gold">Compensation Plan</a>
            <a href="#products" className="hover:text-gold">Products</a>
            <a href="#how" className="hover:text-gold">How It Works</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/member-login" className="btn-dark btn-sm">Member Login</Link>
            <Link href="/member-registration" className="btn-gold btn-sm">Join Now</Link>
          </div>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="grid-bg border-b border-line">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:py-20">
          <span className="badge-gold">MJPremium Ultimate MLM System</span>
          <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-extrabold leading-tight sm:text-5xl">
            Build Your Network. <span className="gold-text">Earn From Every Level.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
            A strict trinary genealogy with Mother &amp; Child Account separation, point-based A+B pairing,
            Tri-Leg releases, GC awards every 5th pair, and a 10-level dynamic-compression Unilevel —
            engineered for fairness and paid daily in Philippine time.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link href="/member-registration" className="btn-gold !px-6 !py-3 !text-[15px]">Create Your Account</Link>
            <Link href="/member-login" className="btn-dark !px-6 !py-3 !text-[15px]">Open Member Portal</Link>
          </div>
          <div className="mx-auto mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['9,841', 'Nodes per tree (Levels 1–3)'],
              ['₱200', 'Per A+B matched point'],
              ['₱300', 'Per Tri-Leg unit'],
              ['10', 'Unilevel paid tiers'],
            ].map(([v, l]) => (
              <div key={l} className="card !p-3">
                <div className="text-2xl font-extrabold text-gold">{v}</div>
                <div className="text-[11px] text-zinc-500">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- packages ---------- */}
      <section id="packages" className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-center text-3xl font-extrabold">Entry <span className="gold-text">Packages</span></h2>
        <p className="mt-2 text-center text-[13px] text-zinc-500">Choose your entry level. Upgrade anytime with codes from your vault.</p>
        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          {pkgCards.map((p, i) => (
            <div key={p.name} className={`card flex flex-col ${i === 1 ? '!border-gold/60' : ''}`}>
              {i === 1 && <span className="badge-gold mb-2 self-start">Most Popular</span>}
              <h3 className="text-xl font-extrabold text-zinc-50">{p.name}</h3>
              <div className="mt-1 text-3xl font-extrabold text-gold">{peso(p.price)}</div>
              <p className="mt-2 text-[13px] text-zinc-400">{p.desc}</p>
              <ul className="mt-3 flex-1 space-y-1.5 text-[13px] text-zinc-300">
                {p.perks.map((perk) => (
                  <li key={perk} className="flex gap-2"><span className="text-emerald-400">✓</span> {perk}</li>
                ))}
              </ul>
              <Link href="/member-registration" className="btn-gold mt-5 w-full">Get Started</Link>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- comp plan ---------- */}
      <section id="comp-plan" className="border-y border-line bg-[#070707]">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-center text-3xl font-extrabold">The <span className="gold-text">Compensation Plan</span></h2>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[
              ['🎁', 'Direct Referral Bonus', 'Paid to your direct sponsor only — never diluted up the chain. Any pairing involving a Starter pays ₱50; Premium ₱300 · StarPremium ₱1,000, capped by sponsor rank. Premium/StarPremium members also earn ₱20/bottle on direct Starter repeat orders (5 LP maintenance applies, paid monthly with Unilevel).'],
              ['⚖️', 'A+B Pairing Bonus', 'Premium = 1 point, StarPremium = 3 points on the A/B legs. Every matched point pays ₱200. Unmatched strong-leg points stay waiting — no total flush-out.'],
              ['🎟️', 'GC Every 5th Pair', 'Every 5th A+B pair and every 5th Tri-Leg unit awards 1 Gift Certificate instead of cash. GCs count inside the daily limits.'],
              ['🔺', 'Tri-Leg Bonus', 'Completed A+B triggers plus right-leg members release ₱300 per unit. StarPremium receiver + StarPremium source = ₱300 + ₱300.'],
              ['🗜️', 'Dynamic-Compression Unilevel', '10 paid tiers over your sponsor chain. Child Accounts are connectors, and ineligible uplines are compressed out so the next qualified member takes the tier. Qualify with 5 LP/month.'],
              ['🕐', 'Fair Daily Limits', 'MA Premium 15/day · MA StarPremium 30/day · CA Premium 10/day · CA StarPremium 20/day. Windows reset at 12:01 AM Philippine time.'],
            ].map(([icon, title, body]) => (
              <div key={title} className="card card-hover">
                <div className="text-2xl">{icon}</div>
                <h3 className="mt-2 text-[16px] font-bold text-zinc-50">{title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- products ---------- */}
      <section id="products" className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-center text-3xl font-extrabold">Retail <span className="gold-text">Products</span></h2>
        <p className="mt-2 text-center text-[13px] text-zinc-500">Every activated product code counts 1 LP toward Unilevel eligibility.</p>
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(prods.length ? prods : [
            { id: 1, pkg_name: 'Primo Parfum', pkg_price: '350', pkg_desc: 'Signature fragrance line.' },
            { id: 2, pkg_name: 'Extreme Botanic', pkg_price: '350', pkg_desc: 'Botanic personal care.' },
            { id: 3, pkg_name: 'Extreme Diffuser', pkg_price: '350', pkg_desc: 'Home fragrance diffuser.' },
          ] as PackageRow[]).map((p) => (
            <div key={p.id} className="card text-center">
              <div className="text-3xl">🧴</div>
              <h3 className="mt-2 text-[16px] font-bold text-zinc-50">{p.pkg_name}</h3>
              <div className="mt-1 text-xl font-extrabold text-gold">{peso(p.pkg_price)}</div>
              <p className="mt-1 text-[12px] text-zinc-500">{p.pkg_desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section id="how" className="border-t border-line bg-[#070707]">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="text-center text-3xl font-extrabold">How It <span className="gold-text">Works</span></h2>
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-4">
            {[
              ['1', 'Register & Pay', 'Pick a package, register with your sponsor\'s username, and send payment.'],
              ['2', 'Admin Activates', 'Admin verifies payment and unlocks your activation code. Your portal unlocks automatically.'],
              ['3', 'Build Your 3 + 9', 'Activate optional Child Accounts (CA1/CA2/CA3) and place members. Points flow up from grandchildren.'],
              ['4', 'Earn & Encash', 'Watch DR, A+B, Tri-Leg, GC and Unilevel grow in real time. Encash from ₱1,000 with a valid member ID.'],
            ].map(([n, t, b]) => (
              <div key={n} className="card text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border-2 border-gold font-extrabold text-gold">{n}</div>
                <h3 className="mt-3 font-bold text-zinc-50">{t}</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-zinc-400">{b}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href="/member-registration" className="btn-gold !px-8 !py-3 !text-[15px]">Start Building Today</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-[12px] text-zinc-500">
          <span>© {new Date().getFullYear()} MJPremium Corp. All rights reserved.</span>
          <span className="flex gap-4">
            <Link href="/member-login" className="hover:text-gold">Member Login</Link>
            <Link href="/admin-dashboard" className="hover:text-gold">Admin Gateway</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
