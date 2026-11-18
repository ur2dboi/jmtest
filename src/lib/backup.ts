import { exec, q, tx } from './db';
import { phFormat } from './time';
import { auditLog } from './engine/accounts';

/* =====================================================================
 * FULL BACKUP / RESTORE (port of v9.6.40)
 * JSON snapshot of users, genealogy, pins, ledger, orders, packages,
 * settings and audit logs. Restore preserves user ID 1 (admin gateway)
 * so the operator can never lock themselves out.
 * ===================================================================== */

export const BACKUP_MAGIC = 'MJPREMIUM_MLM_BACKUP';

const TABLES = ['users', 'accounts', 'pins', 'ledger', 'orders', 'packages', 'audit_logs', 'settings', 'commission_review', 'pairing_review', 'commission_event_targets', 'pairing_tracking_meta', 'pairing_contributions', 'pairing_allocations'] as const;

export interface BackupFile {
  magic: string;
  backup_version: number;
  app: string;
  created_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function buildBackup(): Promise<BackupFile> {
  return tx(async () => {
    // Every table must reflect the same database snapshot.
    await exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
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
  });
}

async function insertRows(table: string, rows: Record<string, unknown>[], skipAdminUser: boolean): Promise<number> {
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid row in backup table ${table}`);
    if (skipAdminUser && Number(row.id) === 1) continue;
    const cols = Object.keys(row);
    if (!cols.length || cols.some(c => !/^[a-z_][a-z0-9_]*$/i.test(c))) throw new Error(`Invalid columns in backup table ${table}`);
    const values = cols.map(c => {
      const value = row[c];
      return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
    });
    const result = await exec(`INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map((_,i) => `$${i+1}`).join(',')})`, values);
    if (result !== 1) throw new Error(`Failed to restore a row in ${table}`);
    count++;
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

  const required = ['users','accounts','pins','ledger','orders','packages','audit_logs','settings'];
  if (required.some(t => !Array.isArray(backup.tables[t]))) {
    return { ok: false, error: 'Backup is incomplete: required tables are missing. Nothing was restored.' };
  }
  const metadata = ['commission_review','pairing_review','commission_event_targets','pairing_tracking_meta','pairing_contributions','pairing_allocations'];
  // Legacy backups may lack all provenance metadata, but partial metadata is
  // not safely restorable: it could disconnect payments from their source.
  if (metadata.some(t => t in backup.tables) && metadata.some(t => !Array.isArray(backup.tables[t]))) {
    return { ok: false, error: 'Backup has incomplete commission metadata. Nothing was restored.' };
  }
  return tx(async () => {
  // Wipe everything except the admin gateway user (ID 1) and its usermeta.
  await exec(`DELETE FROM pairing_allocations`);
  await exec(`DELETE FROM pairing_contributions`);
  await exec(`DELETE FROM pairing_tracking_meta`);
  await exec(`DELETE FROM commission_event_targets`);
  await exec(`DELETE FROM pairing_review`);
  await exec(`DELETE FROM commission_review`);
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
  stats.commission_review = await insertRows('commission_review', backup.tables.commission_review ?? [], false);
  stats.pairing_review = await insertRows('pairing_review', backup.tables.pairing_review ?? [], false);
  stats.commission_event_targets = await insertRows('commission_event_targets', backup.tables.commission_event_targets ?? [], false);
  stats.pairing_tracking_meta = await insertRows('pairing_tracking_meta', backup.tables.pairing_tracking_meta ?? [], false);
  if (!stats.pairing_tracking_meta) await exec('INSERT INTO pairing_tracking_meta(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
  stats.pairing_contributions = await insertRows('pairing_contributions', backup.tables.pairing_contributions ?? [], false);
  stats.pairing_allocations = await insertRows('pairing_allocations', backup.tables.pairing_allocations ?? [], false);

  // Keep sequences ahead of restored ids.
  for (const t of ['users','accounts','pins','ledger','orders','packages','audit_logs','commission_review','pairing_review','pairing_allocations']) {
    await exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
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
  });
}
