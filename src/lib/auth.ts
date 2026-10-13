import { cookies } from 'next/headers';
import { SignJWT } from 'jose';
import { readSessionToken, type SessionPayload, type SessionRole } from './session-token';
export { readSessionToken };
export type { SessionPayload, SessionRole };
import bcrypt from 'bcryptjs';
import { one } from './db';
import type { ActiveNode, UserRow } from './types';

/**
 * Auth port of the plugin's traffic controller:
 *  - member login   -> wp_signon + redirect to /member-portal/
 *  - C1/C2/C3 alias -> logs into the matching Child Account node
 *  - admin gateway  -> HMAC-signed cookie (SEC-1) -> /admin-dashboard/
 *
 * Here the signed cookie is a `jose` JWT in an httpOnly cookie, and passwords
 * are bcrypt hashes in the users table (no more hard-coded gateway literal).
 */
export const SESSION_COOKIE = 'mj_session';
export const NODE_COOKIE = 'mj_node';

const secret = () =>
  new TextEncoder().encode(
    process.env.AUTH_SECRET || 'mjpremium-dev-secret-change-me-in-production-32b',
  );

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** mlm_valid_alnum_password(): >= 6 chars, letters/numbers only. */
export function validAlnumPassword(password: unknown): boolean {
  return typeof password === 'string' && /^[A-Za-z0-9]{6,}$/.test(password);
}

export function passwordPolicyMessage(): string {
  return 'Password must be at least 6 characters and contain letters/numbers only (alphanumeric, no spaces or symbols).';
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('mjpremium-mlm')
    .setExpirationTime('12h')
    .sign(secret());
}


export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return readSessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const store = await cookies();
  const token = await createSessionToken(payload);
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(NODE_COOKIE);
}

/** Which dashboard node is active (MA / C_L / C_C / C_R). */
export async function getActiveNode(): Promise<ActiveNode> {
  const store = await cookies();
  const v = (store.get(NODE_COOKIE)?.value || 'MA') as ActiveNode;
  return ['MA', 'C_L', 'C_C', 'C_R'].includes(v) ? v : 'MA';
}

export async function setActiveNode(node: ActiveNode): Promise<void> {
  const store = await cookies();
  store.set(NODE_COOKIE, node, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function getUserById(id: number): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE username = $1', [username]);
}

export async function getCurrentUser(): Promise<UserRow | null> {
  const session = await getSession();
  if (!session) return null;
  return getUserById(session.uid);
}

/** Throws a 401-style error when nobody is signed in. */
export async function requireUser(): Promise<{ user: UserRow; session: SessionPayload }> {
  const session = await getSession();
  if (!session) throw apiError('Not authenticated', 401);
  const user = await getUserById(session.uid);
  if (!user) throw apiError('Account not found', 401);
  return { user, session };
}

export async function requireAdmin(): Promise<{ user: UserRow; session: SessionPayload }> {
  const { user, session } = await requireUser();
  if (!user.is_admin) throw apiError('Admin gateway access required', 403);
  return { user, session };
}

export function apiError(message: string, status = 400): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Login input parser (port of mlm_process_system_forms):
 * "C1username" logs straight into that member's Left Child Account node.
 */
export function parseLoginAlias(input: string): { login: string; node: ActiveNode } {
  const trimmed = (input || '').trim();
  const match = /^(C[123])(.+)$/i.exec(trimmed);
  if (match) {
    const prefix = match[1].toUpperCase();
    const node: ActiveNode = prefix === 'C1' ? 'C_L' : prefix === 'C2' ? 'C_C' : 'C_R';
    return { login: match[2], node };
  }
  return { login: trimmed, node: 'MA' };
}
