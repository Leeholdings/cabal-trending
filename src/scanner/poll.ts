import { dex, type DexScreenerPair } from '../dexscreener/client.js';
import { passesBaseFilter } from './filter.js';
import { upsertPair, insertSnapshot, recentSnapshotsHours, allTrackedPairs, insertAlert } from '../db/snapshots.js';
import { detectRunner } from '../scoring/runner.js';
import { shouldFireRunner } from '../alerts/dedup.js';
import { formatRunnerAlert } from '../alerts/formatter.js';
import { sendTelegramMessage, isTelegramConfigured } from '../alerts/telegram.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/logger.js';

let _lastDiscoveryAt = 0;

export async function runDiscovery(): Promise<void> {
  const cfg = getConfig();
  if (Date.now() - _lastDiscoveryAt < cfg.discovery.discoveryIntervalMinutes * 60_000) return;
  _lastDiscoveryAt = Date.now();

  log.info('Discovery cycle starting', { seeds: cfg.discovery.seedQueries.length });
  let surfaced = 0;

  try {
    const boosted = [
      ...(await dex().boostedTokensLatest()),
      ...(await dex().boostedTokensTop()),
    ].filter((t) => t.chainId === 'solana');
    const uniqAddrs = Array.from(new Set(boosted.map((t) => t.tokenAddress)));
    log.info('boosted Solana tokens: ' + uniqAddrs.length);
    for (const tokenAddress of uniqAddrs) {
      let pairs: DexScreenerPair[] = [];
      try { pairs = await dex().tokenPairs('solana', tokenAddress); }
      catch (e) { log.debug('tokenPairs failed', { err: (e as Error).message }); continue; }
      for (const p of pairs) {
        if (p.chainId !== 'solana') continue;
        if (!passesBaseFilter(p)) continue;
        upsertPair(p); surfaced++;
      }
    }
  } catch (e) { log.warn('boosted tokens fetch failed', { err: (e as Error).message }); }

  for (const q of cfg.discovery.seedQueries) {
    let pairs: DexScreenerPair[] = [];
    try { pairs = await dex().search(q); }
    catch (e) { log.warn('search failed', { q, err: (e as Error).message }); continue; }
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue;
      if (!passesBaseFilter(p)) continue;
      upsertPair(p); surfaced++;
    }
  }

  for (const pairAddress of cfg.watchlist.pairs) {
    try {
      const p = await dex().pair('solana', pairAddress);
      if (p) { upsertPair(p); surfaced++; }
    } catch (e) { log.warn('watchlist pair failed', { pairAddress, err: (e as Error).message }); }
  }

  log.info('Discovery cycle done', { surfaced });
}

export async function runPoll(): Promise<void> {
  const tracked = allTrackedPairs('solana');
  if (tracked.length === 0) { log.debug('No tracked pairs yet'); return; }
  log.debug('Polling ' + tracked.length + ' pairs');

  const cfg = getConfig().strategy;
  const runnerCfg = cfg.runner;
  const runnerEnabled = runnerCfg?.enabled === true;

  const polled: Array<{ pair: DexScreenerPair; snapshotId: number }> = [];
  let alertsFired = 0;

  // Pass 1: poll + snapshot every tracked pair
  for (const pairAddress of tracked) {
    let p: DexScreenerPair | null = null;
    try { p = await dex().pair('solana', pairAddress); }
    catch (e) { log.debug('pair fetch failed', { pairAddress, err: (e as Error).message }); continue; }
    if (!p) continue;
    if (!passesBaseFilter(p)) { insertSnapshot(p); continue; }
    const snapshotId = insertSnapshot(p);
    polled.push({ pair: p, snapshotId });
  }

  // Pass 2: RUNNER detector
  if (runnerEnabled && runnerCfg) {
    const lookbackHours = runnerCfg.lookbackHours ?? 6;
    log.debug('Runner pass over ' + polled.length + ' polled pairs');

    for (const { pair, snapshotId } of polled) {
      const history = recentSnapshotsHours(pair.pairAddress, lookbackHours);
      const signal = detectRunner(history, pair);
      if (!signal) continue;

      const decision = shouldFireRunner(pair.pairAddress);
      const symbol = pair.baseToken?.symbol ?? pair.pairAddress;
      if (!decision.fire) {
        log.debug('RUNNER SKIP ' + symbol + ': ' + decision.reason);
        continue;
      }

      const formatted = formatRunnerAlert({ pair, signal });
      let sent = false;
      if (isTelegramConfigured()) sent = await sendTelegramMessage(formatted);

      insertAlert({
        pairAddress: pair.pairAddress, tier: 'RUNNER',
        score: Math.round(signal.turnoverPct),
        volumeAcceleration: signal.h6AccelerationRatio,
        priceChangeM5: pair.priceChange?.m5 ?? null,
        marketCap: signal.marketCap,
        liquidityUsd: signal.liquidityUsd,
        buyRatio: signal.h24BuyRatio,
        snapshotId,
        payload: { pair, signal, formatted: formatted.text, reason: decision.reason },
        sent,
      });
      if (sent) {
        alertsFired++;
        log.info('🚀 RUNNER ' + symbol, {
          age: signal.ageDays.toFixed(1) + 'd',
          cap: '$' + (signal.marketCap / 1e6).toFixed(2) + 'M',
          turnover: signal.turnoverPct.toFixed(0) + '%',
          accel: signal.h6AccelerationRatio.toFixed(2) + 'x',
        });
      }
    }
  }

  if (alertsFired > 0) log.info('Poll cycle done - ' + alertsFired + ' alert(s) fired');
}
