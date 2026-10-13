import { clearSession } from '@/lib/auth';
import { ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await clearSession();
  return ok({ redirect: '/member-login' });
}

export async function GET() {
  await clearSession();
  return ok({ redirect: '/member-login' });
}
