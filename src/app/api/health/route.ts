import { ping } from '@/lib/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

export async function GET() {
  const db = await ping();
  return NextResponse.json(
    { ok: db.ok, app: 'mjpremium-mlm', db: db.message, time: new Date().toISOString() },
    { status: db.ok ? 200 : 503 },
  );
}
