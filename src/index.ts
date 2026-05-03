/**
 * Main entry point. Starts the polling loop and discovery loop.
 *
 * Loops are scheduled rather than nested so a slow API call doesn't stall
 * the whole pipeline. Each cycle is wrapped in try/catch so transient
 * errors never crash the process.
 */
import { getConfig } from './config/loader.js';
import { db, closeDb } from './db/schema.js';
import { runDiscovery, runPoll } from './scanner/poll.js';
import { isTelegramConfigured } from './alerts/telegram.js';
import { log } from './util/logger.js';

let _stopRequested = false;

async function tickPoll(): Promise<void> {
  try {
    await runPoll();
  } catch (e) {
    log.error('runPoll crashed (caught)', { err: (e as Error).message });
  }
}

async function tickDiscovery(): Promise<void> {
  try {
    await runDiscovery();
  } catch (e) {
    log.error('runDiscovery crashed (caught)', { err: (e as Error).message });
  }
}

function shutdown(reason: string): void {
  log.info(`Shutting down: ${reason}`);
  _stopRequested = true;
  closeDb();
  process.exit(0);
}

async function main(): Promise<void> {
  const cfg = getConfig();
  log.info('cabal-trending starting', {
    chain: cfg.chainId,
    pollSeconds: cfg.pollIntervalSeconds,
    discoveryMinutes: cfg.discovery.discoveryIntervalMinutes,
    telegramConfigured: isTelegramConfigured(),
  });

  // Touch DB to ensure schema is initialized.
  db();

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Run discovery once immediately so we have something to poll.
  await tickDiscovery();
  await tickPoll();

  const pollMs = cfg.pollIntervalSeconds * 1_000;
  while (!_stopRequested) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (_stopRequested) break;
    await tickDiscovery();
    await tickPoll();
  }
}

main().catch((e) => {
  log.error('fatal in main()', { err: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
