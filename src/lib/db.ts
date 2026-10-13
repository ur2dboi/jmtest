import { Pool, type QueryResultRow } from 'pg';

/**
 * Single shared Postgres pool.
 *
 * Local dev   : postgres://user@localhost:5432/mjpremium
 * Vercel prod : Supabase / Neon / Vercel Postgres pooled connection string
 *               (set DATABASE_URL in the Vercel project environment).
 *
 * The session timezone is pinned to Asia/Manila on every new connection so
 * that DEFAULT now() and every timestamp round-trip in Philippine time,
 * mirroring `SET time_zone = '+08:00'` from the WordPress plugin.
 */
const globalForPg = globalThis as unknown as { __mjPool?: Pool };

function buildPool(): Pool {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@127.0.0.1:5432/mjpremium';

  const needsSsl =
    process.env.PGSSL === 'true' ||
    /sslmode=require/i.test(connectionString) ||
    /(supabase|neon|vercel-postgres|railway|render)\./i.test(connectionString);

  const pool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
    // Serverless: never let a stuck socket hang a lambda until the platform kills it.
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT || 60_000),
    // Session timezone pinned at connection startup (mirrors SET time_zone='+08:00').
    options: '-c timezone=Asia/Manila',
  });

  pool.on('error', (err) => {
    // Keep the process alive on idle-client errors; the next query reconnects.
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

export const pool: Pool = globalForPg.__mjPool ?? buildPool();
if (process.env.NODE_ENV !== 'production') globalForPg.__mjPool = pool;

export async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(sql, params as never[]);
  return res.rows as T[];
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

/** First column of the first row (or null). Mirrors $wpdb->get_var(). */
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

export async function scalar<T = unknown>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const row = await one(sql, params);
  if (!row) return null;
  const value = Object.values(row)[0];
  // node-postgres returns BIGINT (int8) and NUMERIC as strings. COUNT(*),
  // ids and sums are the overwhelming majority of scalar reads here, so
  // coerce plain numeric strings — otherwise `'0'` is truthy and breaks
  // existence checks.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && NUMERIC_STRING.test(trimmed)) return Number(trimmed) as T;
  }
  return (value as T) ?? null;
}

export async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(sql, params as never[]);
  return res.rowCount ?? 0;
}

/**
 * Run work inside a transaction. Used by the compensation engine so a single
 * activation (points -> pairs -> ledger -> wallet) is all-or-nothing.
 */
export async function tx<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(): Promise<{ ok: boolean; message: string }> {
  try {
    await q('SELECT 1');
    return { ok: true, message: 'connected' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
