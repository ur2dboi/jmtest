import { NextResponse } from 'next/server';
import { ensureSettings } from '@/lib/settings';
import { adminActor, audit } from '@/lib/http';
import { buildBackup } from '@/lib/backup';
import { phFormat } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

/** GET /api/admin/backup — full JSON backup download. */
export async function GET() {
  await ensureSettings();
  const actor = await adminActor();
  if (!actor) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 403 });

  const backup = await buildBackup();
  await audit(actor, 'backup', 'DOWNLOAD FULL BACKUP');
  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="mjpremium-backup-${phFormat(new Date(), 'Ymd-His')}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
