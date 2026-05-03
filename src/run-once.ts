/**
 * Single-shot scanner. Runs discovery + ONE poll cycle, then exits.
 * Designed to be triggered by cron-job.org -> GitHub Actions instead of
 * being a long-running process.
 *
 * Each cron run adds one snapshot per tracked pair to the rolling window
 * stored in SQLite. After 4-5 runs the rolling baseline has enough data
 * for the volume-acceleration math to produce meaningful alerts.
 */
import { getConfig } from './config/loader.js';
import { db, closeDb } from './db/schema.js';
import { runDiscovery, runPoll } from './scanner/poll.js';
import { isTelegramConfigured } from './alerts/telegram.js';
import { log } from './util/logger.js';

async function main(): Promise<void> {
  const cfg = getConfig();
  log.info('cabal-trending single-run starting', {
    chain: cfg.chainId,
    telegramConfigured: isTelegramConfigured(),
  });

  db();

  try {
    await runDiscovery();
  } catch (e) {
    log.error('runDiscovery failed (continuing to poll)', { err: (e as Error).message });
  }

  try {
    await runPoll();
  } catch (e) {
    log.error('runPoll failed', { err: (e as Error).message });
  }

  closeDb();
  log.info('cabal-trending single-run finished');
}

main().catch((e) => {
  log.error('fatal in run-once', { err: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
