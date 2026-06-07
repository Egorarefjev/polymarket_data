# Polymarket BTC Up/Down 5-minute Historical Data Collector

Production-grade local TypeScript/Node.js collector for researching historical BTC Up/Down 5-minute Polymarket markets. The project follows Clean Architecture / Ports and Adapters: `core/` is pure business logic, `adapters/` handles public APIs and storage, `application/` coordinates use cases, and `cli/` only parses commands.

## 1. What the project does

The collector downloads public data and normalizes it into analysis tables:

- `data/processed/markets_<start>_<end>.parquet`
- `data/processed/price_points_<start>_<end>.parquet`
- `data/processed/strategy_training_rows_<start>_<end>.parquet`
- `data/processed/market_summary_<start>_<end>.parquet`
- `data/processed/rejected_markets_<start>_<end>.parquet`

Parquet files are the durable outputs. By default the collector does **not** write debug JSON mirrors because month/year runs can create very large files. Use `--write-debug-json true` only for small sample runs when you want easy local inspection without decoding Parquet.

The normalized dataset is meant to answer questions such as:

- how the Polymarket UP/DOWN price moved inside each 5-minute market;
- what Chainlink BTC/USD distance to target produced what UP/DOWN probability price;
- how probability price changes with `seconds_left`;
- when price reached 0.75, 0.80, 0.90, 0.95, or 0.99;
- which side won;
- whether price trajectory can be used later for ML labels and backtesting.

## 2. What the project does NOT do

This is **not** a trading bot. It never uses private keys, wallets, authenticated trading APIs, signed orders, order placement, claims, or settlement code. It is only a public data collector.

## 3. Install dependencies

Requires Node.js 20+.

```bash
npm install
npm run build
npm run test
```

## 4. Official mode command with Chainlink input

Official analytical mode requires a non-empty Chainlink input file. Empty or header-only Chainlink input is fatal, and the collector refuses to silently fallback from a provided Chainlink file to Binance.

```bash
npm run collector -- all \
  --start-date 2026-05-01 \
  --end-date 2026-05-02 \
  --symbol BTCUSDT \
  --price-fidelity-minutes 1 \
  --primary-price-source chainlink \
  --chainlink-input-file ./chainlink_btc_usd_2026-05-01.jsonl \
  --include-binance-secondary-signal true \
  --write-debug-json false
```

The `end-date` is exclusive, so the example covers exactly `2026-05-01T00:00:00Z` through `2026-05-02T00:00:00Z`.

## 5. Proxy debug command without Chainlink

Proxy debug mode works only when `--chainlink-input-file` is **not** passed. It uses Binance as a non-official primary proxy source solely to verify the pipeline. Every row is flagged `proxy_primary_price_source_not_official`. Do not use Binance-only proxy mode for real strategy conclusions or production analytics.

```bash
npm run collector -- all \
  --start-date 2026-05-01 \
  --end-date 2026-05-02 \
  --symbol BTCUSDT \
  --price-fidelity-minutes 1 \
  --allow-proxy-primary-price-source-for-debug true \
  --include-binance-secondary-signal false \
  --write-debug-json false
```

When `all` runs in proxy debug mode without Chainlink, it downloads the required raw Binance files automatically because Binance becomes the non-official primary proxy source. If you run manual stages, run `download-binance` before `build-dataset`.

## 6. Price-source semantics

Polymarket BTC Up/Down 5-minute market rules resolve using Chainlink BTC/USD Data Streams. For real analytical conclusions and strategy research, use official Chainlink mode only.

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

## 7. Chainlink input file formats

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

## 8. Price trajectory and summaries

`price_points.parquet` is the primary analytical dataset. It stores the full available Polymarket prices-history trajectory for every market: if a market has 5 points, all 5 points are stored; if it has 20 points, all 20 points are stored. The collector does not keep only threshold hits, maxima/minima, first threshold hits, or any other reduced subset.

`market_summary.parquet` is a derived aggregate summary over the full trajectory. `build-dataset` and `all` write it directly from fresh in-memory price points, so normal collection does not require debug JSON and cannot accidentally summarize from stale debug mirrors. Threshold fields are useful summary features, but they do not replace the full history.

Polymarket CLOB `prices-history` can be coarse in time, commonly 1-minute granularity even for 5-minute markets. If you need tick-level or per-second movement, you need a live WebSocket logger or a paid historical provider. Public price-history is not a full historical orderbook replay.

## 9. `price_points.parquet` fields

Important columns include:

- market identity/time: `market_slug`, `condition_id`, `timestamp_milliseconds`, `seconds_left`, `target_price`;
- Polymarket trajectory: `up_price`, `down_price`;
- primary source: `primary_price_source_name`, `primary_price`, `primary_timestamp_milliseconds`, `primary_distance_usd`, `primary_distance_basis_points`;
- official Chainlink fields: `chainlink_price`, `chainlink_timestamp_milliseconds`, `chainlink_distance_usd`, `chainlink_distance_basis_points`;
- optional Binance secondary fields: `binance_price`, `binance_timestamp_milliseconds`, `binance_distance_usd`, `binance_distance_basis_points`, `binance_minus_chainlink_basis_points`;
- outcome/quality: `winner`, `is_resolved`, `data_quality_flags`;
- future labels: `future_maximum_up_price`, `future_maximum_down_price`, `future_minimum_up_price`, `future_minimum_down_price`, `future_final_up_price`, `future_final_down_price`, all `future_seconds_until_*` threshold labels, and all `future_reaches_*` boolean labels.

Future labels are calculated only inside the same market and never look into the next market. `future_*` fields are labels/targets for training and backtesting; they must not be used as model features.

## 10. `market_summary.parquet` fields

The summary keeps first threshold timestamp fields for UP and DOWN at 0.75, 0.80, 0.90, 0.95, and 0.99. It also includes trajectory aggregates:

- `up_price_open`, `down_price_open`, `up_price_close`, `down_price_close`;
- `up_price_minimum`, `up_price_maximum`, `down_price_minimum`, `down_price_maximum`;
- `up_price_range`, `down_price_range`;
- `up_price_last`, `down_price_last`;
- `up_price_mean`, `down_price_mean`;
- `up_price_median`, `down_price_median`;
- `up_price_standard_deviation`, `down_price_standard_deviation`;
- `up_price_number_of_observations`, `down_price_number_of_observations`, `price_points_count`.

It also records `primary_price_source_name`, `close_primary_price`, and `final_primary_distance_basis_points`. In proxy debug mode, `close_primary_price` is filled from Binance proxy while `close_chainlink_price` remains `null`.

## 11. `strategy_training_rows.parquet` fields and leakage rules

`strategy_training_rows.parquet` is built from `price_points.parquet` and keeps features and labels separated.

Feature columns:

- `market_slug`, `condition_id`, `timestamp_milliseconds`, `seconds_left`, `target_price`;
- `up_price`, `down_price`;
- `primary_price_source_name`, `primary_price`, `primary_timestamp_milliseconds`, `primary_distance_usd`, `primary_distance_basis_points`;
- optional Binance fields: `binance_price`, `binance_timestamp_milliseconds`, `binance_distance_usd`, `binance_distance_basis_points`, `binance_minus_chainlink_basis_points`;
- past-only features: `up_price_change_previous_1_point`, `down_price_change_previous_1_point`, `up_price_change_previous_2_points`, `down_price_change_previous_2_points`, `up_price_change_previous_3_points`, `down_price_change_previous_3_points`.

Label columns:

- `winner`, `up_wins_binary`;
- `future_maximum_up_price`, `future_maximum_down_price`, `future_minimum_up_price`, `future_minimum_down_price`, `future_final_up_price`, `future_final_down_price`;
- `future_seconds_until_up_price_greater_than_or_equal_090`, `future_seconds_until_down_price_greater_than_or_equal_090`;
- `future_reaches_up_090`, `future_reaches_up_095`, `future_reaches_up_099`, `future_reaches_down_090`, `future_reaches_down_095`, `future_reaches_down_099`;
- `data_quality_flags` for filtering.

Do not use `future_*`, `winner`, close prices, future price movement, or future threshold hits as features. Previous price change features use only previous points inside the same market; first rows with insufficient history have null previous-change fields.

## 12. Data quality flags

Possible flags include:

- `target_price_missing`
- `token_ids_missing`
- `invalid_market_time_range`
- `market_parsing_error:<message>`
- `price_history_empty`
- `price_history_too_few_points_for_five_minute_market`
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

Bad or suspicious market-level data is written to rejected outputs instead of crashing the full pipeline.

## 13. Reading output Parquet

Python example:

```python
import pandas as pandas

price_points = pandas.read_parquet('data/processed/price_points_2026-05-01_2026-05-02.parquet')
print(price_points.head())
```

DuckDB example:

```sql
SELECT market_slug, seconds_left, primary_distance_basis_points, up_price, down_price
FROM 'data/processed/price_points_2026-05-01_2026-05-02.parquet'
LIMIT 10;
```

## 14. Scaling from 1 day to month/year

Start with one day and inspect `rejected_markets` and `data_quality_flags`. Then increase the range gradually:

1. Run 1 day with `--price-fidelity-minutes 1`, `--primary-price-source chainlink`, `--chainlink-input-file <path>`, and optionally `--include-binance-secondary-signal true`.
2. Run 7 days and check API rate limits and disk usage.
3. Increase `--request-delay-milliseconds` if public APIs throttle.
4. Lower `--maximum-concurrent-requests` for stability.
5. Use `--force` only when you explicitly want to overwrite raw files.
6. Keep raw files: resumability depends on not redownloading files that already exist.

The state file under `data/state/` records completed steps so a failed pipeline can be resumed safely.

### Debug JSON and large runs

`--write-debug-json` defaults to `false`. Keep it disabled for real collection and use the Parquet files (`price_points.parquet`, `strategy_training_rows.parquet`, and `market_summary.parquet`) as the durable outputs. Debug JSON mirrors (`price_points_*.debug.json` and `strategy_training_rows_*.debug.json`) are optional inspection files for small smoke/sample runs only. When `--write-debug-json false`, `build-dataset` and `all` remove old debug JSON mirrors for the same date range after writing fresh Parquet outputs, preventing stale debug files from being reused later.

The standalone `summarize` command is debug-only compatibility tooling. It reads `price_points_*.debug.json`, therefore it requires `--write-debug-json true` and fails otherwise. For normal collection, use `all` or `build-dataset`; they write `market_summary.parquet` directly from fresh in-memory `price_points` and do not depend on debug JSON.

### Binance aggTrades memory warning

Binance `aggTrades` files are large. For smoke/debug runs, prefer `--binance-data-type klines`. For serious secondary-signal experiments, `aggTrades` is still supported, but start with 1 day, then 7 days, and inspect disk/memory usage before widening the range. For month/year ranges, prefer chunked runs rather than loading all daily `aggTrades` JSON files for a long date range at once.
