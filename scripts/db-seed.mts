#!/usr/bin/env tsx
/**
 * Seeds packages, the admin gateway and (optionally) a demo network that is
 * built by running the real compensation engine.
 *
 *   npm run db:seed                # seed (skips members that already exist)
 *   npm run db:seed -- --fresh     # TRUNCATE first, then seed
 *   npm run db:seed -- --no-demo   # packages + admin only
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Load .env.local / .env BEFORE importing the db module (it reads env at load time).
for (const file of ['.env.local', '.env']) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const fresh = process.argv.includes('--fresh');
const noDemo = process.argv.includes('--no-demo');

const { exec } = await import('../src/lib/db');
const { seedDatabase } = await import('../src/lib/seed');

if (fresh) {
  console.log('⚠️  --fresh: truncating MLM data…');
  await exec(`TRUNCATE TABLE ledger, orders, pins, accounts, audit_logs, users, packages RESTART IDENTITY CASCADE`);
  await exec(`UPDATE rebuild_state SET step=0, row_offset=0, total=0, status='idle', message='' WHERE id=1`);
}

const demo = !noDemo && process.env.SEED_DEMO_NETWORK !== '0';
const result = await seedDatabase({
  adminUsername: process.env.ADMIN_USERNAME || 'MJPREMIUM',
  adminPassword: process.env.ADMIN_PASSWORD || 'adminMJ2026',
  demoNetwork: demo,
});

console.log(result.ok ? '✅ Seed complete.' : '❌ Seed failed.');
process.exit(result.ok ? 0 : 1);
