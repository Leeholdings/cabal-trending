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
  h6AccelerationRatio: number;
  h24BuyRatio: number;
  h1PriceChange: number;
  h24PriceChange: number;
  h24Txns: number;
  dexId: string;
  reasons: string[];
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
  const h24Buys = pair.txns?.h24?.buys ?? 0;
  const h24Sells = pair.txns?.h24?.sells ?? 0;
  const h24TxnTotal = h24Buys + h24Sells;
  const h1PriceChange = pair.priceChange?.h1 ?? 0;
  const h24PriceChange = pair.priceChange?.h24 ?? 0;

  if (cap <= 0 || liq <= 0 || h24Vol <= 0 || h24TxnTotal <= 0) return null;
  if (!pair.pairCreatedAt) return null;

  const ageDays = (Date.now() - pair.pairCreatedAt) / DAY_MS;
  if (ageDays < cfg.minAgeDays || ageDays > cfg.maxAgeDays) return null;
  if (cap < cfg.minCapUsd || cap > cfg.maxCapUsd) return null;

  const turnoverPct = (h24Vol / cap) * 100;
  if (turnoverPct < cfg.turnoverMinPct) return null;

  const h24Rate = h24Vol / 24;
  const h6Rate  = h6Vol  / 6;
  const accel = h24Rate > 0 ? h6Rate / h24Rate : 0;
  if (accel < cfg.h6AccelMin) return null;

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
  reasons.push('H6 rate ' + accel.toFixed(2) + 'x H24 avg (accelerating)');
  if (liqGrowthPct > 0) reasons.push('Liquidity +' + liqGrowthPct.toFixed(1) + '% over scan window');
  reasons.push('H24 buy ratio ' + h24BuyRatio.toFixed(0) + '% (slight bullish)');
  reasons.push('Price ' + (h24PriceChange >= 0 ? '+' : '') + h24PriceChange.toFixed(1) + '% (24h), '
             + (h1PriceChange >= 0 ? '+' : '') + h1PriceChange.toFixed(1) + '% (1h)');
  reasons.push(h24TxnTotal.toLocaleString() + ' txns in 24h');

  return {
    ageDays, marketCap: cap, liquidityUsd: liq, liquidityGrowthPct: liqGrowthPct,
    h24Volume: h24Vol, turnoverPct, h6AccelerationRatio: accel,
    h24BuyRatio, h1PriceChange, h24PriceChange, h24Txns: h24TxnTotal,
    dexId: pair.dexId ?? 'unknown', reasons,
  };
}

export function gmgnTokenUrl(tokenAddress: string): string {
  return 'https://gmgn.ai/sol/token/' + tokenAddress;
}
