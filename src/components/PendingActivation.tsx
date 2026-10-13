'use client';

import React from 'react';
import { api, Toast, useToast } from './ui';

export default function PendingActivation({
  hasApprovedCode,
  pkgName,
}: {
  hasApprovedCode: boolean;
  pkgName: string;
}) {
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = useToast();

  // Auto-sync: once Admin approves, this page unlocks by itself (plugin parity).
  React.useEffect(() => {
    const id = setInterval(() => window.location.reload(), 8000);
    return () => clearInterval(id);
  }, []);

  async function activate(withCode: boolean) {
    setBusy(true);
    try {
      const res = await api<{ message: string }>('/api/member', {
        action: 'activate-pending',
        ...(withCode ? { code: code.trim() } : {}),
      });
      setToast({ kind: 'ok', text: res.message });
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setToast({ kind: 'err', text: (e as Error).message });
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/member-login';
  }

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-lg items-center px-4 py-10">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="card w-full !p-6 text-center">
        <h2 className="text-xl font-extrabold text-gold">Account Pending Activation</h2>
        <p className="mt-1 text-[13px] text-zinc-500">
          Your registration{pkgName ? ` for the ${pkgName} package` : ''} has been submitted to the Admin.
        </p>

        <div className="mt-4 rounded-lg border border-dashed border-red-800 bg-red-950/40 p-4 text-left">
          <h4 className="text-[13px] font-bold text-red-300">How to Activate:</h4>
          <p className="mt-1 text-[12px] text-red-300/90">1. Send exact amount for your chosen package via Cash or Bank Transfer.</p>
          <p className="text-[12px] text-red-300/90">2. Wait for Admin confirmation. Admin will verify your payment.</p>
          <p className="mt-2 text-[12px] text-emerald-300">
            ✨ <strong>Auto-Sync Active:</strong> Once Admin approves your payment, this page will automatically unlock your dashboard!
          </p>
        </div>

        {hasApprovedCode && (
          <button type="button" disabled={busy} onClick={() => activate(false)} className="btn mt-4 w-full !bg-emerald-600 font-bold text-white hover:!bg-emerald-500">
            ⚡ Activate My Account Now
          </button>
        )}

        <div className="mt-4 text-left">
          <span className="lbl">Enter Admin Activation Code (Optional Manual Entry)</span>
          <input
            className="input text-center text-[16px] uppercase tracking-[2px]"
            placeholder="Enter E-Pin Code here..."
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !code.trim()}
            onClick={() => activate(true)}
            className="btn mt-3 w-full !bg-emerald-600 font-bold text-white hover:!bg-emerald-500 disabled:opacity-40"
          >
            Activate My Account ⚡
          </button>
        </div>

        <button type="button" onClick={logout} className="mt-5 text-[12px] text-zinc-500 underline hover:text-zinc-300">
          Log Out
        </button>
      </div>
    </div>
  );
}
