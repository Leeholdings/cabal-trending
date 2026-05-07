/**
 * Format a Telegram alert message for a tiered anomaly.
 *
 * STATE / DELTA / MEANING / POSTURE pattern per the spec — gives the
 * recipient enough context to decide whether to act.
 */
import type { DexScreenerPair } from '../dexscreener/client.js';
import type { ScoreOutput } from '../scoring/engine.js';
import type { AlertTier } from '../scoring/tiers.js';
import type { MoneyFlowScore } from '../scoring/money_flow.js';
import { gmgnTokenUrl } from '../scoring/money_flow.js';
import { getConfig } from '../config/loader.js';

const fmtRange = (min: number, max: number): string => {
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(0)}M` : `$${(n / 1_000).toFixed(0)}K`;
  return `${fmt(min)}-${fmt(max)}`;
};

/** Escape user-supplied content for Telegram HTML parse mode.
 * Memecoin names often contain &, <, >, etc. which break HTML parsing.
 */
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#39;');

const fmtUsd = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
};

const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

const fmtPrice = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  if (n < 1)      return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
};

const tierEmoji = (t: AlertTier): string => {
  switch (t) {
    case 'WATCH':              return '👀';
    case 'TRADE_RADAR':        return '🎯';
    case 'CAUTION':            return '⚠️';
    case 'MONEY_FLOW_ANOMALY': return '🔥';
    default:                   return 'ℹ️';
  }
};

const tierStateLine = (t: AlertTier, marketCap: number | null | undefined): string => {
  const s = getConfig().strategy;
  const cap = marketCap ?? 0;
  const inRange = cap >= s.marketCapMin && cap <= s.marketCapMax;
  const rangeText = fmtRange(s.marketCapMin, s.marketCapMax);
  const range = inRange ? `within the ${rangeText} range` : `outside the ${rangeText} range`;
  switch (t) {
    case 'WATCH':
      return `Token is ${range} with rising M5 volume.`;
    case 'TRADE_RADAR':
      return `Token is ${range} with strong volume acceleration and contained price movement.`;
    case 'CAUTION':
      return `Token is ${range} but volume / price has already accelerated past safe entry.`;
    default:
      return '';
  }
};

const tierDeltaLine = (score: ScoreOutput, priceChangeM5: number | null | undefined): string => {
  const va = score.volumeAcceleration.toFixed(2);
  const pc = priceChangeM5 !== null && priceChangeM5 !== undefined
    ? `${priceChangeM5 >= 0 ? '+' : ''}${priceChangeM5.toFixed(1)}%`
    : '—';
  return `Volume increased ${va}x, price moved ${pc} in the last 5 minutes.`;
};

const tierMeaningLine = (t: AlertTier): string => {
  switch (t) {
    case 'WATCH':       return 'Early volume ignition — possible staging before a move.';
    case 'TRADE_RADAR': return 'Pre-expansion behavior — strong volume into compressed price.';
    case 'CAUTION':     return 'Likely late / attention phase — risk of buying the top.';
    default:            return '';
  }
};

const tierPostureLine = (t: AlertTier): string => {
  switch (t) {
    case 'WATCH':       return 'Add to watchlist; size only on confirmation.';
    case 'TRADE_RADAR': return 'Worth investigating; verify liquidity and team risk before any action.';
    case 'CAUTION':     return 'Avoid chasing. If holding, plan your exit, not a fresh entry.';
    default:            return '';
  }
};

export interface FormattedAlert {
  text: string;
  parseMode: 'HTML';
}

export function formatAlert(args: {
  tier: AlertTier;
  pair: DexScreenerPair;
  score: ScoreOutput;
}): FormattedAlert {
  const { tier, pair, score } = args;
  const sym  = escHtml(pair.baseToken?.symbol ?? '???');
  const name = escHtml(pair.baseToken?.name ?? '');
  const url  = escHtml(pair.url ?? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`);
  const pcM5 = pair.priceChange?.m5 ?? null;

  const lines: string[] = [];
  lines.push(`<b>${tierEmoji(tier)} ${tier} — ${sym}${name && name !== sym ? ` (${name})` : ''}</b>`);
  lines.push(`<a href="${url}">View on DexScreener</a>`);
  lines.push('');
  lines.push(`<b>Market Cap:</b> ${fmtUsd(pair.marketCap ?? pair.fdv)}`);
  lines.push(`<b>Liquidity:</b>  ${fmtUsd(pair.liquidity?.usd)}`);
  lines.push(`<b>Price:</b>      ${fmtPrice(pair.priceUsd)}`);
  lines.push(`<b>Vol Accel:</b>  ${score.volumeAcceleration.toFixed(2)}x`);
  lines.push(`<b>M5 Volume:</b>  ${fmtUsd(pair.volume?.m5)}`);
  lines.push(`<b>M5 Price Δ:</b> ${fmtPct(pcM5)}`);
  lines.push(`<b>Buy Ratio:</b>  ${score.buyRatio !== null ? `${score.buyRatio.toFixed(0)}%` : '—'}`);
  lines.push(`<b>M5 Txns:</b>    ${(pair.txns?.m5?.buys ?? 0) + (pair.txns?.m5?.sells ?? 0)}`);
  lines.push(`<b>Anomaly Score:</b> ${score.overall.toFixed(1)} / 100`);
  lines.push('');
  lines.push(`<b>STATE:</b> ${tierStateLine(tier, pair.marketCap ?? pair.fdv)}`);
  lines.push(`<b>DELTA:</b> ${tierDeltaLine(score, pcM5)}`);
  lines.push(`<b>MEANING:</b> ${tierMeaningLine(tier)}`);
  lines.push(`<b>POSTURE:</b> ${tierPostureLine(tier)}`);
  lines.push('');
  lines.push('<i>observation only — not financial advice</i>');

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

/**
 * Format the MONEY_FLOW_ANOMALY alert. Different shape than the legacy tier
 * format — emphasizes the "WHY" with multiple bullet reasons, includes risk
 * flags inline, ranks the pair vs other current candidates, and ends with a
 * dev-check fallback (GMGN link, since paid APIs are off the table).
 */
export function formatMoneyFlowAlert(args: {
  pair: DexScreenerPair;
  score: MoneyFlowScore;
}): FormattedAlert {
  const { pair, score } = args;
  const sym  = escHtml(pair.baseToken?.symbol ?? '???');
  const name = escHtml(pair.baseToken?.name ?? '');
  const tokenAddress = pair.baseToken?.address ?? '';
  const url  = escHtml(pair.url ?? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`);
  const gmgnUrl = tokenAddress ? gmgnTokenUrl(tokenAddress) : null;
  const dexId = (pair.dexId ?? '').toLowerCase();
  const isPumpfun = dexId.includes('pumpfun') || dexId.includes('pump');
  const isPumpswap = dexId.includes('pumpswap');

  // Pair age display
  let ageStr = 'unknown age';
  if (pair.pairCreatedAt) {
    const ageDays = (Date.now() - pair.pairCreatedAt) / (24 * 60 * 60 * 1000);
    if (ageDays < 1) ageStr = `${(ageDays * 24).toFixed(1)}h old`;
    else if (ageDays < 30) ageStr = `${ageDays.toFixed(1)}d old`;
    else ageStr = `${(ageDays / 30).toFixed(1)}mo old`;
  }

  const lines: string[] = [];
  lines.push(`<b>🔥 MONEY_FLOW_ANOMALY — ${sym}${name && name !== sym ? ` (${name})` : ''}</b>`);
  lines.push(`<a href="${url}">View on DexScreener</a>`);
  lines.push('');
  lines.push(`<b>Score:</b>      <b>${score.overall.toFixed(1)} / 100</b>`
    + (score.rankBoost > 0 ? `  (base ${score.baseScore.toFixed(1)} + rank +${score.rankBoost})` : ''));
  lines.push(`<b>Market Cap:</b> ${fmtUsd(pair.marketCap ?? pair.fdv)}`);
  lines.push(`<b>Liquidity:</b>  ${fmtUsd(pair.liquidity?.usd)}`);
  lines.push(`<b>Price:</b>      ${fmtPrice(pair.priceUsd)}`);
  lines.push(`<b>Pair Age:</b>   ${ageStr}`);
  if (isPumpfun) lines.push(`<b>Launchpad:</b>  Pump.fun`);
  else if (isPumpswap) lines.push(`<b>DEX:</b>        PumpSwap`);
  else if (pair.dexId) lines.push(`<b>DEX:</b>        ${escHtml(pair.dexId)}`);
  lines.push('');

  // WHY block — explain the anomaly
  lines.push(`<b>WHY:</b>`);
  if (score.reasons.length === 0) {
    lines.push(`• Composite score crossed threshold without standout signal`);
  } else {
    for (const r of score.reasons) lines.push(`• ${escHtml(r)}`);
  }
  lines.push('');

  // Risk flags
  if (score.riskFlags.length > 0) {
    lines.push(`<b>⚠️ RISK FLAGS:</b>`);
    for (const f of score.riskFlags) lines.push(`• ${escHtml(f)}`);
    lines.push('');
  }

  // Component breakdown (compact)
  const c = score.components;
  lines.push(`<b>Component scores:</b>`);
  lines.push(`vol-exp ${c.relativeVolumeExpansion.toFixed(0)}  •  txn-exp ${c.transactionExpansion.toFixed(0)}  •  liq-conf ${c.liquidityConfirmation.toFixed(0)}  •  buy-pressure ${c.buyPressureQuality.toFixed(0)}`);
  lines.push(`sustain ${c.volumeSustainability.toFixed(0)}  •  price/vol ${c.priceVolumeRelationship.toFixed(0)}  •  mc-opp ${c.marketCapOpportunity.toFixed(0)}  •  age×${c.ageContextModifier.toFixed(2)}  •  -safety ${c.safetyPenalty.toFixed(0)}`);
  lines.push('');

  // Dev reputation check (manual fallback — no paid API)
  lines.push(`<b>DEV CHECK:</b> Unknown — verify manually`);
  if (gmgnUrl) {
    lines.push(`🔗 <a href="${escHtml(gmgnUrl)}">GMGN: dev wallet + holder analysis</a>`);
  }
  lines.push(`<i>Check deployer's prior launches. Serial launchers = high rug risk.</i>`);
  lines.push('');

  lines.push('<i>observation only — not financial advice</i>');

  return { text: lines.join('\n'), parseMode: 'HTML' };
}
