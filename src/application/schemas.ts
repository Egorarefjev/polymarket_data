import type { ParquetSchemaDefinition } from '../adapters/parquetWriter.js';

export const marketsParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: { type: 'UTF8', optional: true }, question: { type: 'UTF8' },
  market_start_timestamp_milliseconds: { type: 'INT64' }, market_end_timestamp_milliseconds: { type: 'INT64' },
  up_token_id: { type: 'UTF8', optional: true }, down_token_id: { type: 'UTF8', optional: true }, target_price: { type: 'DOUBLE', optional: true },
  winner: { type: 'UTF8', optional: true }, is_resolved: { type: 'BOOLEAN' }, is_closed: { type: 'BOOLEAN' }, raw_outcomes: { type: 'UTF8' }, raw_outcome_prices: { type: 'UTF8' }, data_quality_flags: { type: 'UTF8' },
};
export const pricePointsParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: { type: 'UTF8', optional: true }, timestamp_milliseconds: { type: 'INT64' }, seconds_left: { type: 'INT64' },
  target_price: { type: 'DOUBLE' }, btc_price: { type: 'DOUBLE' }, distance_usd: { type: 'DOUBLE' }, distance_basis_points: { type: 'DOUBLE' },
  up_price: { type: 'DOUBLE', optional: true }, down_price: { type: 'DOUBLE', optional: true }, winner: { type: 'UTF8', optional: true }, is_resolved: { type: 'BOOLEAN' }, data_quality_flags: { type: 'UTF8' },
};
export const marketSummaryParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: { type: 'UTF8', optional: true }, market_start_timestamp_milliseconds: { type: 'INT64' }, market_end_timestamp_milliseconds: { type: 'INT64' }, target_price: { type: 'DOUBLE' }, winner: { type: 'UTF8', optional: true }, close_btc_price: { type: 'DOUBLE', optional: true }, final_distance_basis_points: { type: 'DOUBLE', optional: true }, maximum_up_price: { type: 'DOUBLE', optional: true }, maximum_down_price: { type: 'DOUBLE', optional: true }, first_timestamp_up_price_greater_than_or_equal_075: { type: 'INT64', optional: true }, first_timestamp_up_price_greater_than_or_equal_080: { type: 'INT64', optional: true }, first_timestamp_up_price_greater_than_or_equal_090: { type: 'INT64', optional: true }, first_timestamp_up_price_greater_than_or_equal_095: { type: 'INT64', optional: true }, first_timestamp_up_price_greater_than_or_equal_099: { type: 'INT64', optional: true }, seconds_left_at_first_up_price_greater_than_or_equal_090: { type: 'INT64', optional: true }, first_timestamp_down_price_greater_than_or_equal_075: { type: 'INT64', optional: true }, first_timestamp_down_price_greater_than_or_equal_080: { type: 'INT64', optional: true }, first_timestamp_down_price_greater_than_or_equal_090: { type: 'INT64', optional: true }, first_timestamp_down_price_greater_than_or_equal_095: { type: 'INT64', optional: true }, first_timestamp_down_price_greater_than_or_equal_099: { type: 'INT64', optional: true }, seconds_left_at_first_down_price_greater_than_or_equal_090: { type: 'INT64', optional: true }, data_quality_flags: { type: 'UTF8' },
};
export const rejectedMarketsParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8', optional: true }, condition_id: { type: 'UTF8', optional: true }, question: { type: 'UTF8', optional: true }, rejection_reason: { type: 'UTF8' }, raw_market_file_path: { type: 'UTF8' }, data_quality_flags: { type: 'UTF8' },
};
