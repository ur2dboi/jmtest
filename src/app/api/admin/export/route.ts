import { NextResponse } from 'next/server';
import { ensureSettings } from '@/lib/settings';
import { adminActor, toCsv, toXls } from '@/lib/http';
import { buildReportRows } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1'; // run beside the Supabase (ap-southeast-1) database

/**
 * GET /api/admin/export?report=sales&format=csv&start=YYYY-MM-DD&end=YYYY-MM-DD
 * Accounting CSV / Excel downloads (port of mlm_admin_export_report_download).
 */
export async function GET(req: Request) {
  await ensureSettings();
  const actor = await adminActor();
  if (!actor) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 403 });

  const url = new URL(req.url);
  const report = (url.searchParams.get('report') || 'sales').replace(/[^a-z_]/g, '');
  const format = url.searchParams.get('format') === 'xls' ? 'xls' : 'csv';
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';

  const { headers, rows } = await buildReportRows(report, start, end);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  if (format === 'xls') {
    return new NextResponse(toXls(headers, rows), {
      headers: {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename="mjpremium-${report}-${stamp}.xls"`,
      },
    });
  }
  return new NextResponse('﻿' + toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mjpremium-${report}-${stamp}.csv"`,
    },
  });
}
