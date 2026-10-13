import { jwtVerify } from 'jose';

/**
 * Edge-safe session token verification (no DB / next/headers imports),
 * so middleware can use it. Keep AUTH_SECRET in sync with auth.ts.
 */
export type SessionRole = 'member' | 'admin';
export interface SessionPayload {
  uid: number;
  u: string;
  r: SessionRole;
}

const secret = () =>
  new TextEncoder().encode(
    process.env.AUTH_SECRET || 'mjpremium-dev-secret-change-me-in-production-32b',
  );

export async function readSessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: 'mjpremium-mlm' });
    if (typeof payload.uid !== 'number' || typeof payload.u !== 'string') return null;
    return { uid: payload.uid, u: payload.u, r: (payload.r as SessionRole) || 'member' };
  } catch {
    return null;
  }
}
