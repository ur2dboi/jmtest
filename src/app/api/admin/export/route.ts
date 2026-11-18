import { NextResponse } from 'next/server';
import { ensureSettings } from '@/lib/settings';
import { q } from '@/lib/db';
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

  if (report === 'commission_review' || report === 'pairing_review') {
    const headers = report === 'commission_review'
      ? ['review_id','pin_id','beneficiary_id','beneficiary','buyer','code','used_at','reason']
      : ['review_id','account_id','username','noted_at','reason'];
    const raw = report === 'commission_review'
      ? await q<Record<string,string | number>>(`SELECT r.id AS review_id,r.pin_id,r.beneficiary_id,
          COALESCE(b.username,'[deleted]') AS beneficiary,COALESCE(u.username,'[deleted]') AS buyer,
          COALESCE(p.pin_code,'[deleted]') AS code,COALESCE(p.used_at::text,'') AS used_at,r.reason
          FROM commission_review r LEFT JOIN users b ON b.id=r.beneficiary_id
          LEFT JOIN pins p ON p.id=r.pin_id LEFT JOIN users u ON u.id=COALESCE(p.used_by,p.purchaser_id) ORDER BY r.id`)
      : await q<Record<string,string | number>>(`SELECT r.id AS review_id,r.account_id,
          COALESCE(u.username,'[deleted]') AS username,r.noted_at::text,r.reason
          FROM pairing_review r LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN users u ON u.id=a.user_id ORDER BY r.id`);
    // Spreadsheet formula protection for free-text fields in downloadable reviews.
    const rows = raw.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,
      typeof value === 'string' && /^[=+@-]/.test(value) ? `'${value}` : value])));
    return new NextResponse('\ufeff'+toCsv(headers,rows), {headers:{
      'Content-Type':'text/csv; charset=utf-8',
      'Content-Disposition':`attachment; filename="mjpremium-${report}.csv"`,
      'Cache-Control':'no-store',
    }});
  }
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
