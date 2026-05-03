/**
 * Polling cycle: discover -> filter -> snapshot -> score -> alert.
 *
 * Two passes per cycle:
 *   1. DISCOVERY (every discoveryIntervalMinutes)
 *      Hit /latest/dex/search for each seed query, filter Solana pairs,
 *      upsert into the pairs table.
 *   2. POLL  (every pollIntervalSeconds)
 *      For each tracked pair, fetch fresh state, write snapshot, score,
 *      classify tier, dedup, send Telegram if firing.
 */
import { dex, type DexScreenerPair } from '../dexscreener/client.js';
import { passesBaseFilter } from './filter.js';
import {
  upsertPair,
  insertSnapshot,
  recentSnapshots,
  allTrackedPairs,
  insertAlert,
} from '../db/snapshots.js';
import { scoreAnomaly } from '../scoring/engine.js';
import { classifyTier } from '../scoring/tiers.js';
import { shouldFire } from '../alerts/dedup.js';
import { formatAlert } from '../alerts/formatter.js';
import { sendTelegramMessage, isTelegramConfigured } from '../alerts/telegram.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/logger.js';

// How far back to look when computing the rolling baseline for volume / txns.
// 20-minute window gives us 4 prior 5-min buckets at our 20s poll rate.
const SCORING_LOOKBACK_MS = 20 * 60 * 1000;

let _lastDiscoveryAt = 0;

export async function runDiscovery(): Promise<void> {
  const cfg = getConfig();
  const since = Date.now() - _lastDiscoveryAt;
  if (since < cfg.discovery.discoveryIntervalMinutes * 60_000) return;
  _lastDiscoveryAt = Date.now();

  log.info('Discovery cycle starting', { seeds: cfg.discovery.seedQueries.length });
  let surfaced = 0;

  // ---- Source 1: trending boosted tokens (memecoin-native, much better hit rate) ----
  try {
    const boosted = [
      ...(await dex().boostedTokensLatest()),
      ...(await dex().boostedTokensTop()),
    ].filter((t) => t.chainId === 'solana');
    const uniqAddrs = Array.from(new Set(boosted.map((t) => t.tokenAddress)));
    log.info(`boosted Solana tokens: ${uniqAddrs.length}`);
    for (const tokenAddress of uniqAddrs) {
      let pairs: DexScreenerPair[] = [];
      try {
        pairs = await dex().tokenPairs('solana', tokenAddress);
      } catch (e) {
        log.debug(`tokenPairs(${tokenAddress}) failed`, { err: (e as Error).message });
        continue;
      }
      for (const p of pairs) {
        if (p.chainId !== 'solana') continue;
        if (!passesBaseFilter(p)) continue;
        upsertPair(p);
        surfaced++;
      }
    }
  } catch (e) {
    log.warn('boosted tokens fetch failed', { err: (e as Error).message });
  }

  // ---- Source 2: classic seed-query search (kept as a fallback) ----
  for (const q of cfg.discovery.seedQueries) {
    let pairs: DexScreenerPair[] = [];
    try {
      pairs = await dex().search(q);
    } catch (e) {
      log.warn(`search(${q}) failed`, { err: (e as Error).message });
      continue;
    }
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue;
      if (!passesBaseFilter(p)) continue;
      upsertPair(p);
      surfaced++;
    }
  }

  // Also pull explicit watchlist pairs (always tracked, regardless of filter).
  for (const pairAddress of cfg.watchlist.pairs) {
    try {
      const p = await dex().pair('solana', pairAddress);
      if (p) {
        upsertPair(p);
        surfaced++;
      }
    } catch (e) {
      log.warn(`watchlist pair ${pairAddress} failed`, { err: (e as Error).message });
    }
  }

  log.info('Discovery cycle done', { surfaced });
}

export async function runPoll(): Promise<void> {
  const tracked = allTrackedPairs('solana');
  if (tracked.length === 0) {
    log.debug('No tracked pairs yet — discovery hasn\'t surfaced any candidates');
    return;
  }
  log.debug(`Polling ${tracked.length} pairs`);

  let alertsFired = 0;
  for (const pairAddress of tracked) {
    let p: DexScreenerPair | null = null;
    try {
      p = await dex().pair('solana', pairAddress);
    } catch (e) {
      log.debug(`pair fetch failed for ${pairAddress}`, { err: (e as Error).message });
      continue;
    }
    if (!p) continue;

    // Re-filter — pair might have moved out of MC/liq bounds since discovery.
    // We still snapshot it (so we can backtest), but we won't alert on it.
    const inRange = passesBaseFilter(p);

    const snapshotId = insertSnapshot(p);

    if (!inRange) continue;

    const recent = recentSnapshots(pairAddress, SCORING_LOOKBACK_MS);
    if (recent.length < 2) {
      // Need at least one prior snapshot to compute baseline.
      continue;
    }
    const score = scoreAnomaly(recent);
    const priceChangeM5Abs = Math.abs(p.priceChange?.m5 ?? 0);
    const tier = classifyTier(score, priceChangeM5Abs);
    if (!tier) continue;
    if (!shouldFire(pairAddress, tier)) continue;

    const formatted = formatAlert({ tier, pair: p, score });
    let sent = false;
    if (isTelegramConfigured()) {
      sent = await sendTelegramMessage(formatted);
    }
    insertAlert({
      pairAddress,
      tier,
      score: score.overall,
      volumeAcceleration: score.volumeAcceleration,
      priceChangeM5: p.priceChange?.m5 ?? null,
      marketCap: p.marketCap ?? p.fdv ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      buyRatio: score.buyRatio,
      snapshotId,
      payload: { pair: p, score, formatted: formatted.text },
      sent,
    });
    alertsFired++;
    log.info(`Alert fired ${tier} for ${p.baseToken.symbol ?? pairAddress}`, {
      score: score.overall,
      volAccel: score.volumeAcceleration,
      sent,
    });
  }

  if (alertsFired > 0) log.info(`Poll cycle done — ${alertsFired} alert(s) fired`);
}
