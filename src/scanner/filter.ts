/**
 * Base filtering: decides whether a DexScreener pair is worth tracking
 * AT ALL (not whether to alert — that's the scoring engine's job).
 *
 * Philosophy with money-flow radar enabled: only reject obvious trash.
 * Let the scoring engine decide quality. Adaptive scoring beats rigid bands.
 *
 * Rejection criteria (obvious trash only):
 *   - chainId != solana (we only support Solana)
 *   - missing required fields (price, liquidity, txns)
 *   - liquidity below absolute hard floor
 *   - market cap above absolute hard ceiling (filter out megacaps)
 *   - market cap below absolute hard floor (filter out dust < $50K)
 *   - pair age > absolute max (set high — anything within 2 years OK)
 *
 * Everything else flows through to the scorer.
 */
import type { DexScreenerPair } from '../dexscreener/client.js';
import { getConfig } from '../config/loader.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function passesBaseFilter(p: DexScreenerPair): boolean {
  const s = getConfig().strategy;
  const useLooseFilter = s.moneyFlowAnomaly?.enabled ?? false;

  if (p.chainId !== 'solana') return false;

  // Required fields
  if (!p.priceUsd) return false;
  const liq = p.liquidity?.usd ?? 0;
  if (!liq) return false;
  if (!p.txns?.h24) return false;

  // Loose mode (when money-flow radar is on): only obvious trash gets rejected
  if (useLooseFilter) {
    const hardFloor = s.moneyFlowAnomaly?.minLiquidityHardReject ?? 5000;
    if (liq < hardFloor) return false;
    const cap = p.marketCap ?? p.fdv ?? 0;
    if (cap < 50_000) return false;          // dust
    if (cap > 1_000_000_000) return false;   // megacap, doesn't move
    // No volume floor — scorer handles it
    // No age cap — scorer's age modifier handles it
    return true;
  }

  // Legacy strict mode (used when moneyFlowAnomaly.enabled === false)
  const cap = p.marketCap ?? p.fdv ?? 0;
  if (cap < s.marketCapMin || cap > s.marketCapMax) return false;
  if (liq < s.liquidityMin || liq > s.liquidityMax) return false;
  const volH24 = p.volume?.h24 ?? 0;
  if (volH24 < s.volumeH24Min) return false;
  if (p.pairCreatedAt) {
    const ageMs = Date.now() - p.pairCreatedAt;
    if (ageMs > s.pairAgeMaxDays * DAY_MS) return false;
  }
  return true;
}
