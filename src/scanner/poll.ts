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
 *
 * Two scoring layers run inside the POLL pass:
 *   a) LEGACY TIERED (WATCH / TRADE_RADAR / CAUTION) — kept for telemetry
 *      and only sent to Telegram when strategy.tieredAlertsEnabled === true.
 *   b) MONEY_FLOW_ANOMALY radar — adaptive 0-100 score per pair plus a
 *      cross-pair ranking boost. Fires the 🔥 alert when overall >= minScore
 *      and dedup/escalation rules pass. Active when
 *      strategy.moneyFlowAnomaly.enabled === true.
 */
import { dex, type DexScreenerPair } from '../dexscreener/client.js';
import { passesBaseFilter } from './filter.js';
import {
  upsertPair,
  insertSnapshot,
  recentSnapshots,
  recentSnapshotsHours,
  allTrackedPairs,
  insertAlert,
} from '../db/snapshots.js';
import { scoreAnomaly } from '../scoring/engine.js';
import { classifyTier } from '../scoring/tiers.js';
import { scoreMoneyFlow, applyRankBoost, type MoneyFlowScore } from '../scoring/money_flow.js';
import { shouldFire, shouldFireMoneyFlow } from '../alerts/dedup.js';
import { formatAlert, formatMoneyFlowAlert } from '../alerts/formatter.js';
import { sendTelegramMessage, isTelegramConfigured } from '../alerts/telegram.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/logger.js';

// How far back to look when computing the rolling baseline for legacy
// volume / txns. 20-minute window gives us 4 prior 5-min buckets at our
// 20s poll rate.
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

  const cfg = getConfig().strategy;
  const tieredEnabled = cfg.tieredAlertsEnabled !== false;  // default true (legacy)
  const mfaCfg = cfg.moneyFlowAnomaly;
  const mfaEnabled = mfaCfg?.enabled === true;

  // Collect freshly polled pairs so the money-flow pass can rank them all
  // together at the end of the cycle.
  const polled: Array<{ pair: DexScreenerPair; snapshotId: number }> = [];

  let alertsFired = 0;

  // ---------------- PASS 1: poll, snapshot, legacy tier classification ----------------
  for (const pairAddress of tracked) {
    let p: DexScreenerPair | null = null;
    try {
      p = await dex().pair('solana', pairAddress);
    } catch (e) {
      log.debug(`pair fetch failed for ${pairAddress}`, { err: (e as Error).message });
      continue;
    }
    if (!p) continue;

    // Re-filter — pair might have moved out of bounds since discovery.
    // We still snapshot (so the next pass has data), but won't alert.
    const inRange = passesBaseFilter(p);

    const snapshotId = insertSnapshot(p);
    polled.push({ pair: p, snapshotId });

    if (!inRange) continue;

    // -------- Legacy tier classification (always computed for telemetry) --------
    const recent = recentSnapshots(pairAddress, SCORING_LOOKBACK_MS);
    if (recent.length < 2) continue;

    const score = scoreAnomaly(recent);
    const priceChangeM5Abs = Math.abs(p.priceChange?.m5 ?? 0);
    const tier = classifyTier(score, priceChangeM5Abs);
    if (!tier) continue;

    // Noise / anti-manipulation gates only relevant for legacy tier alerts.
    const minTxns = cfg.minM5Txns ?? 10;
    const minVolUsd = cfg.minM5VolumeUsd ?? 2000;
    const m5Buys = p.txns?.m5?.buys ?? 0;
    const m5Sells = p.txns?.m5?.sells ?? 0;
    const m5TxnTotal = m5Buys + m5Sells;
    const m5Vol = p.volume?.m5 ?? 0;
    const liq = p.liquidity?.usd ?? 0;
    const symbol = p.baseToken.symbol ?? pairAddress;

    if (m5TxnTotal < minTxns || m5Vol < minVolUsd) {
      log.debug(`SKIP ${symbol} (legacy): noise floor (txns=${m5TxnTotal}, vol=$${m5Vol.toFixed(0)})`);
      continue;
    }

    const buyRatioPct = m5TxnTotal > 0 ? (m5Buys / m5TxnTotal) * 100 : 50;
    const buyMax = cfg.buyRatioMaxExtreme ?? 85;
    const buyMin = cfg.buyRatioMinExtreme ?? 20;
    if (buyRatioPct >= buyMax || buyRatioPct <= buyMin) {
      log.debug(`SKIP ${symbol} (legacy): extreme buy ratio ${buyRatioPct.toFixed(0)}%`);
      continue;
    }

    const maxVolOverLiq = cfg.maxVolumeOverLiquidityRatio ?? 0.5;
    if (liq > 0 && (m5Vol / liq) > maxVolOverLiq) {
      log.debug(`SKIP ${symbol} (legacy): vol/liq ${(m5Vol / liq).toFixed(2)} > ${maxVolOverLiq}`);
      continue;
    }

    const maxLiqDrop = cfg.maxLiquidityDropPct ?? 20;
    if (recent.length >= 2 && liq > 0) {
      const prior = recent[recent.length - 2]!;
      const priorLiq = prior.liquidity_usd ?? 0;
      if (priorLiq > 0) {
        const dropPct = ((priorLiq - liq) / priorLiq) * 100;
        if (dropPct >= maxLiqDrop) {
          log.warn(`SKIP ${symbol} (legacy): liquidity dropped ${dropPct.toFixed(1)}%`);
          continue;
        }
      }
    }

    if (!shouldFire(pairAddress, tier)) continue;

    // Always record the legacy tier alert in DB for telemetry, even when
    // Telegram delivery is disabled — useful for backtesting / tuning.
    const formatted = formatAlert({ tier, pair: p, score });
    let sent = false;
    if (tieredEnabled && isTelegramConfigured()) {
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
    if (sent) {
      alertsFired++;
      log.info(`Alert fired ${tier} for ${symbol}`, {
        score: score.overall, volAccel: score.volumeAcceleration, sent,
      });
    } else if (!tieredEnabled) {
      log.debug(`Legacy tier ${tier} suppressed (tieredAlertsEnabled=false) for ${symbol}`);
    }
  }

  // ---------------- PASS 2: MONEY_FLOW_ANOMALY radar ----------------
  if (mfaEnabled && mfaCfg) {
    log.debug(`Money-flow pass over ${polled.length} polled pairs (minScore=${mfaCfg.minScore})`);
    const lookbackHours = mfaCfg.lookbackHours ?? 4;

    // Score every polled pair against its own baseline first.
    const scored: Array<{ pair: DexScreenerPair; snapshotId: number; score: MoneyFlowScore }> = [];
    for (const { pair, snapshotId } of polled) {
      const history = recentSnapshotsHours(pair.pairAddress, lookbackHours);
      const sc = scoreMoneyFlow(history, pair);
      if (!sc.hardReject) scored.push({ pair, snapshotId, score: sc });
    }

    // Cross-pair ranking — boosts top decile / top 3% of THIS scan.
    applyRankBoost(scored.map((s) => ({ pair: s.pair, score: s.score })));

    // Fire alerts for anything that crossed the threshold + passed dedup.
    let mfaFired = 0;
    for (const { pair, snapshotId, score } of scored) {
      if (score.overall < mfaCfg.minScore) continue;

      const fireDecision = shouldFireMoneyFlow(pair.pairAddress, score.overall);
      const symbol = pair.baseToken?.symbol ?? pair.pairAddress;
      if (!fireDecision.fire) {
        log.debug(`MFA SKIP ${symbol} (${score.overall.toFixed(1)}): ${fireDecision.reason}`);
        continue;
      }

      const formatted = formatMoneyFlowAlert({ pair, score });
      let sent = false;
      if (isTelegramConfigured()) {
        sent = await sendTelegramMessage(formatted);
      }
      insertAlert({
        pairAddress: pair.pairAddress,
        tier: 'MONEY_FLOW_ANOMALY',
        score: score.overall,
        volumeAcceleration: score.volRatio,    // use vol-ratio in the legacy column
        priceChangeM5: pair.priceChange?.m5 ?? null,
        marketCap: pair.marketCap ?? pair.fdv ?? null,
        liquidityUsd: pair.liquidity?.usd ?? null,
        buyRatio: score.buyRatio,
        snapshotId,
        payload: { pair, score, formatted: formatted.text, reason: fireDecision.reason },
        sent,
      });

      if (sent) {
        mfaFired++;
        alertsFired++;
        log.info(`🔥 MONEY_FLOW_ANOMALY ${symbol}`, {
          score: score.overall,
          base: score.baseScore,
          rankBoost: score.rankBoost,
          volRatio: score.volRatio,
          buyRatio: score.buyRatio,
          reason: fireDecision.reason,
          sent,
        });
      }
    }
    if (mfaFired > 0) log.info(`Money-flow pass fired ${mfaFired} MONEY_FLOW_ANOMALY alert(s)`);
  }

  if (alertsFired > 0) log.info(`Poll cycle done — ${alertsFired} total alert(s) fired`);
}
