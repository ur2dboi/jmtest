import { one } from '@/lib/db';
import { ensureSettings } from '@/lib/settings';
import {
  parseLoginAlias,
  setActiveNode,
  setSessionCookie,
  verifyPassword,
} from '@/lib/auth';
import { audit, body, err, fail, ok } from '@/lib/http';
import type { UserRow } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

/**
 * POST /api/auth/login  { username, password, mode?: 'member' | 'admin' }
 *
 * Member login accepts the C1/C2/C3 alias prefix (lands on that Child
 * Account node). Admin gateway requires an is_admin user and issues an
 * admin-role session (port of the HMAC gateway cookie, SEC-1).
 */
export async function POST(req: Request) {
  try {
    await ensureSettings();
    const { username = '', password = '', mode = 'member' } = await body<{
      username: string;
      password: string;
      mode?: string;
    }>(req);
    if (!username || !password) return fail('Username and password are required.');

    if (mode === 'admin') {
      const user = await one<UserRow>('SELECT * FROM users WHERE username = $1', [String(username).trim()]);
      if (!user || !user.is_admin || !(await verifyPassword(password, user.password_hash))) {
        return fail('Invalid Admin Credentials.', 401);
      }
      await setSessionCookie({ uid: Number(user.id), u: user.username, r: 'admin' });
      await audit({ user, role: 'admin' }, 'auth', 'ADMIN GATEWAY LOGIN');
      return ok({ redirect: '/admin-dashboard', username: user.username });
    }

    const { login, node } = parseLoginAlias(String(username));
    let user = await one<UserRow>('SELECT * FROM users WHERE username = $1', [login]);
    if (!user && /.+@.+\..+/.test(login)) {
      user = await one<UserRow>('SELECT * FROM users WHERE email = $1', [login]);
    }
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return fail('Invalid Credentials.', 401);
    }
    await setSessionCookie({ uid: Number(user.id), u: user.username, r: 'member' });
    await setActiveNode(node);
    await audit({ user, role: 'member' }, 'auth', `MEMBER LOGIN (${node})`);
    return ok({ redirect: '/member-portal', username: user.username, node });
  } catch (e) {
    return err(e);
  }
}
