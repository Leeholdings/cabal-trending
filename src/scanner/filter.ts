/**
 * Base filtering: decides whether a DexScreener pair is worth tracking.
 *
 * RULES:
 *   - chainId must be solana
 *   - marketCap OR fdv between strategy.marketCapMin / Max
 *   - liquidity between strategy.liquidityMin / Max
 *   - volume.h24 >= strategy.volumeH24Min
 *   - pair age < strategy.pairAgeMaxDays (if pairCreatedAt is present)
 *   - required fields exist (price, liquidity, volume, txns)
 */
import type { DexScreenerPair } from '../dexscreener/client.js';
import { getConfig } from '../config/loader.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function passesBaseFilter(p: DexScreenerPair): boolean {
  const s = getConfig().strategy;

  if (p.chainId !== 'solana') return false;

  // Required fields
  if (!p.priceUsd) return false;
  const liq = p.liquidity?.usd ?? 0;
  if (!liq) return false;
  const volH24 = p.volume?.h24 ?? 0;
  if (!p.txns?.h24) return false;

  // Market cap (use marketCap, fall back to fdv)
  const cap = p.marketCap ?? p.fdv ?? 0;
  if (cap < s.marketCapMin || cap > s.marketCapMax) return false;

  // Liquidity bounds
  if (liq < s.liquidityMin || liq > s.liquidityMax) return false;

  // Volume floor
  if (volH24 < s.volumeH24Min) return false;

  // Pair age cap (only enforced if we have pairCreatedAt)
  if (p.pairCreatedAt) {
    const ageMs = Date.now() - p.pairCreatedAt;
    if (ageMs > s.pairAgeMaxDays * DAY_MS) return false;
  }

  return true;
}
