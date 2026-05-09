/**
 * Polling cycle: discover -> filter -> snapshot -> score -> alert.
 *
 * Three alert layers (each independently toggled in strategy config):
 *   1. LEGACY TIERED (WATCH/RADAR/CAUTION) — silenced when tieredAlertsEnabled=false
 *   2. MONEY_FLOW_ANOMALY — silenced when moneyFlowAnomaly.enabled=false
 *   3. RUNNER — fires when 10-condition pattern matches (the user's actual ask:
 *      catch the multi-day accumulation pattern that precedes 10-100x runs)
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
import { detectRunner } from '../scoring/runner.js';
import { shouldFire, shouldFireMoneyFlow, shouldFireRunner } from '../alerts/dedup.js';
import { formatAlert, formatMoneyFlowAlert, formatRunnerAlert } from '../alerts/formatter.js';
import { sendTelegramMessage, isTelegramConfigured } from '../alerts/telegram.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/logger.js';

const SCORING_LOOKBACK_MS = 20 * 60 * 1000;

let _lastDiscoveryAt = 0;

export async function runDiscovery(): Promise<void> {
  const cfg = getConfig();
  const since = Date.now() - _lastDiscoveryAt;
  if (since < cfg.discovery.discoveryIntervalMinutes * 60_000) return;
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
      try {
        pairs = await dex().tokenPairs('solana', tokenAddress);
      } catch (e) {
        log.debug('tokenPairs failed', { err: (e as Error).message });
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

  for (const q of cfg.discovery.seedQueries) {
    let pairs: DexScreenerPair[] = [];
    try {
      pairs = await dex().search(q);
    } catch (e) {
      log.warn('search failed', { q, err: (e as Error).message });
      continue;
    }
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue;
      if (!passesBaseFilter(p)) continue;
      upsertPair(p);
      surfaced++;
    }
  }

  for (const pairAddress of cfg.watchlist.pairs) {
    try {
      const p = await dex().pair('solana', pairAddress);
      if (p) { upsertPair(p); surfaced++; }
    } catch (e) {
      log.warn('watchlist pair failed', { pairAddress, err: (e as Error).message });
    }
  }

  log.info('Discovery cycle done', { surfaced });
}

export async function runPoll(): Promise<void> {
  const tracked = allTrackedPairs('solana');
  if (tracked.length === 0) {
    log.debug("No tracked pairs yet");
    return;
  }
  log.debug('Polling ' + tracked.length + ' pairs');

  const cfg = getConfig().strategy;
  const tieredEnabled = cfg.tieredAlertsEnabled !== false;
  const mfaCfg = cfg.moneyFlowAnomaly;
  const mfaEnabled = mfaCfg?.enabled === true;
  const runnerCfg = cfg.runner;
  const runnerEnabled = runnerCfg?.enabled === true;

  const polled: Array<{ pair: DexScreenerPair; snapshotId: number }> = [];
  let alertsFired = 0;

  // ---------------- PASS 1: poll, snapshot, legacy tier classification ----------------
  for (const pairAddress of tracked) {
    let p: DexScreenerPair | null = null;
    try {
      p = await dex().pair('solana', pairAddress);
    } catch (e) {
      log.debug('pair fetch failed', { pairAddress, err: (e as Error).message });
      continue;
    }
    if (!p) continue;

    const inRange = passesBaseFilter(p);
    const snapshotId = insertSnapshot(p);
    polled.push({ pair: p, snapshotId });
    if (!inRange) continue;

    const recent = recentSnapshots(pairAddress, SCORING_LOOKBACK_MS);
    if (recent.length < 2) continue;

    const score = scoreAnomaly(recent);
    const priceChangeM5Abs = Math.abs(p.priceChange?.m5 ?? 0);
    const tier = classifyTier(score, priceChangeM5Abs);
    if (!tier) continue;
    if (tier === 'MONEY_FLOW_ANOMALY' || tier === 'RUNNER') continue;  // handled in pass 2/3

    const minTxns = cfg.minM5Txns ?? 10;
    const minVolUsd = cfg.minM5VolumeUsd ?? 2000;
    const m5Buys = p.txns?.m5?.buys ?? 0;
    const m5Sells = p.txns?.m5?.sells ?? 0;
    const m5TxnTotal = m5Buys + m5Sells;
    const m5Vol = p.volume?.m5 ?? 0;
    const liq = p.liquidity?.usd ?? 0;
    const symbol = p.baseToken.symbol ?? pairAddress;

    if (m5TxnTotal < minTxns || m5Vol < minVolUsd) continue;
    const buyRatioPct = m5TxnTotal > 0 ? (m5Buys / m5TxnTotal) * 100 : 50;
    const buyMax = cfg.buyRatioMaxExtreme ?? 85;
    const buyMin = cfg.buyRatioMinExtreme ?? 20;
    if (buyRatioPct >= buyMax || buyRatioPct <= buyMin) continue;
    const maxVolOverLiq = cfg.maxVolumeOverLiquidityRatio ?? 0.5;
    if (liq > 0 && (m5Vol / liq) > maxVolOverLiq) continue;

    if (!shouldFire(pairAddress, tier)) continue;

    const formatted = formatAlert({ tier, pair: p, score });
    let sent = false;
    if (tieredEnabled && isTelegramConfigured()) {
      sent = await sendTelegramMessage(formatted);
    }
    insertAlert({
      pairAddress, tier,
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
      log.info('Legacy alert fired ' + tier + ' for ' + symbol, { score: score.overall, sent });
    }
  }

  // ---------------- PASS 2: MONEY_FLOW_ANOMALY (silenced when disabled) ----------------
  if (mfaEnabled && mfaCfg) {
    log.debug('Money-flow pass over ' + polled.length + ' polled pairs (minScore=' + mfaCfg.minScore + ')');
    const lookbackHours = mfaCfg.lookbackHours ?? 4;

    const scored: Array<{ pair: DexScreenerPair; snapshotId: number; score: MoneyFlowScore }> = [];
    for (const { pair, snapshotId } of polled) {
      const history = recentSnapshotsHours(pair.pairAddress, lookbackHours);
      const sc = scoreMoneyFlow(history, pair);
      if (!sc.hardReject) scored.push({ pair, snapshotId, score: sc });
    }
    applyRankBoost(scored.map((s) => ({ pair: s.pair, score: s.score })));

    for (const { pair, snapshotId, score } of scored) {
      if (score.overall < mfaCfg.minScore) continue;
      const decision = shouldFireMoneyFlow(pair.pairAddress, score.overall);
      const symbol = pair.baseToken?.symbol ?? pair.pairAddress;
      if (!decision.fire) {
        log.debug('MFA SKIP ' + symbol + ' (' + score.overall.toFixed(1) + '): ' + decision.reason);
        continue;
      }
      const formatted = formatMoneyFlowAlert({ pair, score });
      let sent = false;
      if (isTelegramConfigured()) sent = await sendTelegramMessage(formatted);
      insertAlert({
        pairAddress: pair.pairAddress, tier: 'MONEY_FLOW_ANOMALY',
        score: score.overall,
        volumeAcceleration: score.volRatio,
        priceChangeM5: pair.priceChange?.m5 ?? null,
        marketCap: pair.marketCap ?? pair.fdv ?? null,
        liquidityUsd: pair.liquidity?.usd ?? null,
        buyRatio: score.buyRatio,
        snapshotId,
        payload: { pair, score, formatted: formatted.text, reason: decision.reason },
        sent,
      });
      if (sent) {
        alertsFired++;
        log.info('🔥 MONEY_FLOW_ANOMALY ' + symbol, { score: score.overall, sent });
      }
    }
  }

  // ---------------- PASS 3: RUNNER detector ----------------
  if (runnerEnabled && runnerCfg) {
    log.debug('Runner pass over ' + polled.length + ' polled pairs');
    const lookbackHours = runnerCfg.lookbackHours ?? 6;

    let runnersFired = 0;
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

      // Use turnoverPct as the "score" for telemetry (0-100ish range).
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
        runnersFired++;
        alertsFired++;
        log.info('🚀 RUNNER ' + symbol, {
          age: signal.ageDays.toFixed(1) + 'd',
          cap: '$' + (signal.marketCap / 1e6).toFixed(2) + 'M',
          turnover: signal.turnoverPct.toFixed(0) + '%',
          accel: signal.h6AccelerationRatio.toFixed(2) + 'x',
          h24: signal.h24PriceChange.toFixed(1) + '%',
          sent,
        });
      }
    }
    if (runnersFired > 0) log.info('Runner pass fired ' + runnersFired + ' RUNNER alert(s)');
  }

  if (alertsFired > 0) log.info('Poll cycle done — ' + alertsFired + ' total alert(s) fired');
}
