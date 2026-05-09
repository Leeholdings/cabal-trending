/**
 * Telegram alert formatters: legacy tiered, money-flow, and runner.
 */
import type { DexScreenerPair } from '../dexscreener/client.js';
import type { ScoreOutput } from '../scoring/engine.js';
import type { AlertTier } from '../scoring/tiers.js';
import type { MoneyFlowScore } from '../scoring/money_flow.js';
import type { RunnerSignal } from '../scoring/runner.js';
import { gmgnTokenUrl } from '../scoring/runner.js';
import { getConfig } from '../config/loader.js';

const fmtRange = (min: number, max: number): string => {
  const fmt = (n: number) =>
    n >= 1_000_000 ? '$' + (n / 1_000_000).toFixed(0) + 'M' : '$' + (n / 1_000).toFixed(0) + 'K';
  return fmt(min) + '-' + fmt(max);
};

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#39;');

const fmtUsd = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return '$' + (v / 1_000).toFixed(1) + 'K';
  return '$' + v.toFixed(2);
};

const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

const fmtPrice = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  if (n < 0.0001) return '$' + n.toExponential(2);
  if (n < 1)      return '$' + n.toFixed(6);
  return '$' + n.toFixed(4);
};

const tierEmoji = (t: AlertTier): string => {
  switch (t) {
    case 'WATCH':              return '👀';
    case 'TRADE_RADAR':        return '🎯';
    case 'CAUTION':            return '⚠️';
    case 'MONEY_FLOW_ANOMALY': return '🔥';
    case 'RUNNER':             return '🚀';
    default:                   return 'ℹ️';
  }
};

const tierStateLine = (t: AlertTier, marketCap: number | null | undefined): string => {
  const s = getConfig().strategy;
  const cap = marketCap ?? 0;
  const inRange = cap >= s.marketCapMin && cap <= s.marketCapMax;
  const rangeText = fmtRange(s.marketCapMin, s.marketCapMax);
  const range = inRange ? 'within the ' + rangeText + ' range' : 'outside the ' + rangeText + ' range';
  switch (t) {
    case 'WATCH':       return 'Token is ' + range + ' with rising M5 volume.';
    case 'TRADE_RADAR': return 'Token is ' + range + ' with strong volume acceleration and contained price movement.';
    case 'CAUTION':     return 'Token is ' + range + ' but volume / price has already accelerated past safe entry.';
    default:            return '';
  }
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
  const url  = escHtml(pair.url ?? 'https://dexscreener.com/' + pair.chainId + '/' + pair.pairAddress);
  const pcM5 = pair.priceChange?.m5 ?? null;

  const va = score.volumeAcceleration.toFixed(2);
  const pcText = pcM5 !== null && pcM5 !== undefined
    ? (pcM5 >= 0 ? '+' : '') + pcM5.toFixed(1) + '%' : '—';
  const deltaLine = 'Volume increased ' + va + 'x, price moved ' + pcText + ' in the last 5 minutes.';

  const lines: string[] = [];
  lines.push('<b>' + tierEmoji(tier) + ' ' + tier + ' — ' + sym + (name && name !== sym ? ' (' + name + ')' : '') + '</b>');
  lines.push('<a href="' + url + '">View on DexScreener</a>');
  lines.push('');
  lines.push('<b>Market Cap:</b> ' + fmtUsd(pair.marketCap ?? pair.fdv));
  lines.push('<b>Liquidity:</b>  ' + fmtUsd(pair.liquidity?.usd));
  lines.push('<b>Price:</b>      ' + fmtPrice(pair.priceUsd));
  lines.push('<b>Vol Accel:</b>  ' + score.volumeAcceleration.toFixed(2) + 'x');
  lines.push('<b>M5 Volume:</b>  ' + fmtUsd(pair.volume?.m5));
  lines.push('<b>M5 Price Δ:</b> ' + fmtPct(pcM5));
  lines.push('<b>Buy Ratio:</b>  ' + (score.buyRatio !== null ? score.buyRatio.toFixed(0) + '%' : '—'));
  lines.push('<b>M5 Txns:</b>    ' + ((pair.txns?.m5?.buys ?? 0) + (pair.txns?.m5?.sells ?? 0)));
  lines.push('<b>Anomaly Score:</b> ' + score.overall.toFixed(1) + ' / 100');
  lines.push('');
  lines.push('<b>STATE:</b> ' + tierStateLine(tier, pair.marketCap ?? pair.fdv));
  lines.push('<b>DELTA:</b> ' + deltaLine);
  lines.push('<b>MEANING:</b> ' + tierMeaningLine(tier));
  lines.push('<b>POSTURE:</b> ' + tierPostureLine(tier));
  lines.push('');
  lines.push('<i>observation only — not financial advice</i>');

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

export function formatMoneyFlowAlert(args: {
  pair: DexScreenerPair;
  score: MoneyFlowScore;
}): FormattedAlert {
  const { pair, score } = args;
  const sym  = escHtml(pair.baseToken?.symbol ?? '???');
  const name = escHtml(pair.baseToken?.name ?? '');
  const tokenAddress = pair.baseToken?.address ?? '';
  const url  = escHtml(pair.url ?? 'https://dexscreener.com/' + pair.chainId + '/' + pair.pairAddress);
  const gUrl = tokenAddress ? gmgnTokenUrl(tokenAddress) : null;

  const lines: string[] = [];
  lines.push('<b>🔥 MONEY_FLOW_ANOMALY — ' + sym + (name && name !== sym ? ' (' + name + ')' : '') + '</b>');
  lines.push('<a href="' + url + '">View on DexScreener</a>');
  lines.push('');
  lines.push('<b>Score:</b>      <b>' + score.overall.toFixed(1) + ' / 100</b>');
  lines.push('<b>Market Cap:</b> ' + fmtUsd(pair.marketCap ?? pair.fdv));
  lines.push('<b>Liquidity:</b>  ' + fmtUsd(pair.liquidity?.usd));
  lines.push('<b>Price:</b>      ' + fmtPrice(pair.priceUsd));
  lines.push('');
  lines.push('<b>WHY:</b>');
  if (score.reasons.length === 0) lines.push('• Composite score crossed threshold');
  else for (const r of score.reasons) lines.push('• ' + escHtml(r));
  lines.push('');
  if (score.riskFlags.length > 0) {
    lines.push('<b>⚠️ RISK FLAGS:</b>');
    for (const f of score.riskFlags) lines.push('• ' + escHtml(f));
    lines.push('');
  }
  if (gUrl) lines.push('🔗 <a href="' + escHtml(gUrl) + '">GMGN: dev wallet + holder analysis</a>');
  lines.push('');
  lines.push('<i>observation only — not financial advice</i>');

  return { text: lines.join('\n'), parseMode: 'HTML' };
}

/**
 * RUNNER alert — formatted for the multi-day accumulation pattern.
 * Different feel than MFA: emphasizes "this LOOKS like a runner setup",
 * not "this is anomalous right now".
 */
export function formatRunnerAlert(args: {
  pair: DexScreenerPair;
  signal: RunnerSignal;
}): FormattedAlert {
  const { pair, signal } = args;
  const sym  = escHtml(pair.baseToken?.symbol ?? '???');
  const name = escHtml(pair.baseToken?.name ?? '');
  const tokenAddress = pair.baseToken?.address ?? '';
  const url  = escHtml(pair.url ?? 'https://dexscreener.com/' + pair.chainId + '/' + pair.pairAddress);
  const gUrl = tokenAddress ? gmgnTokenUrl(tokenAddress) : null;

  const lines: string[] = [];
  lines.push('<b>🚀 RUNNER candidate — ' + sym + (name && name !== sym ? ' (' + name + ')' : '') + '</b>');
  lines.push('<a href="' + url + '">View on DexScreener</a>');
  lines.push('');
  lines.push('<b>Market Cap:</b> ' + fmtUsd(signal.marketCap) + '   <i>(sweet spot for 10-100x)</i>');
  lines.push('<b>Liquidity:</b>  ' + fmtUsd(signal.liquidityUsd)
             + (signal.liquidityGrowthPct > 0 ? ' (+' + signal.liquidityGrowthPct.toFixed(1) + '% over scan)' : ''));
  lines.push('<b>Pair Age:</b>   ' + signal.ageDays.toFixed(1) + 'd');
  lines.push('<b>Price:</b>      ' + fmtPrice(pair.priceUsd));
  lines.push('<b>DEX:</b>        ' + escHtml(signal.dexId));
  lines.push('');
  lines.push('<b>WHY THIS LOOKS LIKE A RUNNER:</b>');
  for (const r of signal.reasons) lines.push('• ' + escHtml(r));
  lines.push('');
  lines.push('<b>DEV CHECK:</b> Unknown — verify manually before any conviction');
  if (gUrl) lines.push('🔗 <a href="' + escHtml(gUrl) + '">GMGN: dev wallet + holder analysis</a>');
  lines.push('');
  lines.push('<i>⚠ Runner pattern, NOT a guarantee. ~10-20% historical hit rate. Observation only — not financial advice.</i>');

  return { text: lines.join('\n'), parseMode: 'HTML' };
}
