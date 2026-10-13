'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { api, peso, Toast, useToast } from './ui';
import type { PackageRow } from '@/lib/types';

export default function RegisterWizard({ packages }: { packages: PackageRow[] }) {
  const router = useRouter();
  const [step, setStep] = React.useState(1);
  const [pkgName, setPkgName] = React.useState('');
  const [variant, setVariant] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [toast, setToast] = useToast();
  const [form, setForm] = React.useState({
    sponsor: '', username: '', password: '', first_name: '', middle_name: '',
    last_name: '', bday: '', phone: '', email: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const variantsOf = (p: PackageRow): string[] => {
    const list = (p.pkg_variants || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : [`${p.pkg_name} Standard`];
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const required: [string, string][] = [
      ['sponsor', 'Sponsor'], ['username', 'Username'], ['password', 'Password'],
      ['first_name', 'First name'], ['last_name', 'Last name'], ['bday', 'Birthdate'], ['phone', 'Mobile number'],
    ];
    for (const [k, label] of required) {
      if (!form[k as keyof typeof form].trim()) {
        setError(`Please fill out: ${label}`);
        return;
      }
    }
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(form.bday)) {
      setError('Birthdate must be MM/DD/YYYY.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/register', { ...form, package_name: pkgName, variant });
      setToast({ kind: 'ok', text: 'Registration submitted! Redirecting to your portal…' });
      setTimeout(() => { router.push('/member-portal'); router.refresh(); }, 700);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="card !p-6">
        <div className="mx-auto mb-6 flex w-1/2 items-center justify-between">
          {[1, 2].map((n) => (
            <div
              key={n}
              className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-[13px] font-bold ${
                step >= n ? 'border-gold text-gold' : 'border-line text-zinc-500'
              }`}
            >
              {n}
            </div>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-center text-[13px] text-red-300">
            ❌ {error}
          </div>
        )}

        {step === 1 && (
          <div className="animate-fadeIn">
            <h2 className="text-center text-xl font-extrabold text-gold">Select Your Package</h2>
            <p className="mb-5 text-center text-[13px] text-zinc-500">Choose your entry level and product variation.</p>
            <div className="space-y-4">
              {packages.length === 0 && <p className="text-center text-zinc-500">No packages available.</p>}
              {packages.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-xl border border-line">
                  <div className="border-b border-line bg-card2 px-4 py-3">
                    <h3 className="flex items-center justify-between text-[16px] font-bold text-zinc-50">
                      {p.pkg_name}
                      <span className="text-gold">{peso(p.pkg_price)}</span>
                    </h3>
                    <p className="mt-0.5 text-[12px] text-zinc-500">{p.pkg_desc}</p>
                  </div>
                  <div className="space-y-2 px-4 py-3">
                    {variantsOf(p).map((v) => {
                      const id = `pkg-${p.id}-${v}`;
                      const selected = pkgName === p.pkg_name && variant === v;
                      return (
                        <label
                          key={id}
                          htmlFor={id}
                          className={`block cursor-pointer rounded-lg border-2 px-4 py-3 text-[13px] transition ${
                            selected ? 'border-gold bg-gold/5 text-zinc-50' : 'border-line bg-[#0a0a0a] text-zinc-300 hover:border-zinc-600'
                          }`}
                        >
                          <input
                            type="radio"
                            id={id}
                            name="pkg_selection"
                            className="mr-2 accent-[#F5E121]"
                            checked={selected}
                            onChange={() => { setPkgName(p.pkg_name); setVariant(v); }}
                          />
                          {v}
                          {selected && <span className="float-right font-bold text-gold">✓</span>}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={!pkgName}
              onClick={() => setStep(2)}
              className="btn-gold mt-5 w-full disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next Step →
            </button>
            <div className="mt-5 border-t border-line pt-4 text-center">
              <a href="/member-login" className="text-[13px] text-zinc-500 underline hover:text-zinc-300">
                Already registered? Log In
              </a>
            </div>
          </div>
        )}

        {step === 2 && (
          <form onSubmit={submit} className="animate-fadeIn">
            <h2 className="text-center text-xl font-extrabold text-gold">Personal &amp; Account Info</h2>
            <p className="mb-5 text-center text-[12px] text-zinc-500">
              Create your account. Admin will activate it upon payment confirmation.
            </p>

            <span className="lbl">Sponsor Information</span>
            <input className="input" placeholder="Sponsor's Username (Who invited you?)" value={form.sponsor} onChange={(e) => set('sponsor', e.target.value)} required />

            <span className="lbl mt-3">Account Setup</span>
            <div className="form-row">
              <input className="input" placeholder="Desired Username" value={form.username} onChange={(e) => set('username', e.target.value)} required />
              <input className="input" type="password" placeholder="Account Password" value={form.password} onChange={(e) => set('password', e.target.value)} minLength={6} pattern="[A-Za-z0-9]{6,}" title="At least 6 alphanumeric characters" required />
            </div>

            <span className="lbl mt-3">Personal Identity</span>
            <div className="form-row">
              <input className="input" placeholder="First Name" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} required />
              <input className="input" placeholder="Middle Name (Optional)" value={form.middle_name} onChange={(e) => set('middle_name', e.target.value)} />
            </div>
            <input className="input mt-3" placeholder="Last Name" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} required />

            <span className="lbl mt-3">Birthdate (MM/DD/YYYY)</span>
            <input className="input" placeholder="MM/DD/YYYY" value={form.bday} onChange={(e) => set('bday', e.target.value)} pattern="\d{2}/\d{2}/\d{4}" required />

            <span className="lbl mt-3">Contact Information</span>
            <div className="form-row">
              <input className="input" placeholder="Mobile Number" value={form.phone} onChange={(e) => set('phone', e.target.value)} required />
              <input className="input" type="email" placeholder="Email Address (Optional)" value={form.email} onChange={(e) => set('email', e.target.value)} />
            </div>

            <div className="mt-5 flex gap-3">
              <button type="button" className="btn-dark flex-1" onClick={() => setStep(1)}>⬅ Back</button>
              <button type="submit" disabled={busy} className="btn flex-1 !bg-emerald-600 font-bold text-white hover:!bg-emerald-500">
                {busy ? 'Submitting…' : 'Submit Registration ⚡'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
