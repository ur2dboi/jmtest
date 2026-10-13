import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getSession, getUserById } from './auth';
import type { UserRow } from './types';
import { auditLog } from './engine/accounts';

/** Shared helpers for API route handlers. */

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, ...((data ?? {}) as object) }, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export function err(error: unknown) {
  const e = error as Error & { status?: number };
  console.error('[api]', e);
  return fail(e.message || 'Unexpected server error', e.status ?? 500);
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export interface Actor {
  user: UserRow;
  role: 'member' | 'admin';
}

export async function memberActor(): Promise<Actor | null> {
  const session = await getSession();
  if (!session) return null;
  const user = await getUserById(session.uid);
  if (!user) return null;
  return { user, role: 'member' };
}

export async function adminActor(): Promise<Actor | null> {
  const session = await getSession();
  if (!session || session.r !== 'admin') return null;
  const user = await getUserById(session.uid);
  if (!user || !user.is_admin) return null;
  return { user, role: 'admin' };
}

export async function requestMeta(): Promise<{ ip: string; userAgent: string }> {
  const h = await headers();
  const ip =
    h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || '';
  return { ip, userAgent: h.get('user-agent') || '' };
}

/** mlm_audit_log_post: best-effort action logging (never blocks the request). */
export async function audit(
  actor: Actor,
  category: string,
  action: string,
  details?: unknown,
  target?: { id?: number; username?: string },
): Promise<void> {
  try {
    const meta = await requestMeta();
    await auditLog({
      actorUserId: Number(actor.user.id),
      actorUsername: actor.user.username,
      actorRole: actor.role,
      category,
      action,
      targetUserId: target?.id ?? 0,
      targetUsername: target?.username ?? '',
      details,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  } catch {
    /* logging must never break a transaction */
  }
}

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Record<string, string | number>[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h] ?? '')).join(','));
  return lines.join('\r\n');
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toXls(headers: string[], rows: Record<string, string | number>[]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}
