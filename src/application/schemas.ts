import type { ParquetSchemaDefinition } from '../adapters/parquetWriter.js';

const optionalDouble = { type: 'DOUBLE', optional: true } as const;
const optionalInt64 = { type: 'INT64', optional: true } as const;
const optionalUtf8 = { type: 'UTF8', optional: true } as const;

export const marketsParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: optionalUtf8, question: { type: 'UTF8' },
  market_start_timestamp_milliseconds: { type: 'INT64' }, market_end_timestamp_milliseconds: { type: 'INT64' },
  up_token_id: optionalUtf8, down_token_id: optionalUtf8, target_price: optionalDouble,
  winner: optionalUtf8, is_resolved: { type: 'BOOLEAN' }, is_closed: { type: 'BOOLEAN' }, raw_outcomes: { type: 'UTF8' }, raw_outcome_prices: { type: 'UTF8' }, data_quality_flags: { type: 'UTF8' },
};

export const pricePointsParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: optionalUtf8, timestamp_milliseconds: { type: 'INT64' }, seconds_left: { type: 'INT64' }, target_price: { type: 'DOUBLE' },
  up_price: optionalDouble, down_price: optionalDouble,
  primary_price_source_name: { type: 'UTF8' }, primary_price: { type: 'DOUBLE' }, primary_timestamp_milliseconds: { type: 'INT64' }, primary_distance_usd: { type: 'DOUBLE' }, primary_distance_basis_points: { type: 'DOUBLE' },
  chainlink_price: optionalDouble, chainlink_timestamp_milliseconds: optionalInt64, chainlink_distance_usd: optionalDouble, chainlink_distance_basis_points: optionalDouble,
  binance_price: optionalDouble, binance_timestamp_milliseconds: optionalInt64, binance_distance_usd: optionalDouble, binance_distance_basis_points: optionalDouble, binance_minus_chainlink_basis_points: optionalDouble,
  winner: optionalUtf8, is_resolved: { type: 'BOOLEAN' }, data_quality_flags: { type: 'UTF8' },
  future_maximum_up_price: optionalDouble, future_maximum_down_price: optionalDouble, future_minimum_up_price: optionalDouble, future_minimum_down_price: optionalDouble, future_final_up_price: optionalDouble, future_final_down_price: optionalDouble,
  future_seconds_until_up_price_greater_than_or_equal_075: optionalDouble, future_seconds_until_up_price_greater_than_or_equal_080: optionalDouble, future_seconds_until_up_price_greater_than_or_equal_090: optionalDouble, future_seconds_until_up_price_greater_than_or_equal_095: optionalDouble, future_seconds_until_up_price_greater_than_or_equal_099: optionalDouble,
  future_seconds_until_down_price_greater_than_or_equal_075: optionalDouble, future_seconds_until_down_price_greater_than_or_equal_080: optionalDouble, future_seconds_until_down_price_greater_than_or_equal_090: optionalDouble, future_seconds_until_down_price_greater_than_or_equal_095: optionalDouble, future_seconds_until_down_price_greater_than_or_equal_099: optionalDouble,
  future_reaches_up_075: { type: 'BOOLEAN' }, future_reaches_up_080: { type: 'BOOLEAN' }, future_reaches_up_090: { type: 'BOOLEAN' }, future_reaches_up_095: { type: 'BOOLEAN' }, future_reaches_up_099: { type: 'BOOLEAN' },
  future_reaches_down_075: { type: 'BOOLEAN' }, future_reaches_down_080: { type: 'BOOLEAN' }, future_reaches_down_090: { type: 'BOOLEAN' }, future_reaches_down_095: { type: 'BOOLEAN' }, future_reaches_down_099: { type: 'BOOLEAN' },
};

export const marketSummaryParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: optionalUtf8, market_start_timestamp_milliseconds: { type: 'INT64' }, market_end_timestamp_milliseconds: { type: 'INT64' }, target_price: { type: 'DOUBLE' }, winner: optionalUtf8,
  primary_price_source_name: optionalUtf8, close_primary_price: optionalDouble, final_primary_distance_basis_points: optionalDouble,
  close_chainlink_price: optionalDouble, final_chainlink_distance_basis_points: optionalDouble, close_binance_price: optionalDouble, final_binance_distance_basis_points: optionalDouble, final_binance_minus_chainlink_basis_points: optionalDouble,
  maximum_up_price: optionalDouble, maximum_down_price: optionalDouble,
  up_price_open: optionalDouble, down_price_open: optionalDouble, up_price_close: optionalDouble, down_price_close: optionalDouble, up_price_minimum: optionalDouble, up_price_maximum: optionalDouble, down_price_minimum: optionalDouble, down_price_maximum: optionalDouble, up_price_range: optionalDouble, down_price_range: optionalDouble, up_price_last: optionalDouble, down_price_last: optionalDouble, up_price_mean: optionalDouble, down_price_mean: optionalDouble, up_price_median: optionalDouble, down_price_median: optionalDouble, up_price_standard_deviation: optionalDouble, down_price_standard_deviation: optionalDouble, up_price_number_of_observations: { type: 'INT64' }, down_price_number_of_observations: { type: 'INT64' }, price_points_count: { type: 'INT64' },
  first_timestamp_up_price_greater_than_or_equal_075: optionalInt64, first_timestamp_up_price_greater_than_or_equal_080: optionalInt64, first_timestamp_up_price_greater_than_or_equal_090: optionalInt64, first_timestamp_up_price_greater_than_or_equal_095: optionalInt64, first_timestamp_up_price_greater_than_or_equal_099: optionalInt64, seconds_left_at_first_up_price_greater_than_or_equal_090: optionalInt64,
  first_timestamp_down_price_greater_than_or_equal_075: optionalInt64, first_timestamp_down_price_greater_than_or_equal_080: optionalInt64, first_timestamp_down_price_greater_than_or_equal_090: optionalInt64, first_timestamp_down_price_greater_than_or_equal_095: optionalInt64, first_timestamp_down_price_greater_than_or_equal_099: optionalInt64, seconds_left_at_first_down_price_greater_than_or_equal_090: optionalInt64,
  data_quality_flags: { type: 'UTF8' },
};

export const strategyTrainingRowsParquetSchema: ParquetSchemaDefinition = {
  market_slug: { type: 'UTF8' }, condition_id: optionalUtf8, timestamp_milliseconds: { type: 'INT64' }, seconds_left: { type: 'INT64' }, target_price: { type: 'DOUBLE' }, up_price: optionalDouble, down_price: optionalDouble,
  primary_price_source_name: { type: 'UTF8' }, primary_price: { type: 'DOUBLE' }, primary_timestamp_milliseconds: { type: 'INT64' }, primary_distance_usd: { type: 'DOUBLE' }, primary_distance_basis_points: { type: 'DOUBLE' },
  binance_price: optionalDouble, binance_timestamp_milliseconds: optionalInt64, binance_distance_usd: optionalDouble, binance_distance_basis_points: optionalDouble, binance_minus_chainlink_basis_points: optionalDouble,
  up_price_change_previous_1_point: optionalDouble, down_price_change_previous_1_point: optionalDouble, up_price_change_previous_2_points: optionalDouble, down_price_change_previous_2_points: optionalDouble, up_price_change_previous_3_points: optionalDouble, down_price_change_previous_3_points: optionalDouble,
  winner: optionalUtf8, up_wins_binary: optionalInt64,
  future_maximum_up_price: optionalDouble, future_maximum_down_price: optionalDouble, future_minimum_up_price: optionalDouble, future_minimum_down_price: optionalDouble, future_final_up_price: optionalDouble, future_final_down_price: optionalDouble,
  future_seconds_until_up_price_greater_than_or_equal_090: optionalDouble, future_seconds_until_down_price_greater_than_or_equal_090: optionalDouble,
  future_reaches_up_090: { type: 'BOOLEAN' }, future_reaches_up_095: { type: 'BOOLEAN' }, future_reaches_up_099: { type: 'BOOLEAN' }, future_reaches_down_090: { type: 'BOOLEAN' }, future_reaches_down_095: { type: 'BOOLEAN' }, future_reaches_down_099: { type: 'BOOLEAN' },
  data_quality_flags: { type: 'UTF8' },
};

export const rejectedMarketsParquetSchema: ParquetSchemaDefinition = {
  market_slug: optionalUtf8, condition_id: optionalUtf8, question: optionalUtf8, rejection_reason: { type: 'UTF8' }, raw_market_file_path: { type: 'UTF8' }, data_quality_flags: { type: 'UTF8' },
};
