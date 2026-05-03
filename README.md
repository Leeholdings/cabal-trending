# cabal-trending

Solana memecoin **volume-anomaly scanner** with Telegram alerts.

Polls DexScreener every 15-30 seconds for pairs in the $500K-$3M market cap
range. Stores time-series snapshots locally. Scores each pair on five
anomaly dimensions. Sends tiered alerts (WATCH / TRADE_RADAR / CAUTION) to
your private Telegram channel when something interesting fires.

**Observation only. There is no trading code in this project.**

## Quick start

### 1. Install dependencies

```
npm install
```

### 2. Create your Telegram bot + channel

a. In Telegram, search **@BotFather** (blue checkmark). Send `/newbot`,
   pick a name and username (must end in `bot`). Save the bot token it gives you.

b. Tap pencil icon → **New Channel**. Name it (e.g. "CABAL Trending"),
   set type to **Private**, skip adding members.

c. Open the channel → tap channel name → **Administrators** → **Add Admin**
   → search for your bot's username → toggle **Post Messages** ON → save.

d. Post any message in the channel ("test" works).

### 3. Configure environment

```
copy .env.example .env
notepad .env
```

Fill in:
- `TELEGRAM_BOT_TOKEN` (from @BotFather)

### 4. Find your channel ID

```
npm run get-chat-id
```

Copy the `chat_id` starting with `-100` into `TELEGRAM_CHAT_ID` in `.env`.

### 5. Smoke-test the alert path

```
npm run test-alert
```

You should see a fake `TRADE_RADAR` alert appear in your channel within
seconds. If it does, the Telegram path works.

### 6. Start the scanner

```
npm run dev      # development mode with auto-reload
# OR
npm run start    # production mode
```

The first 5 minutes will look quiet — discovery surfaces candidate pairs
but the scoring engine needs at least 2 snapshots per pair (~20-40s) to
compute volume acceleration. Alerts begin firing shortly after.

## Configuration

All thresholds live in `config/strategy.solana.json`:

```json
{
  "marketCapMin": 500000,
  "marketCapMax": 3000000,
  "liquidityMin": 40000,
  "liquidityMax": 300000,
  "volumeH24Min": 50000,
  "pairAgeMaxDays": 7,
  "watchAlert":      { "volumeAccelerationMin": 1.4, "volumeAccelerationMax": 1.8, "priceChangeM5Max": 6 },
  "tradeRadarAlert": { "volumeAccelerationMin": 1.8, "volumeAccelerationMax": 2.5, "priceChangeM5Max": 10 },
  "cautionAlert":    { "volumeAccelerationMin": 3.0, "priceChangeM5Min": 20 },
  "buyRatioIdealMin": 45,
  "buyRatioIdealMax": 65,
  "duplicateAlertCooldownMinutes": 10
}
```

**Discovery seed queries** (which DexScreener search terms surface candidate
pairs) live in `config/discovery.json`. Add tokens / categories that bias
toward the kinds of pairs you want to find.

**Explicit watchlist pairs** (always polled regardless of filter) live in
`config/watchlist.json`. Add Solana pair addresses to the `pairs` array.

## How scoring works

Each polled snapshot is scored 0-100 across five dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| Volume acceleration | 30% | Current 5-min volume vs the rolling baseline of prior 5-min buckets |
| Price compression | 25% | High volume acceleration + low absolute price change = staged accumulation |
| Liquidity vs volume | 20% | Volume relative to total liquidity (high = activity spike) |
| Transaction acceleration | 15% | Current 5-min txn count vs rolling baseline |
| Buy/sell ratio | 10% | Ideal 45-65%; penalize extremes |

The composite score feeds the tier classifier. The classifier uses the
**volume acceleration ratio** plus **5-minute price change** to bucket
each fire into WATCH / TRADE_RADAR / CAUTION (or no alert).

## Alert tiers

| Tier | Trigger | Meaning |
|---|---|---|
| 👀 WATCH | volAccel 1.4-1.8x, price change < 6% | Early volume ignition — possible staging |
| 🎯 TRADE_RADAR | volAccel 1.8-2.5x, price change < 10% | Pre-expansion behavior — strong volume into compressed price |
| ⚠️ CAUTION | volAccel ≥ 3x OR price change ≥ 20% | Likely late / attention phase — risk of buying the top |

Cooldown: same-tier alerts on the same pair are suppressed for 10 minutes
(configurable). **Escalation always fires** — a wallet jumping from WATCH
to TRADE_RADAR or CAUTION will alert immediately, no cooldown gating.

CAUTION suppresses bullish-bias alerts (WATCH / TRADE_RADAR) on the same
pair until the cooldown expires.

## Backtesting

```
npm run backtest
```

Replays every snapshot stored in `data/cabal.sqlite` chronologically,
applies the same scoring + tier classification + cooldown logic, then
computes forward returns at 5 / 15 / 30 / 60 minute horizons.

Outputs:
- Console summary: alerts by tier, win rate, avg / max / min returns per horizon
- `data/exports/backtest_<timestamp>.csv` with one row per backtested alert

The backtest only knows what's in your local DB — let the live scanner
run for a few hours / days first to build up enough snapshots for
meaningful results.

## DexScreener limitations

This system relies on DexScreener's REST API. Things to know:

- **Rate limit** is ~300 requests / minute on pair endpoints, ~60 on
  profile endpoints. The client self-throttles to stay under both.
- **No streaming** — all data comes from polling. Latency is bounded by
  `POLL_INTERVAL_SECONDS`.
- **No candle wicks** — DexScreener REST exposes 5-min, 1-hr, 6-hr, 24-hr
  aggregates only. The scoring engine doesn't simulate intra-bucket extremes.
- **Pair age** is sometimes missing in the API response. Pairs without
  `pairCreatedAt` aren't filtered by age (we keep them).

## Future upgrades

Things this version intentionally skips, but the architecture supports:

- **Helius integration** — real-time Solana wallet/transaction feeds
  for confirming "smart money" activity behind alerts
- **Bubblemaps integration** — token holder concentration analysis to
  filter out pairs with one-wallet-holds-everything risk
- **GMGN / Axiom validators** — cross-check alerts against memecoin-native
  platforms' wallet PnL data
- **Multi-chain support** — the config and DB schema are chain-aware;
  add a chain to `BSC_QUOTE_TOKENS`-style sets and a chainId routing layer

## File layout

```
cabal-trending/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── config/
│   ├── strategy.solana.json     # ALL thresholds; tweak freely
│   ├── discovery.json           # seed search queries
│   └── watchlist.json           # explicit pair addresses
├── src/
│   ├── index.ts                 # main polling loop
│   ├── config/loader.ts
│   ├── util/{logger,sleep}.ts
│   ├── dexscreener/client.ts    # rate-limited REST client
│   ├── scanner/
│   │   ├── filter.ts            # base filtering (MC / liq / vol / age)
│   │   └── poll.ts              # discovery + poll cycle
│   ├── scoring/
│   │   ├── engine.ts            # 0-100 anomaly scoring
│   │   └── tiers.ts             # WATCH / TRADE_RADAR / CAUTION classifier
│   ├── alerts/
│   │   ├── telegram.ts          # sendMessage wrapper
│   │   ├── formatter.ts         # alert message format
│   │   ├── dedup.ts             # cooldown + escalation rules
│   │   └── test-alert.ts        # manual end-to-end test
│   ├── db/
│   │   ├── schema.ts            # SQLite tables + connection
│   │   └── snapshots.ts         # CRUD
│   └── backtest/
│       └── index.ts             # replay engine + CSV export
├── tools/
│   └── get-chat-id.ts           # find Telegram channel ID
└── data/
    └── exports/                 # backtest CSVs land here
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start scanner with auto-reload (development) |
| `npm run start` | Start scanner (production) |
| `npm run backtest` | Run backtest on stored snapshots |
| `npm run test-alert` | Send a fake alert to verify Telegram works |
| `npm run get-chat-id` | Find your Telegram channel's chat_id |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run build` | Compile TypeScript to `dist/` |

## Safety / philosophy

This is an **observation tool**. It surfaces volume anomalies in the
$500K-$3M market cap range so you can study them. It does not place
trades, hold custody of any keys, or recommend specific actions.

The CAUTION tier exists specifically to flag situations where the alert
is *too late* — high volume + already-moved price = somebody else's exit.
Don't chase CAUTIONs; treat them as warnings, not signals.
#   c a b a l - t r e n d i n g  
 