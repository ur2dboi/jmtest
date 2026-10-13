#!/usr/bin/env node
/**
 * Applies sql/schema.sql to DATABASE_URL.
 * Idempotent — safe to run on every deploy.
 *
 *   node scripts/db-push.mjs            # apply schema
 *   node scripts/db-push.mjs --fresh    # drop MLM tables first (DESTROYS DATA)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/mjpremium';

const fresh = process.argv.includes('--fresh');

const connectionString = DATABASE_URL;
const needsSsl =
  process.env.PGSSL === 'true' ||
  /sslmode=require/i.test(connectionString) ||
  /(supabase|neon|vercel-postgres|railway|render)\./i.test(connectionString);

const client = new pg.Client({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
  await client.query(`SET TIME ZONE 'Asia/Manila'`);

  if (fresh) {
    console.log('⚠️  --fresh: dropping MLM tables…');
    await client.query(`
      DROP TABLE IF EXISTS rebuild_state, audit_logs, orders, ledger, pins,
        packages, accounts, settings, users CASCADE;
    `);
  }

  const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
  await client.query(schema);
  console.log('✅ Schema applied to', connectionString.replace(/:[^:@/]+@/, ':****@'));

  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('users','accounts','pins','ledger','orders','packages','audit_logs','settings','rebuild_state')
    ORDER BY table_name;
  `);
  console.log('Tables:', rows.map((r) => r.table_name).join(', '));
} catch (err) {
  console.error('❌ db-push failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
