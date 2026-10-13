'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { api, Toast, useToast } from './ui';

export default function LoginForm({ initialMode = 'member', gatewayError = '' }: { initialMode?: 'member' | 'admin'; gatewayError?: string }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<'member' | 'admin'>(initialMode);
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPass, setShowPass] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(gatewayError);
  const [toast, setToast] = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ redirect: string }>('/api/auth/login', { username, password, mode });
      router.push(res.redirect || (mode === 'admin' ? '/admin-dashboard' : '/member-portal'));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const admin = mode === 'admin';
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="card !p-6">
        {!admin ? (
          <>
            <h2 className="text-center text-2xl font-extrabold text-zinc-50">Welcome Back</h2>
            <p className="mt-1 text-center text-[13px] text-zinc-500">Sign in to your member portal</p>
          </>
        ) : (
          <>
            <h2 className="text-center text-2xl font-extrabold text-gold">System Admin</h2>
            <p className="mt-1 text-center text-[12px] font-semibold text-red-400">Restricted Gateway Access</p>
          </>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-center text-[13px] text-red-300">
            ❌ {error}
          </div>
        )}

        <form onSubmit={submit} className="mt-5 space-y-3" autoComplete="off">
          <div>
            <input
              className="input"
              placeholder={admin ? 'Admin ID' : 'Username (or C1/C2/C3 Alias)'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div>
            <input
              className="input"
              type={showPass ? 'text' : 'password'}
              placeholder={admin ? 'Access Key' : 'Password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-[12px] text-zinc-500">
              <input type="checkbox" className="check" checked={showPass} onChange={(e) => setShowPass(e.target.checked)} />
              Show password
            </label>
          </div>
          <button
            type="submit"
            disabled={busy}
            className={admin ? 'btn w-full !bg-red-700 font-bold text-white hover:!bg-red-600' : 'btn-gold w-full'}
          >
            {busy ? 'Signing in…' : admin ? 'Authenticate' : 'Sign In'}
          </button>
        </form>

        {!admin ? (
          <div className="mt-6 border-t border-line pt-4 text-center">
            <a href="/member-registration" className="block font-semibold text-gold hover:underline">
              Register a New Account
            </a>
            <button
              type="button"
              className="mt-3 text-[12px] text-zinc-500 underline hover:text-zinc-300"
              onClick={() => { setMode('admin'); setError(''); }}
            >
              Admin Gateway Login
            </button>
          </div>
        ) : (
          <div className="mt-6 border-t border-line pt-4 text-center">
            <button
              type="button"
              className="text-[12px] text-zinc-500 underline hover:text-zinc-300"
              onClick={() => { setMode('member'); setError(''); }}
            >
              Return to Member Login
            </button>
          </div>
        )}
      </div>
      <p className="mt-4 text-center text-[11px] text-zinc-600">
        Tip: Child Account nodes can be opened directly with the C1/C2/C3 username alias.
      </p>
    </div>
  );
}
