/**
 * Prune the SQLite database to keep it well under GitHub's 100 MB push limit.
 *
 * Defaults (override with env vars):
 *   PRUNE_SNAPSHOTS_HOURS=24   keep last 24 hours of snapshots
 *                              (money-flow lookback is 4h, big safety margin)
 *   PRUNE_ALERTS_DAYS=7        keep last 7 days of alerts
 *                              (cooldown is 6h, plenty of telemetry buffer)
 *   PRUNE_PAIRS_DAYS=30        drop pairs we haven't seen in 30 days
 *
 * Run via:  tsx tools/prune-db.ts
 * Wired into the GitHub Actions workflow before the auto-commit step.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, closeDb } from '../src/db/schema.js';
import { PROJECT_ROOT, getConfig } from '../src/config/loader.js';
import { log } from '../src/util/logger.js';

const SNAPSHOT_HOURS = Number(process.env.PRUNE_SNAPSHOTS_HOURS ?? 24);
const ALERT_DAYS     = Number(process.env.PRUNE_ALERTS_DAYS    ?? 7);
const PAIRS_DAYS     = Number(process.env.PRUNE_PAIRS_DAYS     ?? 30);

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function dbSizeBytes(): number {
  const cfg = getConfig();
  const path = resolve(PROJECT_ROOT, cfg.dbPath);
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function main(): void {
  const beforeBytes = dbSizeBytes();
  log.info('prune-db starting', {
    sizeBefore: fmtMb(beforeBytes),
    snapshotHours: SNAPSHOT_HOURS,
    alertDays: ALERT_DAYS,
    pairsDays: PAIRS_DAYS,
  });

  const conn = db();

  const snapCutoff   = Date.now() - SNAPSHOT_HOURS * 60 * 60 * 1000;
  const alertCutoff  = Date.now() - ALERT_DAYS * 24 * 60 * 60 * 1000;
  const pairsCutoff  = Date.now() - PAIRS_DAYS * 24 * 60 * 60 * 1000;

  // Order matters because of FK constraints (alerts reference snapshots).
  // 1. Wipe stale alerts first (they reference snapshots).
  const alertsBefore = (conn.prepare('SELECT COUNT(*) AS c FROM alerts').get() as { c: number }).c;
  const delAlerts = conn.prepare('DELETE FROM alerts WHERE timestamp < ?').run(alertCutoff).changes;

  // 2. Wipe stale snapshots.
  const snapsBefore = (conn.prepare('SELECT COUNT(*) AS c FROM snapshots').get() as { c: number }).c;
  const delSnaps = conn.prepare('DELETE FROM snapshots WHERE timestamp < ?').run(snapCutoff).changes;

  // 3. Drop pairs we haven't seen in a long time (CASCADE removes any leftover snapshots/alerts).
  const pairsBefore = (conn.prepare('SELECT COUNT(*) AS c FROM pairs').get() as { c: number }).c;
  const delPairs = conn.prepare('DELETE FROM pairs WHERE last_seen < ?').run(pairsCutoff).changes;

  // 4. VACUUM to actually shrink the file (SQLite delete doesn't reclaim space).
  // Need to checkpoint the WAL first or VACUUM may include the WAL contents.
  conn.pragma('wal_checkpoint(TRUNCATE)');
  conn.exec('VACUUM');

  closeDb();

  const afterBytes = dbSizeBytes();
  log.info('prune-db done', {
    sizeBefore: fmtMb(beforeBytes),
    sizeAfter:  fmtMb(afterBytes),
    saved:      fmtMb(beforeBytes - afterBytes),
    deletedAlerts:    `${delAlerts}/${alertsBefore}`,
    deletedSnapshots: `${delSnaps}/${snapsBefore}`,
    deletedPairs:     `${delPairs}/${pairsBefore}`,
  });
}

try {
  main();
} catch (e) {
  log.error('prune-db failed', { err: (e as Error).message });
  process.exit(1);
}
