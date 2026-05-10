import type { SnapshotRow } from '../db/snapshots.js';
import type { DexScreenerPair } from '../dexscreener/client.js';
import { getConfig } from '../config/loader.js';

export interface MoneyFlowComponents {
  relativeVolumeExpansion: number; transactionExpansion: number;
  liquidityConfirmation: number; buyPressureQuality: number;
  volumeSustainability: number; marketCapOpportunity: number;
  priceVolumeRelationship: number; ageContextModifier: number; safetyPenalty: number;
}

export interface MoneyFlowScore {
  overall: number; baseScore: number; rankBoost: number;
  components: MoneyFlowComponents;
  reasons: string[]; riskFlags: string[];
  hardReject: boolean; rejectReason?: string;
  volRatio: number; txnRatio: number; liqRatio: number; buyRatio: number;
  sustainabilityRatio: number; priceChangeM5Abs: number;
}

const clip = (x: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, x));

function rejectScore(reason: string): MoneyFlowScore {
  return {
    overall: 0, baseScore: 0, rankBoost: 0,
    components: { relativeVolumeExpansion: 0, transactionExpansion: 0, liquidityConfirmation: 0, buyPressureQuality: 0, volumeSustainability: 0, marketCapOpportunity: 0, priceVolumeRelationship: 0, ageContextModifier: 0, safetyPenalty: 0 },
    reasons: [], riskFlags: [], hardReject: true, rejectReason: reason,
    volRatio: 0, txnRatio: 0, liqRatio: 0, buyRatio: 0, sustainabilityRatio: 0, priceChangeM5Abs: 0,
  };
}

// Legacy MFA scorer kept for archival/disabled path. Always returns a hard reject when called.
export function scoreMoneyFlow(_snapshots: SnapshotRow[], _pair: DexScreenerPair): MoneyFlowScore {
  return rejectScore('MFA disabled - replaced by RUNNER detector');
}

export function applyRankBoost(_scoredPairs: Array<{ pair: DexScreenerPair; score: MoneyFlowScore }>): void {
  // no-op when MFA disabled
}

export function gmgnTokenUrl(tokenAddress: string): string {
  return 'https://gmgn.ai/sol/token/' + tokenAddress;
}
