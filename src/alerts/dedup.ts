/**
 * Cooldown + escalation rules:
 *   - No duplicate same-tier alerts within `duplicateAlertCooldownMinutes`.
 *   - Escalation always fires (WATCH -> TRADE_RADAR -> CAUTION).
 *   - Once a pair has CAUTION, suppress all further bullish-bias alerts
 *     (WATCH / TRADE_RADAR) for the cooldown window — only re-CAUTION
 *     after cooldown expires.
 */
import { getConfig } from '../config/loader.js';
import { lastAlertForPair, recentAlertsForPair } from '../db/snapshots.js';
import { tierRank, type AlertTier } from '../scoring/tiers.js';

export function shouldFire(pairAddress: string, candidate: AlertTier): boolean {
  if (!candidate) return false;
  const cfg = getConfig().strategy;
  const cooldownMs = cfg.duplicateAlertCooldownMinutes * 60_000;

  const last = lastAlertForPair(pairAddress);
  if (!last) return true;

  const ageMs = Date.now() - last.timestamp;
  const lastTier = last.tier as AlertTier;

  // CAUTION suppression: if the most recent alert was CAUTION, suppress all
  // bullish-bias (WATCH / TRADE_RADAR) within the cooldown.
  if (lastTier === 'CAUTION') {
    if (candidate === 'CAUTION') {
      return ageMs >= cooldownMs;
    }
    return ageMs >= cooldownMs;  // also gate same-pair anything else
  }

  // Escalation: a strictly higher tier always fires (no cooldown gating).
  if (tierRank(candidate) > tierRank(lastTier)) {
    return true;
  }

  // Same or lower tier — gate by cooldown.
  return ageMs >= cooldownMs;
}

/**
 * MONEY_FLOW_ANOMALY-specific dedup. Two ways to fire:
 *   1. No prior alert OR prior alert older than cooldownMinutes
 *   2. Score has increased by >= escalationRefireScoreIncrease vs the most
 *      recent prior alert (intensity escalation re-fires immediately)
 */
export function shouldFireMoneyFlow(pairAddress: string, currentScore: number): {
  fire: boolean;
  reason: string;
} {
  const cfg = getConfig().strategy.moneyFlowAnomaly;
  if (!cfg) return { fire: true, reason: 'no money-flow config (default fire)' };

  const cooldownMs = cfg.cooldownMinutes * 60_000;
  const escalation = cfg.escalationRefireScoreIncrease;

  const recent = recentAlertsForPair(pairAddress, 'MONEY_FLOW_ANOMALY', 1);
  if (recent.length === 0) return { fire: true, reason: 'first money-flow alert for this pair' };

  const last = recent[0]!;
  const ageMs = Date.now() - last.timestamp;
  const lastScore = last.score ?? 0;

  if (ageMs >= cooldownMs) {
    return { fire: true, reason: `cooldown elapsed (${(ageMs / 60_000).toFixed(0)} min)` };
  }

  if (currentScore - lastScore >= escalation) {
    return {
      fire: true,
      reason: `score escalated +${(currentScore - lastScore).toFixed(1)} vs prior alert ${lastScore.toFixed(1)}`,
    };
  }

  return {
    fire: false,
    reason: `cooldown active (${((cooldownMs - ageMs) / 60_000).toFixed(0)} min remaining), score delta +${(currentScore - lastScore).toFixed(1)} < threshold`,
  };
}
