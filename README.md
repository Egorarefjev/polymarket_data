# Polymarket BTC Up/Down Price Collector

A small deterministic collector for historical **Polymarket BTC Up/Down** price-history data.

This project is Polymarket-only. It does not download Binance data, does not require Chainlink, does not place trades, and does not use wallet/API trading credentials.

## Install

```bash
npm install
```

## Doctor

```bash
npm run collector -- doctor
```

## Discover

```bash
npm run collector -- diagnose-discovery --date 2026-05-01 --market-duration all --force
```

Discovery keeps only supported BTC Up/Down market durations: `1h`, `4h`, and `1d`. It rejects `5m` and `15m` markets as unsupported.

## Collect

```bash
npm run collect:pm:all -- --date 2026-05-01 --force
```

Equivalent duration shortcuts are available:

```bash
npm run collect:pm:1h -- --date 2026-05-01 --force
npm run collect:pm:4h -- --date 2026-05-01 --force
npm run collect:pm:1d -- --date 2026-05-01 --force
```

## Pipeline

The `all` command runs exactly this Polymarket-only workflow:

1. `discoverMarkets`
2. `downloadPolymarketPriceHistory`
3. `buildPolymarketPricePoints`
4. `buildMarketSummary`
5. `buildStrategyTrainingRows`

Rows are built directly from Polymarket YES/NO price history. External BTC prices are not required for `price_points`, `market_summary`, or `strategy_training_rows`.

## Outputs

Files are written under `data/processed`:

- `data/processed/markets_all_...parquet`
- `data/processed/price_points_all_...parquet`
- `data/processed/market_summary_all_...parquet`
- `data/processed/strategy_training_rows_all_...parquet`
- `data/processed/rejected_markets_all_...parquet`

The collector also stores raw Gamma discovery data and raw Polymarket price history under `data/raw`.

## Dataset contents

`price_points` contains Polymarket market identity, timestamp, seconds left, Up/Down prices, target price from Gamma metadata when available, resolution/winner fields, data-quality flags, and future threshold labels for 0.75 / 0.80 / 0.90 / 0.95 / 0.99.

`market_summary` is computed only from Polymarket prices and includes open/close/final prices, min/max/mean/median/stdev, point counts, and first threshold-hit timestamps/seconds-left.

`strategy_training_rows` is built only from Polymarket `price_points`; current prices and recent price changes are features, while future maximum/minimum/final prices and future threshold hits are labels.

## Explicit non-goals

- No Binance pipeline or proxy primary price mode.
- No Chainlink requirement in the default collector.
- No external BTC price alignment requirement.
- No trading bot, order execution, wallet integration, or private-key usage.
