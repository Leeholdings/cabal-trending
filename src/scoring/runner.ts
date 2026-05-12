import type { SnapshotRow } from '../db/snapshots.js';
import type { DexScreenerPair } from '../dexscreener/client.js';
import { getConfig } from '../config/loader.js';

export interface RunnerSignal {
  ageDays: number;
  marketCap: number;
  liquidityUsd: number;
  liquidityGrowthPct: number;
  h24Volume: number;
  turnoverPct: number;
  // Volume acceleration on a SHORT window (H1 rate vs H6 average rate).
  // Was H6/H24 — that lagged 2-4hrs into the run. H1/H6 catches early heating.
  h1AccelerationRatio: number;
  // Buyer-count surge on the FASTEST window (M5 txns/min vs H1 txns/min).
  // True leading indicator: real flow arriving usually precedes price by 5-15 min.
  m5TxnAccelerationRatio: number;
  m5TxnsTotal: number;
  h24BuyRatio: number;
  h1PriceChange: number;
  h24PriceChange: number;
  h24Txns: number;
  dexId: string;
  reasons: string[];
  // Back-compat shim — older callers (poll.ts pre-migration) referenced this.
  // Now it just mirrors h1AccelerationRatio so DB columns stay populated.
  h6AccelerationRatio: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEX_ALLOWLIST = ['raydium', 'pumpfun', 'pump', 'pumpswap', 'bonk', 'letsbonk', 'meteora', 'orca'];

export function detectRunner(snapshots: SnapshotRow[], pair: DexScreenerPair): RunnerSignal | null {
  const cfg = getConfig().strategy.runner;
  if (!cfg) return null;

  const cap = pair.marketCap ?? pair.fdv ?? 0;
  const liq = pair.liquidity?.usd ?? 0;
  const h24Vol = pair.volume?.h24 ?? 0;
  const h6Vol  = pair.volume?.h6  ?? 0;
  const h1Vol  = pair.volume?.h1  ?? 0;

  const h24Buys = pair.txns?.h24?.buys ?? 0;
  const h24Sells = pair.txns?.h24?.sells ?? 0;
  const h24TxnTotal = h24Buys + h24Sells;

  const h1Buys = pair.txns?.h1?.buys ?? 0;
  const h1Sells = pair.txns?.h1?.sells ?? 0;
  const h1TxnTotal = h1Buys + h1Sells;

  const m5Buys = pair.txns?.m5?.buys ?? 0;
  const m5Sells = pair.txns?.m5?.sells ?? 0;
  const m5TxnTotal = m5Buys + m5Sells;

  const h1PriceChange = pair.priceChange?.h1 ?? 0;
  const h24PriceChange = pair.priceChange?.h24 ?? 0;

  if (cap <= 0 || liq <= 0 || h24Vol <= 0 || h24TxnTotal <= 0) return null;
  if (!pair.pairCreatedAt) return null;

  const ageDays = (Date.now() - pair.pairCreatedAt) / DAY_MS;
  if (ageDays < cfg.minAgeDays || ageDays > cfg.maxAgeDays) return null;
  if (cap < cfg.minCapUsd || cap > cfg.maxCapUsd) return null;

  const turnoverPct = (h24Vol / cap) * 100;
  if (turnoverPct < cfg.turnoverMinPct) return null;

  // --- EARLY DETECTION SIGNAL #1: H1 vs H6 volume acceleration ---
  // h1Vol = total volume in the last 1 hour (already a per-hour rate)
  // h6Vol/6 = average per-hour rate over the last 6 hours
  // Ratio > 1.0 means the last hour is hotter than the prior 6h average.
  const h6RatePerHour = h6Vol / 6;
  const h1Accel = h6RatePerHour > 0 ? h1Vol / h6RatePerHour : 0;
  const h1AccelMin = (cfg as any).h1AccelMin ?? cfg.h6AccelMin ?? 1.3;
  if (h1Accel < h1AccelMin) return null;

  // --- EARLY DETECTION SIGNAL #2: M5 vs H1 buyer-count surge ---
  // INFORMATIONAL ONLY (no hard gate) — surfaces extra confidence in the
  // alert message when present, but doesn't block alerts from firing.
  // True leading indicator: crowd attention shows up in txn-count first,
  // before price. Compare per-minute rates.
  const m5RatePerMin = m5TxnTotal / 5;
  const h1RatePerMin = h1TxnTotal / 60;
  const m5TxnAccel = h1RatePerMin > 0 ? m5RatePerMin / h1RatePerMin : 0;

  let liqGrowthPct = 0;
  if (snapshots.length >= 2) {
    const baseLiq = snapshots[0]!.liquidity_usd ?? 0;
    if (baseLiq > 0) liqGrowthPct = ((liq - baseLiq) / baseLiq) * 100;
  }
  if (liqGrowthPct < cfg.liqGrowthMinPct) return null;

  const h24BuyRatio = h24TxnTotal > 0 ? (h24Buys / h24TxnTotal) * 100 : 50;
  if (h24BuyRatio < cfg.buyRatioMin || h24BuyRatio > cfg.buyRatioMax) return null;
  if (h1PriceChange < cfg.h1PriceMin || h1PriceChange > cfg.h1PriceMax) return null;
  if (h24PriceChange < cfg.h24PriceMin || h24PriceChange > cfg.h24PriceMax) return null;
  if (h24TxnTotal < cfg.h24TxnsMin) return null;

  const dexId = (pair.dexId ?? '').toLowerCase();
  const allowList = cfg.dexAllowlist ?? DEFAULT_DEX_ALLOWLIST;
  if (!allowList.some((a) => dexId.includes(a.toLowerCase()))) return null;

  const reasons: string[] = [];
  reasons.push('Age ' + ageDays.toFixed(1) + 'd, cap $' + (cap/1e6).toFixed(2) + 'M');
  reasons.push('H24 vol $' + (h24Vol/1e6).toFixed(2) + 'M = ' + turnoverPct.toFixed(0) + '% of MC');
  // NEW early-detection lines (replacing the old "H6 rate vs H24 avg" line):
  reasons.push('H1 vol rate ' + h1Accel.toFixed(2) + 'x H6 avg (early heat)');
  // Only show M5 surge line when it's a meaningful signal (>=2x AND enough sample)
  if (m5TxnTotal >= 20 && m5TxnAccel >= 2.0) {
    reasons.push('M5 buyer surge: ' + m5TxnAccel.toFixed(2) + 'x H1 rate (' + Math.round(m5RatePerMin) + ' txns/min)');
  }
  if (liqGrowthPct > 0) reasons.push('Liquidity +' + liqGrowthPct.toFixed(1) + '% over scan window');
  reasons.push('H24 buy ratio ' + h24BuyRatio.toFixed(0) + '% (slight bullish)');
  reasons.push('Price ' + (h24PriceChange >= 0 ? '+' : '') + h24PriceChange.toFixed(1) + '% (24h), '
             + (h1PriceChange >= 0 ? '+' : '') + h1PriceChange.toFixed(1) + '% (1h)');
  reasons.push(h24TxnTotal.toLocaleString() + ' txns in 24h');

  return {
    ageDays, marketCap: cap, liquidityUsd: liq, liquidityGrowthPct: liqGrowthPct,
    h24Volume: h24Vol, turnoverPct,
    h1AccelerationRatio: h1Accel,
    m5TxnAccelerationRatio: m5TxnAccel,
    m5TxnsTotal: m5TxnTotal,
    h24BuyRatio, h1PriceChange, h24PriceChange, h24Txns: h24TxnTotal,
    dexId: pair.dexId ?? 'unknown', reasons,
    h6AccelerationRatio: h1Accel,  // back-compat shim
  };
}

export function gmgnTokenUrl(tokenAddress: string): string {
  return 'https://gmgn.ai/sol/token/' + tokenAddress;
}
