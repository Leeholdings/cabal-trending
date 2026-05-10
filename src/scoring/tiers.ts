import { getConfig } from '../config/loader.js';
import type { ScoreOutput } from './engine.js';

export type AlertTier = 'WATCH' | 'TRADE_RADAR' | 'CAUTION' | 'MONEY_FLOW_ANOMALY' | 'RUNNER' | null;

export function classifyTier(score: ScoreOutput, priceChangeM5Abs: number): AlertTier {
  const s = getConfig().strategy;
  const va = score.volumeAcceleration;

  const cautionByAccel = s.cautionAlert.volumeAccelerationMin
    ? va >= s.cautionAlert.volumeAccelerationMin
    : false;
  const cautionByPrice = s.cautionAlert.priceChangeM5Min !== undefined
    ? priceChangeM5Abs >= s.cautionAlert.priceChangeM5Min
    : false;
  if (cautionByAccel || cautionByPrice) return 'CAUTION';

  if (
    va >= s.tradeRadarAlert.volumeAccelerationMin &&
    va < (s.tradeRadarAlert.volumeAccelerationMax ?? Infinity) &&
    priceChangeM5Abs < (s.tradeRadarAlert.priceChangeM5Max ?? Infinity)
  ) return 'TRADE_RADAR';

  if (
    va >= s.watchAlert.volumeAccelerationMin &&
    va < (s.watchAlert.volumeAccelerationMax ?? Infinity) &&
    priceChangeM5Abs < (s.watchAlert.priceChangeM5Max ?? Infinity)
  ) return 'WATCH';

  return null;
}

export function tierRank(t: AlertTier): number {
  switch (t) {
    case 'WATCH': return 1;
    case 'TRADE_RADAR': return 2;
    case 'CAUTION': return 3;
    case 'MONEY_FLOW_ANOMALY': return 4;
    case 'RUNNER': return 5;
    default: return 0;
  }
}
