# Polymarket BTC Up/Down Historical Data Collector

Production-grade local TypeScript/Node.js collector for researching historical BTC Up/Down Polymarket markets with longer durations: **hourly (`1h`)**, **four-hour (`4h`)**, and **daily (`1d`)**.

The project no longer centers the main workflow on 5-minute markets. Polymarket `prices-history` fidelity is measured in **minutes**, so 1-minute history is too coarse for a useful 5-minute trajectory. For 1h / 4h / 1d markets, use `--price-fidelity-minutes 1`.

## What the project does

The collector downloads public data and normalizes it into analysis tables:

- `data/processed/markets_<duration>_<start>_<end>.parquet`
- `data/processed/price_points_<duration>_<start>_<end>.parquet`
- `data/processed/strategy_training_rows_<duration>_<start>_<end>.parquet`
- `data/processed/market_summary_<duration>_<start>_<end>.parquet`
- `data/processed/rejected_markets_<duration>_<start>_<end>.parquet`

Examples:

- `markets_1h_2026-05-01_2026-05-02.parquet`
- `price_points_4h_2026-05-01_2026-05-02.parquet`
- `market_summary_1d_2026-05-01_2026-05-02.parquet`
- `strategy_training_rows_all_2026-05-01_2026-05-02.parquet`

`end-date` is exclusive. `--date YYYY-MM-DD` is a shorthand for `--start-date YYYY-MM-DD --end-date <next day>`.

## What the project does NOT do

This is **not** a trading bot. It never uses private keys, wallets, authenticated trading APIs, signed orders, order placement, claims, or settlement code. It is only a public historical data collector.

## Install dependencies

Requires Node.js 20+.

```bash
npm install
npm run build
npm run test
```

## Market duration selection

Use:

```bash
--market-duration 1h | 4h | 1d | all
```

Default: `--market-duration 1h`.

Behavior:

- `1h`: BTC Up/Down hourly markets only.
- `4h`: BTC Up/Down four-hour markets only.
- `1d`: BTC Up/Down daily markets only.
- `all`: combines 1h + 4h + 1d in one output set.

Discovery determines duration from timestamps first, then title/question/slug/description/event metadata. Timestamp duration uses a small tolerance for imperfect metadata.

## Short proxy smoke commands

Proxy mode uses Binance as a non-official primary price source only to smoke-test the pipeline. Every resulting row is flagged `proxy_primary_price_source_not_official`. Do **not** use proxy-only output for real analytics.

```bash
npm run collect:proxy:1h -- --date 2026-05-01
npm run collect:proxy:4h -- --date 2026-05-01
npm run collect:proxy:1d -- --date 2026-05-01
npm run collect:proxy:all -- --date 2026-05-01
```

Minimal equivalent 1h proxy command:

```bash
npm run collector -- all --date 2026-05-01 --allow-proxy-primary-price-source-for-debug true
```

Proxy all durations example:

```bash
npm run collect:proxy:all -- --date 2026-05-01
```

When `all` runs in proxy debug mode without Chainlink, it downloads the required raw Binance files automatically because Binance becomes the non-official primary proxy source. If you run manual stages, run `download-binance` before `build-dataset`.

## Official Chainlink commands

Official analytical mode requires a non-empty Chainlink input file. Empty or header-only Chainlink input is fatal, and the collector refuses to silently fall back from a provided Chainlink file to Binance.

```bash
npm run collect:official:1h -- --date 2026-05-01 --chainlink-input-file ./data/external/chainlink.jsonl
npm run collect:official:all -- --start-date 2026-05-01 --end-date 2026-05-08 --chainlink-input-file ./data/external/chainlink.jsonl
```

Official all durations example:

```bash
npm run collect:official:all -- --start-date 2026-05-01 --end-date 2026-05-08 --chainlink-input-file ./data/external/chainlink_btc_usd_2026-05-01_2026-05-08.jsonl
```

## Defaults

The collector has these sane defaults:

- `symbol = BTCUSDT`
- `priceFidelityMinutes = 1`
- `marketDuration = 1h`
- `includeBinanceSecondarySignal = false`
- `binanceDataType = klines`
- `writeDebugJson = false`

## Price-source semantics

Polymarket BTC Up/Down market rules resolve using Chainlink BTC/USD Data Streams. For real analytical conclusions and strategy research, use official Chainlink mode only.

Official Chainlink mode:

- selected by passing `--chainlink-input-file`;
- the file must contain at least one valid Chainlink price point after parsing;
- `primary_price_source_name = "chainlink"`;
- `primary_*` fields are Chainlink values;
- `chainlink_*` fields are Chainlink values;
- Binance may be included only as an optional secondary signal.

Proxy debug mode:

- selected only when no `--chainlink-input-file` is passed and `--allow-proxy-primary-price-source-for-debug true` is passed;
- `primary_price_source_name = "binance_proxy"`;
- `primary_*` fields are filled from Binance proxy data;
- `chainlink_*` fields stay `null` and are never polluted by Binance proxy values;
- every row has `proxy_primary_price_source_not_official`.

No Chainlink and no proxy debug mode makes `build-dataset` fail with a clear Chainlink-required error.

## Chainlink input file formats

Chainlink Data Streams REST API historical reports require authenticated access, so this collector supports a local Chainlink historical input file instead of attempting unauthenticated public history downloads. Supported formats are CSV, JSON, and JSONL.

CSV:

```csv
timestamp_milliseconds,price
1717200000000,67500.12
```

Accepted CSV timestamp aliases are `timestamp`, `timestamp_ms`, `timestampMilliseconds`, and `observationsTimestamp`; the Chainlink price may be `price` or `benchmarkPrice`. JSON/JSONL uses the same fields, for example:

```jsonl
{"timestamp_milliseconds":1717200000000,"price":67500.12}
{"timestampMilliseconds":1717200000000,"price":67500.12}
{"observationsTimestamp":1717200000,"benchmarkPrice":67500.12}
```

Timestamps may be seconds, milliseconds, or microseconds; they are normalized to milliseconds. Prices must be finite positive numbers. Input rows are sorted ascending and duplicate timestamps keep the last record.

## Price trajectory and strategy labels

`price_points.parquet` stores the full available Polymarket prices-history trajectory for every accepted market. The collector does not keep only threshold hits, maxima/minima, first threshold hits, or another reduced subset.

`strategy_training_rows.parquet` is built from `price_points.parquet` and keeps features and labels separated. It preserves useful future labels including:

- `future_maximum_up_price`, `future_maximum_down_price`;
- `future_minimum_up_price`, `future_minimum_down_price`;
- `future_final_up_price`, `future_final_down_price`;
- future seconds-until-threshold fields;
- future reaches-threshold booleans.

Do not use `future_*`, `winner`, close prices, future price movement, or future threshold hits as features. Previous price change features use only previous points inside the same market; first rows with insufficient history have null previous-change fields.

## Output columns added for durations

The main outputs include `market_duration`:

- `markets.parquet`
- `price_points.parquet`
- `market_summary.parquet`
- `strategy_training_rows.parquet`

Rejected market output includes `detected_market_duration` when the collector can determine it.

## Data quality flags

Possible flags include:

- `target_price_missing`
- `token_ids_missing`
- `unsupported_duration`
- `unknown_duration`
- `not_bitcoin_up_down`
- `not_explicit_up_down_product`
- `non_up_down_outcomes`
- `invalid_market_time_range`
- `market_parsing_error:<message>`
- `price_history_empty`
- `price_history_too_few_points_for_duration`
- `price_history_too_coarse`
- `price_history_does_not_cover_market_start`
- `price_history_does_not_cover_market_end`
- `price_history_missing_up`
- `price_history_missing_down`
- `primary_price_missing_before_timestamp` (diagnostic name; rows are skipped and the aggregate counter is logged, not attached to valid rows)
- `chainlink_data_unavailable`
- `chainlink_history_too_sparse`
- `binance_secondary_signal_missing`
- `binance_chainlink_divergence_high`
- `trades_unavailable_without_public_endpoint`
- `proxy_primary_price_source_not_official`
- `dataset_build_error:<message>`

Duration-aware suspicious price history thresholds are intentionally non-fatal:

- `1h`: fewer than 10 points;
- `4h`: fewer than 30 points;
- `1d`: fewer than 100 points.

Bad or suspicious market-level data is written to rejected outputs instead of crashing the full pipeline.

## Reading output Parquet

Python example:

```python
import pandas as pandas

price_points = pandas.read_parquet('data/processed/price_points_1h_2026-05-01_2026-05-02.parquet')
print(price_points.head())
```

DuckDB example:

```sql
SELECT market_slug, market_duration, seconds_left, primary_distance_basis_points, up_price, down_price
FROM 'data/processed/price_points_all_2026-05-01_2026-05-02.parquet'
LIMIT 10;
```

## Scaling from 1 day to month/year

Start with one day and inspect `rejected_markets` and `data_quality_flags`. Then increase the range gradually:

1. Run 1 day with `--price-fidelity-minutes 1`, `--primary-price-source chainlink`, `--chainlink-input-file <path>`, and optionally `--include-binance-secondary-signal true`.
2. Run 7 days and check API rate limits and disk usage.
3. Increase `--request-delay-milliseconds` if public APIs throttle.
4. Lower `--maximum-concurrent-requests` for stability.
5. Use `--force` only when you explicitly want to overwrite raw files.
6. Keep raw files: resumability depends on not redownloading files that already exist.

The state file under `data/state/` records completed steps so a failed pipeline can be resumed safely.

### Debug JSON and large runs

`--write-debug-json` defaults to `false`. Keep it disabled for real collection and use the Parquet files as durable outputs. Debug JSON mirrors (`price_points_*.debug.json` and `strategy_training_rows_*.debug.json`) are optional inspection files for small smoke/sample runs only. When `--write-debug-json false`, `build-dataset` and `all` remove old debug JSON mirrors for the same duration/date range after writing fresh Parquet outputs, preventing stale debug files from being reused later.

The standalone `summarize` command is debug-only compatibility tooling. It reads `price_points_*.debug.json`, therefore it requires `--write-debug-json true` and fails otherwise. For normal collection, use `all` or `build-dataset`; they write `market_summary.parquet` directly from fresh in-memory `price_points` and do not depend on debug JSON.

### Binance aggTrades memory warning

Binance `aggTrades` files are large. For smoke/debug runs, prefer `--binance-data-type klines`. For serious secondary-signal experiments, `aggTrades` is still supported, but start with 1 day, then 7 days, and inspect disk/memory usage before widening the range. For month/year ranges, prefer chunked runs rather than loading all daily `aggTrades` JSON files for a long date range at once.
