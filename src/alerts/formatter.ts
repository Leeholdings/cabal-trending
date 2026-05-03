/**
 * Format a Telegram alert message for a tiered anomaly.
 *
 * STATE / DELTA / MEANING / POSTURE pattern per the spec — gives the
 * recipient enough context to decide whether to act.
 */
import type { DexScreenerPair } from '../dexscreener/client.js';
import type { ScoreOutput } from '../scoring/engine.js';
import type { AlertTier } from '../scoring/tiers.js';

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
    case 'WATCH':       return '👀';
    case 'TRADE_RADAR': return '🎯';
    case 'CAUTION':     return '⚠️';
    default:            return 'ℹ️';
  }
};

const tierStateLine = (t: AlertTier, marketCap: number | null | undefined): string => {
  const cap = marketCap ?? 0;
  const range = cap >= 500_000 && cap <= 3_000_000 ? 'within the $500K-$3M range' : 'outside our usual MC range';
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
  const sym  = pair.baseToken?.symbol ?? '???';
  const name = pair.baseToken?.name ?? '';
  const url  = pair.url ?? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
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
