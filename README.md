# Polymarket BTC Up/Down 5-minute Historical Data Collector

Production-grade local TypeScript/Node.js collector for researching historical BTC Up/Down 5-minute Polymarket markets. The project follows Clean Architecture / Ports and Adapters: `core/` is pure business logic, `adapters/` handles public APIs and storage, `application/` coordinates use cases, and `cli/` only parses commands.

## 1. What the project does

The collector downloads public data and normalizes it into analysis tables:

- `data/processed/markets_<start>_<end>.parquet`
- `data/processed/price_points_<start>_<end>.parquet`
- `data/processed/market_summary_<start>_<end>.parquet`
- `data/processed/rejected_markets_<start>_<end>.parquet`

It also saves raw public responses for reproducibility:

```text
data/
  raw/
    gamma/
    polymarket-prices/
    polymarket-trades/
    binance/
  processed/
  rejected/
  state/
  logs/
```

The normalized dataset is meant to answer questions such as:

- what BTC distance to target produced what UP/DOWN probability price;
- how probability price changes with `seconds_left`;
- how often price reached 0.75, 0.80, 0.90, 0.95, or 0.99;
- which side won;
- where Polymarket may have overestimated or underestimated probabilities.

## 2. What the project does NOT do

This is **not** a trading bot. It never uses private keys, wallets, authenticated trading APIs, signed orders, order placement, claims, or settlement code. It is only a public data collector.

## 3. Install dependencies

Requires Node.js 20+.

```bash
npm install
npm run build
npm run test
```

## 4. Download data for 1 day

```bash
npm run collector -- all \
  --start-date 2026-05-01 \
  --end-date 2026-05-02 \
  --symbol BTCUSDT \
  --price-fidelity-seconds 5
```

The `end-date` is exclusive, so the example covers exactly `2026-05-01T00:00:00Z` through `2026-05-02T00:00:00Z`.

## 5. Download data for 7 days

```bash
npm run collector -- all \
  --start-date 2026-05-01 \
  --end-date 2026-05-08 \
  --symbol BTCUSDT \
  --price-fidelity-seconds 5 \
  --maximum-concurrent-requests 4 \
  --request-delay-milliseconds 200
```

You can run individual stages if you want finer control:

```bash
npm run collector -- discover --start-date 2026-05-01 --end-date 2026-05-08
npm run collector -- download-polymarket-prices --start-date 2026-05-01 --end-date 2026-05-08 --price-fidelity-seconds 5
npm run collector -- download-binance --start-date 2026-05-01 --end-date 2026-05-08 --symbol BTCUSDT --binance-data-type aggTrades
npm run collector -- build-dataset --start-date 2026-05-01 --end-date 2026-05-08
npm run collector -- summarize --start-date 2026-05-01 --end-date 2026-05-08
```

## 6. Why full historical orderbook is not downloaded for free

The collector intentionally uses public Gamma, public CLOB `prices-history`, and public Binance archives. A full historical orderbook replay requires historical order-level depth snapshots and updates, which are not equivalent to public price history and may not be freely exposed as a complete archive. The collector does not use authenticated or trading endpoints to obtain private order data.

## 7. Price-history vs orderbook

`prices-history` is a historical price series for a token. It is useful for probability-over-time analysis but does not contain all bid/ask levels, queue depth, or every orderbook mutation. An orderbook archive would include liquidity at price levels and order updates. This project uses price-history because it is public and sufficient for the requested probability-distance-time dataset.

## 8. Data quality flags

Possible flags include:

- `target_price_missing`
- `token_ids_missing`
- `invalid_market_time_range`
- `market_parsing_error:<message>`
- `price_history_empty`
- `price_history_too_coarse`
- `price_history_missing_up`
- `price_history_missing_down`
- `trades_unavailable_without_public_endpoint`
- `dataset_build_error:<message>`

Bad or suspicious market-level data is written to rejected outputs instead of crashing the full pipeline.

## 9. Reading output Parquet

Python example:

```python
import pandas as pandas

price_points = pandas.read_parquet('data/processed/price_points_2026-05-01_2026-05-02.parquet')
print(price_points.head())
```

DuckDB example:

```sql
SELECT market_slug, seconds_left, distance_basis_points, up_price, down_price
FROM 'data/processed/price_points_2026-05-01_2026-05-02.parquet'
LIMIT 10;
```

## 10. Scaling from 1 day to month/year

Start with one day and inspect `rejected_markets` and `data_quality_flags`. Then increase the range gradually:

1. Run 1 day with `--price-fidelity-seconds 5`.
2. Run 7 days and check API rate limits and disk usage.
3. Increase `--request-delay-milliseconds` if public APIs throttle.
4. Lower `--maximum-concurrent-requests` for stability.
5. Use `--force` only when you explicitly want to overwrite raw files.
6. Keep raw files: resumability depends on not redownloading files that already exist.

The state file under `data/state/` records completed steps so a failed pipeline can be resumed safely.
