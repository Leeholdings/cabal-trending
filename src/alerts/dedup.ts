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
  if (lastTier === 'CAUTION') return ageMs >= cooldownMs;
  if (tierRank(candidate) > tierRank(lastTier)) return true;
  return ageMs >= cooldownMs;
}

export function shouldFireMoneyFlow(pairAddress: string, currentScore: number): { fire: boolean; reason: string } {
  const cfg = getConfig().strategy.moneyFlowAnomaly;
  if (!cfg) return { fire: true, reason: 'no config' };
  const cooldownMs = cfg.cooldownMinutes * 60_000;
  const recent = recentAlertsForPair(pairAddress, 'MONEY_FLOW_ANOMALY', 1);
  if (recent.length === 0) return { fire: true, reason: 'first alert' };
  const last = recent[0]!;
  const ageMs = Date.now() - last.timestamp;
  const lastScore = last.score ?? 0;
  if (ageMs >= cooldownMs) return { fire: true, reason: 'cooldown elapsed' };
  if (currentScore - lastScore >= cfg.escalationRefireScoreIncrease) return { fire: true, reason: 'score escalated' };
  return { fire: false, reason: 'cooldown active' };
}

export function shouldFireRunner(pairAddress: string): { fire: boolean; reason: string } {
  const cfg = getConfig().strategy.runner;
  if (!cfg) return { fire: true, reason: 'no config' };
  const cooldownMs = cfg.cooldownMinutes * 60_000;
  const recent = recentAlertsForPair(pairAddress, 'RUNNER', 1);
  if (recent.length === 0) return { fire: true, reason: 'first RUNNER alert' };
  const last = recent[0]!;
  const ageMs = Date.now() - last.timestamp;
  if (ageMs >= cooldownMs) return { fire: true, reason: 'cooldown elapsed' };
  return { fire: false, reason: 'cooldown active' };
}
