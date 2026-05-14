import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, closeDb } from '../src/db/schema.js';
import { PROJECT_ROOT, getConfig } from '../src/config/loader.js';
import { log } from '../src/util/logger.js';

const SNAPSHOT_HOURS = Number(process.env.PRUNE_SNAPSHOTS_HOURS ?? 8);
const ALERT_DAYS     = Number(process.env.PRUNE_ALERTS_DAYS    ?? 7);
const PAIRS_DAYS     = Number(process.env.PRUNE_PAIRS_DAYS     ?? 14);

function fmtMb(b: number): string { return (b/1024/1024).toFixed(2) + ' MB'; }
function dbSize(): number { try { return statSync(resolve(PROJECT_ROOT, getConfig().dbPath)).size; } catch { return 0; } }

function main(): void {
  const before = dbSize();
  log.info('prune-db starting', { sizeBefore: fmtMb(before), snapshotHours: SNAPSHOT_HOURS, alertDays: ALERT_DAYS, pairsDays: PAIRS_DAYS });
  const conn = db();
  const snapCutoff   = Date.now() - SNAPSHOT_HOURS * 3600_000;
  const alertCutoff  = Date.now() - ALERT_DAYS * 86400_000;
  const pairsCutoff  = Date.now() - PAIRS_DAYS * 86400_000;
  // NB: previously wiped raw_json to '' on every run as a size-control
  // measure when raw_json held the full DexScreener payload. Removed —
  // raw_json is now ~500 bytes of slim JSON that downstream consumers
  // (smart-wallet-lab CHoCH detector) need to read out of the committed DB.
  // Size math: 200 pairs × 32 snapshots × 500 bytes ≈ 3.2 MB, well under
  // GitHub's 100 MB push limit.
  const delAlerts = conn.prepare('DELETE FROM alerts WHERE timestamp < ?').run(alertCutoff).changes;
  const delSnaps  = conn.prepare('DELETE FROM snapshots WHERE timestamp < ?').run(snapCutoff).changes;
  const delPairs  = conn.prepare('DELETE FROM pairs WHERE last_seen < ?').run(pairsCutoff).changes;
  conn.pragma('wal_checkpoint(TRUNCATE)');
  conn.exec('VACUUM');
  closeDb();
  const after = dbSize();
  log.info('prune-db done', { sizeBefore: fmtMb(before), sizeAfter: fmtMb(after), delAlerts, delSnaps, delPairs });
}

try { main(); } catch (e) { log.error('prune-db failed', { err: (e as Error).message }); process.exit(1); }
