/**
 * RUNNER detector — early-stage memecoin pattern matcher.
 *
 * Looks for the multi-day accumulation signature that precedes a 10-100x
 * memecoin run (WIF / BONK / POPCAT profile) — NOT for 5-minute volume spikes.
 *
 * Fires only when ALL conditions are simultaneously true:
 *   1. Pair age in [minAgeDays, maxAgeDays] (past launch chaos, not yet dead)
 *   2. Market cap in [minCapUsd, maxCapUsd] (room to 10-100x)
 *   3. H24 volume >= turnoverMinPct of market cap (real turnover)
 *   4. H6 volume rate >= h6AccelMin x H24 average rate (accelerating, not fading)
 *   5. Liquidity grew by >= liqGrowthMinPct over scan window (LPs adding)
 *   6. H24 buy ratio in [buyRatioMin, buyRatioMax] (slight bullish, not bot)
 *   7. H1 price change in [h1PriceMin, h1PriceMax] (steady, not pump-dump)
 *   8. H24 price change in [h24PriceMin, h24PriceMax] (uptrend, not euphoric)
 *   9. H24 txns >= h24TxnsMin (broad participation, not 5-wallet)
 *  10. On allow-listed DEX (Raydium / PumpSwap / Meteora / Orca)
 *
 * Returns null if not a runner; a RunnerSignal if it is.
 */
import type { SnapshotRow } from '../db/snapshots.js';
import type { DexScreenerPair } from '../dexscreener/client.js';
import { getConfig } from '../config/loader.js';

export interface RunnerSignal {
  // The data that matched
  ageDays: number;
  marketCap: number;
  liquidityUsd: number;
  liquidityGrowthPct: number;
  h24Volume: number;
  turnoverPct: number;             // h24Vol / marketCap * 100
  h6AccelerationRatio: number;     // (h6/6) / (h24/24)
  h24BuyRatio: number;
  h1PriceChange: number;
  h24PriceChange: number;
  h24Txns: number;
  dexId: string;
  reasons: string[];               // human-readable WHY lines
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DEX_ALLOWLIST = ['raydium', 'pumpswap', 'meteora', 'orca'];

export function detectRunner(
  snapshots: SnapshotRow[],
  pair: DexScreenerPair,
): RunnerSignal | null {
  const cfg = getConfig().strategy.runner;
  if (!cfg) return null;

  // Required raw data
  const cap = pair.marketCap ?? pair.fdv ?? 0;
  const liq = pair.liquidity?.usd ?? 0;
  const h24Vol = pair.volume?.h24 ?? 0;
  const h6Vol  = pair.volume?.h6  ?? 0;
  const h24Buys = pair.txns?.h24?.buys ?? 0;
  const h24Sells = pair.txns?.h24?.sells ?? 0;
  const h24TxnTotal = h24Buys + h24Sells;
  const h1PriceChange = pair.priceChange?.h1 ?? 0;
  const h24PriceChange = pair.priceChange?.h24 ?? 0;

  if (cap <= 0 || liq <= 0 || h24Vol <= 0 || h24TxnTotal <= 0) return null;
  if (!pair.pairCreatedAt) return null;

  // 1. Pair age window
  const ageDays = (Date.now() - pair.pairCreatedAt) / DAY_MS;
  if (ageDays < cfg.minAgeDays || ageDays > cfg.maxAgeDays) return null;

  // 2. Market cap window
  if (cap < cfg.minCapUsd || cap > cfg.maxCapUsd) return null;

  // 3. Turnover (h24 vol vs MC)
  const turnoverPct = (h24Vol / cap) * 100;
  if (turnoverPct < cfg.turnoverMinPct) return null;

  // 4. H6 acceleration vs H24 avg rate
  const h24Rate = h24Vol / 24;
  const h6Rate  = h6Vol  / 6;
  const accel = h24Rate > 0 ? h6Rate / h24Rate : 0;
  if (accel < cfg.h6AccelMin) return null;

  // 5. Liquidity growth across scan window (use earliest snapshot we have)
  let liqGrowthPct = 0;
  if (snapshots.length >= 2) {
    // Use the OLDEST snapshot in the window as the baseline
    const first = snapshots[0]!;
    const baseLiq = first.liquidity_usd ?? 0;
    if (baseLiq > 0) liqGrowthPct = ((liq - baseLiq) / baseLiq) * 100;
  }
  if (liqGrowthPct < cfg.liqGrowthMinPct) return null;

  // 6. Healthy buy ratio (slight bullish, not bot-pumped)
  const h24BuyRatio = h24TxnTotal > 0 ? (h24Buys / h24TxnTotal) * 100 : 50;
  if (h24BuyRatio < cfg.buyRatioMin || h24BuyRatio > cfg.buyRatioMax) return null;

  // 7. H1 price action — steady climb, not pump-dump
  if (h1PriceChange < cfg.h1PriceMin || h1PriceChange > cfg.h1PriceMax) return null;

  // 8. H24 trend — uptrend but not euphoric (already too late)
  if (h24PriceChange < cfg.h24PriceMin || h24PriceChange > cfg.h24PriceMax) return null;

  // 9. Broad participation
  if (h24TxnTotal < cfg.h24TxnsMin) return null;

  // 10. DEX allow-list (filter random fly-by-night pools)
  const dexId = (pair.dexId ?? '').toLowerCase();
  const allowList = cfg.dexAllowlist ?? DEFAULT_DEX_ALLOWLIST;
  const dexOk = allowList.some((a) => dexId.includes(a.toLowerCase()));
  if (!dexOk) return null;

  // Build human reasons for the alert
  const reasons: string[] = [];
  reasons.push('Age ' + ageDays.toFixed(1) + 'd, cap $' + (cap/1e6).toFixed(2) + 'M (sweet spot)');
  reasons.push('H24 volume $' + (h24Vol/1e6).toFixed(2) + 'M = ' + turnoverPct.toFixed(0) + '% of MC (strong turnover)');
  reasons.push('H6 rate ' + accel.toFixed(2) + 'x H24 avg (accelerating, not fading)');
  if (liqGrowthPct > 0) reasons.push('Liquidity +' + liqGrowthPct.toFixed(1) + '% over scan window (LPs adding)');
  reasons.push('H24 buy ratio ' + h24BuyRatio.toFixed(0) + '% (slight bullish lean, no bot extremity)');
  reasons.push('Price ' + (h24PriceChange >= 0 ? '+' : '') + h24PriceChange.toFixed(1) + '% (24h), '
             + (h1PriceChange >= 0 ? '+' : '') + h1PriceChange.toFixed(1) + '% (1h) — steady climb');
  reasons.push(h24TxnTotal.toLocaleString() + ' txns in 24h (broad participation)');

  return {
    ageDays,
    marketCap: cap,
    liquidityUsd: liq,
    liquidityGrowthPct: liqGrowthPct,
    h24Volume: h24Vol,
    turnoverPct,
    h6AccelerationRatio: accel,
    h24BuyRatio,
    h1PriceChange,
    h24PriceChange,
    h24Txns: h24TxnTotal,
    dexId: pair.dexId ?? 'unknown',
    reasons,
  };
}

/** GMGN URL helper — same as money_flow's, kept here so runner is self-contained. */
export function gmgnTokenUrl(tokenAddress: string): string {
  return 'https://gmgn.ai/sol/token/' + tokenAddress;
}
