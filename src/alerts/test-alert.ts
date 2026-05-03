/**
 * Manual end-to-end test of the Telegram path.
 * Run with: npm run test-alert
 */
import { formatAlert } from './formatter.js';
import { sendTelegramMessage, isTelegramConfigured } from './telegram.js';
import { log } from '../util/logger.js';

async function main(): Promise<void> {
  if (!isTelegramConfigured()) {
    log.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
    process.exit(1);
  }
  const fakePair = {
    chainId: 'solana',
    pairAddress: 'TEST_PAIR_ADDRESS',
    baseToken:  { address: 'TEST_BASE',  symbol: 'TEST', name: 'Test Token' },
    quoteToken: { address: 'SOL_QUOTE', symbol: 'SOL', name: 'Solana' },
    priceUsd: '0.000123',
    liquidity: { usd: 75_000 },
    volume:    { m5: 18_000, h1: 95_000, h6: 380_000, h24: 720_000 },
    priceChange: { m5: 3.2, h1: 8.5 },
    txns: { m5: { buys: 65, sells: 50 }, h24: { buys: 0, sells: 0 } },
    marketCap: 1_400_000,
    fdv: 1_500_000,
    pairCreatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    url: 'https://dexscreener.com/solana/TEST',
  };
  const fakeScore = {
    overall: 71.4,
    volumeAcceleration: 2.05,
    priceCompressionScore: 78,
    liquidityMismatchScore: 48,
    txnAccelerationScore: 62,
    buyRatioScore: 90,
    buyRatio: 56,
  };
  const msg = formatAlert({ tier: 'TRADE_RADAR', pair: fakePair, score: fakeScore });
  const ok = await sendTelegramMessage(msg);
  if (ok) log.info('Test alert sent OK — check your Telegram channel');
  else    log.error('Test alert failed');
}

main().catch((e) => {
  log.error('test-alert crashed', { err: (e as Error).message });
  process.exit(1);
});
