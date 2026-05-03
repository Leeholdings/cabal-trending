/**
 * Anomaly scoring engine. Scores 0-100 across five dimensions then weights.
 *
 *   Volume acceleration       — current m5 vs rolling baseline
 *   Price compression         — high volume + low price change = positioning
 *   Liquidity vs volume       — high volume relative to TVL = activity spike
 *   Transaction acceleration  — txns rising vs baseline
 *   Buy/sell ratio            — ideal 45-65%, penalize extremes
 *
 * Returns ScoreOutput which the alert tier classifier consumes.
 *
 * NOTE: we do NOT simulate candle wicks — DexScreener REST doesn't expose them.
 */
import { getConfig } from '../config/loader.js';
import type { SnapshotRow } from '../db/snapshots.js';

export interface ScoreOutput {
  overall: number;           // 0..100
  volumeAcceleration: number; // ratio (e.g. 1.8 = 1.8x baseline)
  priceCompressionScore: number;
  liquidityMismatchScore: number;
  txnAccelerationScore: number;
  buyRatioScore: number;
  buyRatio: number | null;    // 0..100, null if no txns yet
}

const clip = (x: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, x));
const safeRatio = (num: number, den: number, fallback = 1): number => (den > 0 ? num / den : fallback);

/**
 * Pre-condition: `recent` is sorted by timestamp ASC. The last entry is the
 * current snapshot; earlier entries form the baseline.
 */
export function scoreAnomaly(recent: SnapshotRow[]): ScoreOutput {
  const cfg = getConfig().strategy;
  if (recent.length === 0) {
    return zeroScore();
  }
  const cur = recent[recent.length - 1]!;

  // --- Volume acceleration (current m5 vs baseline mean of prior m5 values) ---
  const prior = recent.slice(0, -1);
  const baselineM5s = prior.map((s) => s.volume_m5 ?? 0).filter((v) => v > 0);
  const baselineMean = baselineM5s.length
    ? baselineM5s.reduce((a, b) => a + b, 0) / baselineM5s.length
    : (cur.volume_m5 ?? 0);
  const curM5 = cur.volume_m5 ?? 0;
  const volAccel = baselineMean > 0 ? curM5 / baselineMean : (curM5 > 0 ? 1 : 0);

  // Map volAccel into 0-100. 1x = 0, 3x+ = 100.
  const volAccelScore = clip(((volAccel - 1) / 2) * 100);

  // --- Price compression: rising vol + low price move = staged accumulation ---
  const priceChangeM5 = Math.abs(cur.price_change_m5 ?? 0);
  // Compression score: high when volAccel > 1.5x AND price change < 10%.
  let compression = 0;
  if (volAccel >= 1.5) {
    const lowMoveBoost = clip((10 - priceChangeM5) / 10) * 100; // 0 if move >=10%
    compression = lowMoveBoost * Math.min(1, volAccel / 2);
  }
  const priceCompressionScore = clip(compression);

  // --- Liquidity vs volume mismatch: m5 vol / liquidity ---
  const liq = cur.liquidity_usd ?? 0;
  const liqRatio = liq > 0 ? curM5 / liq : 0;
  // 0.05 (5% of liq turning over in 5 min) = 100. 0 = 0.
  const liquidityMismatchScore = clip((liqRatio / 0.05) * 100);

  // --- Transaction acceleration ---
  const baselineTxns = prior.map((s) => s.txns_m5 ?? 0).filter((v) => v > 0);
  const baselineTxnsMean = baselineTxns.length
    ? baselineTxns.reduce((a, b) => a + b, 0) / baselineTxns.length
    : (cur.txns_m5 ?? 0);
  const curTxns = cur.txns_m5 ?? 0;
  const txnAccel = baselineTxnsMean > 0 ? curTxns / baselineTxnsMean : (curTxns > 0 ? 1 : 0);
  const txnAccelerationScore = clip(((txnAccel - 1) / 2) * 100);

  // --- Buy/sell ratio (ideal 45-65) ---
  const buys = cur.buys_m5 ?? 0;
  const sells = cur.sells_m5 ?? 0;
  const totalTxns = buys + sells;
  let buyRatio: number | null = null;
  let buyRatioScore = 0;
  if (totalTxns > 0) {
    buyRatio = (buys / totalTxns) * 100;
    if (buyRatio >= cfg.buyRatioIdealMin && buyRatio <= cfg.buyRatioIdealMax) {
      buyRatioScore = 100;
    } else {
      // Penalize linearly outside the band.
      const distLow  = cfg.buyRatioIdealMin - buyRatio;
      const distHigh = buyRatio - cfg.buyRatioIdealMax;
      const dist = Math.max(distLow, distHigh, 0);
      // Hit 0 by 30 pts outside the band.
      buyRatioScore = clip(100 - (dist / 30) * 100);
    }
  }

  // --- Weighted overall ---
  const overall = clip(
    volAccelScore           * 0.30 +
    priceCompressionScore   * 0.25 +
    liquidityMismatchScore  * 0.20 +
    txnAccelerationScore    * 0.15 +
    buyRatioScore           * 0.10,
  );

  return {
    overall: Number(overall.toFixed(1)),
    volumeAcceleration: Number(volAccel.toFixed(2)),
    priceCompressionScore: Number(priceCompressionScore.toFixed(1)),
    liquidityMismatchScore: Number(liquidityMismatchScore.toFixed(1)),
    txnAccelerationScore: Number(txnAccelerationScore.toFixed(1)),
    buyRatioScore: Number(buyRatioScore.toFixed(1)),
    buyRatio: buyRatio !== null ? Number(buyRatio.toFixed(1)) : null,
  };
}

function zeroScore(): ScoreOutput {
  return {
    overall: 0,
    volumeAcceleration: 0,
    priceCompressionScore: 0,
    liquidityMismatchScore: 0,
    txnAccelerationScore: 0,
    buyRatioScore: 0,
    buyRatio: null,
  };
}

// Re-export safeRatio so tests can use it if needed.
export { safeRatio };
