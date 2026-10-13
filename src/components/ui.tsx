'use client';

import React from 'react';

/* Shared UI primitives (plugin theme: black + gold). */

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export const peso = (v: number | string | null | undefined) =>
  `₱${(Number(v ?? 0) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Stat({
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className={cx('stat', onClick && 'cursor-pointer')} onClick={onClick}>
      <span className="stat-label">{label}</span>
      <span className={cx('stat-value', accent && 'gold')}>{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

export function Badge({
  tone = 'gold',
  children,
}: {
  tone?: 'gold' | 'ma' | 'ca' | 'free' | 'ok' | 'bad' | 'warn' | 'info' | 'violet';
  children: React.ReactNode;
}) {
  return <span className={`badge-${tone}`}>{children}</span>;
}

export function rankBadge(rank: string) {
  const n = (rank || '').replace(/\s+/g, '').toLowerCase();
  if (n.includes('starpremium')) return <Badge tone="gold">StarPremium</Badge>;
  if (n.includes('starter')) return <Badge tone="info">Starter</Badge>;
  return <Badge tone="warn">Premium</Badge>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-zinc-400">
      <span className="spinner" /> {label ?? 'Loading…'}
    </span>
  );
}

export function Empty({ icon = '📭', children }: { icon?: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="text-3xl">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className={cx('card w-full animate-fadeIn !p-0', wide ? 'max-w-3xl' : 'max-w-lg')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-[15px] font-bold text-zinc-50">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xl leading-none text-zinc-400 hover:bg-card2 hover:text-red-400"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export interface ToastMsg {
  kind: 'ok' | 'err' | 'info';
  text: string;
}

export function Toast({ toast, onClose }: { toast: ToastMsg | null; onClose: () => void }) {
  if (!toast) return null;
  const styles =
    toast.kind === 'ok'
      ? 'border-emerald-700 bg-emerald-950/90 text-emerald-200'
      : toast.kind === 'err'
        ? 'border-red-800 bg-red-950/90 text-red-200'
        : 'border-zinc-600 bg-zinc-900/90 text-zinc-100';
  return (
    <div className={cx('toast', styles)} role="status">
      <span>{toast.kind === 'ok' ? '✅' : toast.kind === 'err' ? '⛔' : 'ℹ️'}</span>
      <span className="flex-1">{toast.text}</span>
      <button type="button" onClick={onClose} className="text-lg leading-none opacity-70 hover:opacity-100">
        ×
      </button>
    </div>
  );
}

export function useToast(): [ToastMsg | null, (t: ToastMsg | null) => void] {
  const [toast, setToast] = React.useState<ToastMsg | null>(null);
  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  return [toast, setToast];
}

/** POST helper for the action APIs. Throws with the server's error message. */
export async function api<T = Record<string, unknown>>(url: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function confirmDialog(message: string): boolean {
  return typeof window === 'undefined' ? true : window.confirm(message);
}

export function reloadSoon(ms = 900) {
  setTimeout(() => window.location.reload(), ms);
}
