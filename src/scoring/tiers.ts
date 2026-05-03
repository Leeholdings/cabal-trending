/**
 * Alert tier classification.
 *
 *   WATCH:        volAccel 1.4-1.8x, m5 price change < 6%
 *   TRADE_RADAR:  volAccel 1.8-2.5x, m5 price change < 10%
 *   CAUTION:      volAccel >= 3x  OR  m5 price change >= 20%
 *
 * Tiers are exclusive — a single snapshot resolves to at most one tier.
 * CAUTION trumps TRADE_RADAR which trumps WATCH.
 */
import { getConfig } from '../config/loader.js';
import type { ScoreOutput } from './engine.js';

export type AlertTier = 'WATCH' | 'TRADE_RADAR' | 'CAUTION' | null;

export function classifyTier(score: ScoreOutput, priceChangeM5Abs: number): AlertTier {
  const s = getConfig().strategy;
  const va = score.volumeAcceleration;

  // CAUTION first — protects against late entries
  const cautionByAccel = s.cautionAlert.volumeAccelerationMin
    ? va >= s.cautionAlert.volumeAccelerationMin
    : false;
  const cautionByPrice = s.cautionAlert.priceChangeM5Min !== undefined
    ? priceChangeM5Abs >= s.cautionAlert.priceChangeM5Min
    : false;
  if (cautionByAccel || cautionByPrice) return 'CAUTION';

  // TRADE_RADAR
  if (
    va >= s.tradeRadarAlert.volumeAccelerationMin &&
    va < (s.tradeRadarAlert.volumeAccelerationMax ?? Infinity) &&
    priceChangeM5Abs < (s.tradeRadarAlert.priceChangeM5Max ?? Infinity)
  ) {
    return 'TRADE_RADAR';
  }

  // WATCH
  if (
    va >= s.watchAlert.volumeAccelerationMin &&
    va < (s.watchAlert.volumeAccelerationMax ?? Infinity) &&
    priceChangeM5Abs < (s.watchAlert.priceChangeM5Max ?? Infinity)
  ) {
    return 'WATCH';
  }

  return null;
}

/** Numeric ranking so escalation logic can compare. */
export function tierRank(t: AlertTier): number {
  switch (t) {
    case 'WATCH': return 1;
    case 'TRADE_RADAR': return 2;
    case 'CAUTION': return 3;
    default: return 0;
  }
}
