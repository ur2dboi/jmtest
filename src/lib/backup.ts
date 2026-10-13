import { exec, q } from './db';
import { phFormat } from './time';
import { auditLog } from './engine/accounts';

/* =====================================================================
 * FULL BACKUP / RESTORE (port of v9.6.40)
 * JSON snapshot of users, genealogy, pins, ledger, orders, packages,
 * settings and audit logs. Restore preserves user ID 1 (admin gateway)
 * so the operator can never lock themselves out.
 * ===================================================================== */

export const BACKUP_MAGIC = 'MJPREMIUM_MLM_BACKUP';

const TABLES = ['users', 'accounts', 'pins', 'ledger', 'orders', 'packages', 'audit_logs', 'settings'] as const;

export interface BackupFile {
  magic: string;
  backup_version: number;
  app: string;
  created_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function buildBackup(): Promise<BackupFile> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) {
    const where = t === 'settings' ? `WHERE key LIKE 'mlm_%'` : '';
    tables[t] = await q<Record<string, unknown>>(`SELECT * FROM ${t} ${where}`);
  }
  return {
    magic: BACKUP_MAGIC,
    backup_version: 1,
    app: 'mjpremium-mlm (next)',
    created_at: phFormat(new Date(), 'Y-m-d H:i:s'),
    tables,
  };
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function insertRows(table: string, rows: Record<string, unknown>[], skipAdminUser: boolean): Promise<number> {
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (skipAdminUser && Number(row.id) === 1) continue;
    if (skipAdminUser && Number(row.user_id) === 1) continue;
    const cols = Object.keys(row).filter((c) => /^[a-z_][a-z0-9_]*$/i.test(c));
    if (!cols.length) continue;
    const sql = `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')})
                 VALUES (${cols.map((c) => sqlValue(row[c])).join(',')})
                 ON CONFLICT DO NOTHING`;
    try {
      await exec(sql);
      count++;
    } catch {
      // Skip rows that violate newer constraints; restore is best-effort per row.
    }
  }
  return count;
}

export async function restoreBackup(
  data: unknown,
  actor: { id: number; username: string },
): Promise<{ ok: boolean; error?: string; stats?: Record<string, number> }> {
  const backup = data as BackupFile;
  if (!backup || backup.magic !== BACKUP_MAGIC || !backup.tables) {
    return { ok: false, error: 'Invalid backup file. Please upload an MJPremium backup JSON file.' };
  }

  // Wipe everything except the admin gateway user (ID 1) and its usermeta.
  await exec(`DELETE FROM accounts`);
  await exec(`DELETE FROM pins`);
  await exec(`DELETE FROM ledger`);
  await exec(`DELETE FROM orders`);
  await exec(`DELETE FROM packages`);
  await exec(`DELETE FROM audit_logs`);
  await exec(`DELETE FROM settings WHERE key LIKE 'mlm_%'`);
  await exec(`DELETE FROM users WHERE id <> 1`);

  const stats: Record<string, number> = {};
  stats.users = await insertRows('users', backup.tables.users ?? [], true);
  // Preserve the live admin credentials over whatever the backup holds.
  stats.packages = await insertRows('packages', backup.tables.packages ?? [], false);
  stats.accounts = await insertRows('accounts', backup.tables.accounts ?? [], false);
  stats.pins = await insertRows('pins', backup.tables.pins ?? [], false);
  stats.ledger = await insertRows('ledger', backup.tables.ledger ?? [], false);
  stats.orders = await insertRows('orders', backup.tables.orders ?? [], false);
  stats.settings = await insertRows('settings', backup.tables.settings ?? [], false);
  stats.audit_logs = await insertRows('audit_logs', backup.tables.audit_logs ?? [], false);

  // Keep sequences ahead of restored ids.
  for (const t of TABLES) {
    await exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`).catch(() => {});
  }

  await auditLog({
    actorUserId: actor.id,
    actorUsername: actor.username,
    actorRole: 'admin',
    category: 'backup',
    action: 'RESTORE BACKUP',
    details: stats,
  });
  return { ok: true, stats };
}
