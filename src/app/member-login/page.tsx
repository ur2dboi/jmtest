import LoginForm from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default function MemberLoginPage() {
  return (
    <div className="grid-bg min-h-screen">
      <div className="mx-auto max-w-md px-4 pt-10 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-gold to-goldsoft text-xl font-extrabold text-black">
          MJ
        </div>
        <h1 className="text-2xl font-extrabold">
          MJ<span className="text-gold">Premium</span>
        </h1>
        <p className="text-[12px] text-zinc-500">Ultimate MLM System · Member Portal</p>
      </div>
      <LoginForm />
    </div>
  );
}
