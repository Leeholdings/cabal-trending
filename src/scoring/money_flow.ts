/**
 * MONEY_FLOW_ANOMALY scorer.
 *
 * Philosophy: this is a RADAR, not a filter. Score every pair on a
 * 0-100 confidence scale based on how abnormal current money flow looks
 * vs the pair's own recent baseline. Hard-reject only on obvious trash.
 *
 * Then a separate cross-pair ranking pass boosts the leaders of the current
 * scan so we surface "where money is concentrating RIGHT NOW relative to
 * the rest of the Solana memecoin market."
 */
import type { SnapshotRow } from '../db/snapshots.js';
import type { DexScreenerPair } from '../dexscreener/client.js';
import { getConfig } from '../config/loader.js';

export interface MoneyFlowComponents {
  relativeVolumeExpansion: number;
  transactionExpansion: number;
  liquidityConfirmation: number;
  buyPressureQuality: number;
  volumeSustainability: number;
  marketCapOpportunity: number;
  priceVolumeRelationship: number;
  ageContextModifier: number;
  safetyPenalty: number;
}

export interface MoneyFlowScore {
  overall: number;
  baseScore: number;
  rankBoost: number;
  components: MoneyFlowComponents;
  reasons: string[];
  riskFlags: string[];
  hardReject: boolean;
  rejectReason?: string;
  volRatio: number;
  txnRatio: number;
  liqRatio: number;
  buyRatio: number;
  sustainabilityRatio: number;
  priceChangeM5Abs: number;
}

const clip = (x: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, x));

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function rejectScore(reason: string): MoneyFlowScore {
  return {
    overall: 0, baseScore: 0, rankBoost: 0,
    components: {
      relativeVolumeExpansion: 0, transactionExpansion: 0, liquidityConfirmation: 0,
      buyPressureQuality: 0, volumeSustainability: 0, marketCapOpportunity: 0,
      priceVolumeRelationship: 0, ageContextModifier: 0, safetyPenalty: 0,
    },
    reasons: [], riskFlags: [], hardReject: true, rejectReason: reason,
    volRatio: 0, txnRatio: 0, liqRatio: 0, buyRatio: 0,
    sustainabilityRatio: 0, priceChangeM5Abs: 0,
  };
}

export function scoreMoneyFlow(
  snapshots: SnapshotRow[],
  pair: DexScreenerPair,
): MoneyFlowScore {
  const cfg = getConfig().strategy.moneyFlowAnomaly;
  const reasons: string[] = [];
  const riskFlags: string[] = [];

  const liq = pair.liquidity?.usd ?? 0;
  const m5Vol = pair.volume?.m5 ?? 0;
  const m5Buys = pair.txns?.m5?.buys ?? 0;
  const m5Sells = pair.txns?.m5?.sells ?? 0;
  const m5TxnTotal = m5Buys + m5Sells;
  const h24Buys = pair.txns?.h24?.buys ?? 0;
  const h24Sells = pair.txns?.h24?.sells ?? 0;
  const h24TxnTotal = h24Buys + h24Sells;
  const priceUsd = Number(pair.priceUsd ?? 0);

  const minLiqHard = cfg?.minLiquidityHardReject ?? 5000;
  if (liq < minLiqHard) return rejectScore(`liquidity $${liq.toFixed(0)} < hard-floor $${minLiqHard}`);
  if (priceUsd <= 0) return rejectScore('no price data');
  if (h24TxnTotal === 0) return rejectScore('zero txns past 24h');

  const minM5Vol = cfg?.minM5VolumeUsd ?? 0;
  if (minM5Vol > 0 && m5Vol < minM5Vol) {
    return rejectScore(`M5 vol $${m5Vol.toFixed(0)} < hard-floor $${minM5Vol}`);
  }
  const minM5TxFloor = cfg?.minM5Txns ?? 0;
  if (minM5TxFloor > 0 && m5TxnTotal < minM5TxFloor) {
    return rejectScore(`M5 txns ${m5TxnTotal} < hard-floor ${minM5TxFloor}`);
  }

  if (snapshots.length >= 2) {
    const prior = snapshots[snapshots.length - 2]!;
    const priorLiq = prior.liquidity_usd ?? 0;
    if (priorLiq > 0) {
      const dropPct = ((priorLiq - liq) / priorLiq) * 100;
      const maxDrop = cfg?.maxLiquidityDropPct ?? 30;
      if (dropPct >= maxDrop) {
        return rejectScore(`liquidity dropped ${dropPct.toFixed(1)}% (rug in progress?)`);
      }
    }
  }

  const volLiqRatio = liq > 0 ? m5Vol / liq : 0;
  const maxVolLiq = cfg?.maxM5VolumeLiquidityRatio ?? 1.5;
  if (volLiqRatio > maxVolLiq) {
    return rejectScore(`vol/liq ${volLiqRatio.toFixed(2)}x impossible legitimately`);
  }

  const buyRatio = m5TxnTotal > 0 ? (m5Buys / m5TxnTotal) * 100 : 50;
  if (m5Vol > 1000 && (buyRatio >= 97 || buyRatio <= 3)) {
    return rejectScore(`extreme buy ratio ${buyRatio.toFixed(0)}% with $${m5Vol.toFixed(0)} vol`);
  }

  const m5VolHistory = snapshots.map((s) => s.volume_m5 ?? 0).filter((v) => v > 0);
  const m5Median = m5VolHistory.length > 0 ? median(m5VolHistory) : m5Vol;
  const volRatio = m5Median > 0 ? m5Vol / m5Median : (m5Vol > 0 ? 1 : 0);
  let relVolScore = clip(((volRatio - 1) / 5) * 100);

  if (snapshots.length >= 4) {
    const recent3 = snapshots.slice(-4, -1).map((s) => s.volume_m5 ?? 0);
    const sustainedHigh = recent3.filter((v) => m5Median > 0 && v > m5Median * 2.0).length;
    if (sustainedHigh >= 2) {
      relVolScore = clip(relVolScore + 10);
      reasons.push(`Volume ${volRatio.toFixed(2)}x baseline, sustained across ${sustainedHigh + 1} buckets`);
    } else if (volRatio > 2.0) {
      reasons.push(`Volume ${volRatio.toFixed(2)}x baseline (single spike)`);
    }
  } else if (volRatio > 2.0) {
    reasons.push(`Volume ${volRatio.toFixed(2)}x baseline (limited history)`);
  }

  const txnHistory = snapshots.map((s) => s.txns_m5 ?? 0).filter((v) => v > 0);
  const txnMedian = txnHistory.length > 0 ? median(txnHistory) : m5TxnTotal;
  const txnRatio = txnMedian > 0 ? m5TxnTotal / txnMedian : (m5TxnTotal > 0 ? 1 : 0);
  const txnExpScore = clip(((txnRatio - 1) / 4) * 100);
  if (txnRatio > 2.0) {
    reasons.push(`Txns ${txnRatio.toFixed(2)}x baseline (${m5TxnTotal} now vs ${txnMedian.toFixed(0)} median)`);
  }

  const liqHistory = snapshots.map((s) => s.liquidity_usd ?? 0).filter((v) => v > 0);
  const liqMedian = liqHistory.length > 0 ? median(liqHistory) : liq;
  const liqRatio = liqMedian > 0 ? liq / liqMedian : 1;
  let liqConfScore: number;
  if (liqRatio >= 1.05) {
    liqConfScore = 100;
    reasons.push(`Liquidity grew ${((liqRatio - 1) * 100).toFixed(0)}% vs baseline (real participation)`);
  } else if (liqRatio >= 0.98) {
    liqConfScore = 80;
  } else if (liqRatio >= 0.90) {
    liqConfScore = 50;
    riskFlags.push(`Liquidity slightly dropping (${((liqRatio - 1) * 100).toFixed(1)}%)`);
  } else {
    liqConfScore = 20;
    riskFlags.push(`Liquidity dropped ${((1 - liqRatio) * 100).toFixed(0)}% vs baseline`);
  }

  let buyPressureScore: number;
  if (m5TxnTotal === 0) {
    buyPressureScore = 30;
  } else if (buyRatio < 40) {
    buyPressureScore = 30;
  } else if (buyRatio < 50) {
    buyPressureScore = 50;
  } else if (buyRatio < 60) {
    buyPressureScore = 75;
  } else if (buyRatio < 75) {
    buyPressureScore = 95;
    reasons.push(`Buy pressure ${buyRatio.toFixed(0)}% (healthy aggressive)`);
  } else if (buyRatio < 85) {
    buyPressureScore = 70;
    reasons.push(`Buy pressure ${buyRatio.toFixed(0)}% (very strong)`);
  } else if (buyRatio < 95) {
    buyPressureScore = 40;
    riskFlags.push(`Buy ratio ${buyRatio.toFixed(0)}% looks bot-driven`);
  } else {
    buyPressureScore = 10;
    riskFlags.push(`Buy ratio ${buyRatio.toFixed(0)}% — likely bot pump`);
  }

  const volH1 = pair.volume?.h1 ?? 0;
  const volH6 = pair.volume?.h6 ?? 0;
  const expectedH1Rate = volH6 / 6;
  const sustRatio = expectedH1Rate > 0 ? volH1 / expectedH1Rate : (volH1 > 0 ? 1 : 0);
  let sustScore: number;
  if (sustRatio >= 3.5) {
    sustScore = 100;
    reasons.push(`H1 vol ${sustRatio.toFixed(1)}x H6 avg rate (strong acceleration)`);
  } else if (sustRatio >= 2.0) {
    sustScore = 75;
    reasons.push(`H1 vol ${sustRatio.toFixed(1)}x H6 avg rate`);
  } else if (sustRatio >= 1.2) {
    sustScore = 40;
  } else {
    sustScore = 15;
  }

  const cap = pair.marketCap ?? pair.fdv ?? 0;
  let mcOpp: number;
  if (cap < 100_000)         mcOpp = 30;
  else if (cap < 200_000)    mcOpp = 50;
  else if (cap < 500_000)    mcOpp = 70;
  else if (cap <= 5_000_000) mcOpp = 100;
  else if (cap <= 15_000_000) mcOpp = 80;
  else if (cap <= 50_000_000) mcOpp = 50;
  else                        mcOpp = 30;

  const priceChangeM5 = Math.abs(pair.priceChange?.m5 ?? 0);
  let pvScore: number;
  if (volRatio >= 2.0 && priceChangeM5 < 5) {
    pvScore = 100;
    reasons.push(`Price compressed (${priceChangeM5.toFixed(1)}%) while volume expanded — staging signature`);
  } else if (volRatio >= 2.0 && priceChangeM5 < 12) {
    pvScore = 75;
    reasons.push(`Price beginning to respond (${priceChangeM5.toFixed(1)}%) with volume`);
  } else if (volRatio >= 2.0 && priceChangeM5 < 25) {
    pvScore = 45;
    reasons.push(`Price moving (${priceChangeM5.toFixed(1)}%) — mid-move`);
  } else if (volRatio >= 2.0) {
    pvScore = 20;
    riskFlags.push(`Price already moved ${priceChangeM5.toFixed(0)}% — late entry risk`);
  } else {
    pvScore = 25;
  }

  let ageMod = 1.0;
  if (pair.pairCreatedAt) {
    const ageDays = (Date.now() - pair.pairCreatedAt) / (24 * 60 * 60 * 1000);
    if (ageDays < 1)        ageMod = 1.10;
    else if (ageDays < 7)   ageMod = 1.20;
    else if (ageDays < 30)  ageMod = 1.00;
    else if (ageDays < 180) ageMod = 0.95;
    else                    ageMod = 0.85;
  }

  let safetyPenalty = 0;
  if (volLiqRatio > 0.5)                    safetyPenalty += 10;
  if (liqRatio < 0.95)                      safetyPenalty += 5;
  if (buyRatio >= 90 || buyRatio <= 10)     safetyPenalty += 10;
  if (volLiqRatio > 0.5)                    riskFlags.push(`Vol/liq ratio ${volLiqRatio.toFixed(2)}x — suspicious`);
  safetyPenalty = Math.min(30, safetyPenalty);

  const baseRaw =
    relVolScore         * 0.25 +
    txnExpScore         * 0.15 +
    liqConfScore        * 0.10 +
    buyPressureScore    * 0.15 +
    sustScore           * 0.15 +
    mcOpp               * 0.05 +
    pvScore             * 0.15;
  const baseScore = clip(baseRaw * ageMod);

  const overall = clip(baseScore - safetyPenalty);

  return {
    overall: Number(overall.toFixed(1)),
    baseScore: Number(baseScore.toFixed(1)),
    rankBoost: 0,
    components: {
      relativeVolumeExpansion: Number(relVolScore.toFixed(1)),
      transactionExpansion:    Number(txnExpScore.toFixed(1)),
      liquidityConfirmation:   Number(liqConfScore.toFixed(1)),
      buyPressureQuality:      Number(buyPressureScore.toFixed(1)),
      volumeSustainability:    Number(sustScore.toFixed(1)),
      marketCapOpportunity:    Number(mcOpp.toFixed(1)),
      priceVolumeRelationship: Number(pvScore.toFixed(1)),
      ageContextModifier:      Number(ageMod.toFixed(2)),
      safetyPenalty:           Number(safetyPenalty.toFixed(1)),
    },
    reasons, riskFlags, hardReject: false,
    volRatio: Number(volRatio.toFixed(2)),
    txnRatio: Number(txnRatio.toFixed(2)),
    liqRatio: Number(liqRatio.toFixed(2)),
    buyRatio: Number(buyRatio.toFixed(1)),
    sustainabilityRatio: Number(sustRatio.toFixed(2)),
    priceChangeM5Abs: Number(priceChangeM5.toFixed(1)),
  };
}

export function applyRankBoost(
  scoredPairs: Array<{ pair: DexScreenerPair; score: MoneyFlowScore }>,
): void {
  const cfg = getConfig().strategy.moneyFlowAnomaly;
  const topPercent = cfg?.rankBoostTopPercent ?? 10;
  const boostAmount = cfg?.rankBoostAmount ?? 5;
  const minBase = cfg?.rankBoostMinBase ?? 60;

  const valid = scoredPairs.filter((sp) => !sp.score.hardReject);
  if (valid.length === 0) return;

  valid.sort((a, b) => b.score.overall - a.score.overall);

  const topNTop = Math.max(1, Math.ceil(valid.length * (topPercent / 100)));
  const topNUltra = Math.max(1, Math.ceil(valid.length * 0.03));

  for (let i = 0; i < valid.length; i++) {
    const sp = valid[i]!;
    const rank = i + 1;
    if (sp.score.overall < minBase) continue;
    if (i < topNUltra) {
      sp.score.rankBoost = boostAmount * 2;
      sp.score.reasons.push(`Top 3% of current scan (rank #${rank}/${valid.length}) — money concentrating here`);
    } else if (i < topNTop) {
      sp.score.rankBoost = boostAmount;
      sp.score.reasons.push(`Top ${topPercent}% of current scan (rank #${rank}/${valid.length})`);
    }
    sp.score.overall = Number(clip(sp.score.overall + sp.score.rankBoost).toFixed(1));
  }
}

export function gmgnTokenUrl(tokenAddress: string): string {
  return `https://gmgn.ai/sol/token/${tokenAddress}`;
}
