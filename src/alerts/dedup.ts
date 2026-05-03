/**
 * Cooldown + escalation rules:
 *   - No duplicate same-tier alerts within `duplicateAlertCooldownMinutes`.
 *   - Escalation always fires (WATCH -> TRADE_RADAR -> CAUTION).
 *   - Once a pair has CAUTION, suppress all further bullish-bias alerts
 *     (WATCH / TRADE_RADAR) for the cooldown window — only re-CAUTION
 *     after cooldown expires.
 */
import { getConfig } from '../config/loader.js';
import { lastAlertForPair } from '../db/snapshots.js';
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
