/**
 * Dedup rules for legacy tier alerts, MFA alerts, and RUNNER alerts.
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

  if (lastTier === 'CAUTION') {
    return ageMs >= cooldownMs;
  }

  if (tierRank(candidate) > tierRank(lastTier)) {
    return true;
  }

  return ageMs >= cooldownMs;
}

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
    return { fire: true, reason: 'cooldown elapsed' };
  }

  if (currentScore - lastScore >= escalation) {
    return { fire: true, reason: 'score escalated +' + (currentScore - lastScore).toFixed(1) };
  }

  return { fire: false, reason: 'cooldown active' };
}

/**
 * Runner dedup: simple per-pair cooldown.
 * Runners are slow trends, not spikes — once we've alerted, no point re-alerting
 * for many hours.
 */
export function shouldFireRunner(pairAddress: string): { fire: boolean; reason: string } {
  const cfg = getConfig().strategy.runner;
  if (!cfg) return { fire: true, reason: 'no runner config (default fire)' };

  const cooldownMs = cfg.cooldownMinutes * 60_000;
  const recent = recentAlertsForPair(pairAddress, 'RUNNER', 1);
  if (recent.length === 0) return { fire: true, reason: 'first RUNNER alert for this pair' };

  const last = recent[0]!;
  const ageMs = Date.now() - last.timestamp;
  if (ageMs >= cooldownMs) {
    return { fire: true, reason: 'cooldown elapsed (' + (ageMs / 60_000).toFixed(0) + ' min)' };
  }

  return { fire: false, reason: 'cooldown active (' + ((cooldownMs - ageMs) / 60_000).toFixed(0) + ' min remaining)' };
}
