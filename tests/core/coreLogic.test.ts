import { describe, expect, it } from 'vitest';
import { calculateDistanceToTarget, calculateSecondsLeft, normalizeTimestampMilliseconds } from '../../src/core/calculations.js';
import { determineMarketWinner, extractTargetPrice, parseOutcomePrices, parseOutcomes } from '../../src/core/parsing.js';
import { validateMarketForAnalysis } from '../../src/core/validation.js';
import { buildMarketSummary } from '../../src/core/summary.js';
import { buildNormalizedPricePointsForMarket, buildPriceHistoryQualityFlags, findLatestBinancePricePointAtOrBeforeTimestamp } from '../../src/core/alignment.js';
import type { NormalizedMarket, NormalizedPricePoint } from '../../src/core/domain.js';

describe('core calculations', () => {
  it('normalizes seconds, milliseconds, and microseconds to milliseconds', () => {
    expect(normalizeTimestampMilliseconds(1_717_200_000)).toBe(1_717_200_000_000);
    expect(normalizeTimestampMilliseconds(1_717_200_000_000)).toBe(1_717_200_000_000);
    expect(normalizeTimestampMilliseconds(1_717_200_000_000_000)).toBe(1_717_200_000_000);
  });

  it('calculates seconds left without negative values', () => {
    expect(calculateSecondsLeft(2_000, 1_000)).toBe(1);
    expect(calculateSecondsLeft(1_000, 2_000)).toBe(0);
  });

  it('calculates USD and basis point distance to target', () => {
    expect(calculateDistanceToTarget(101_000, 100_000)).toEqual({ distanceUsd: 1_000, distanceBasisPoints: 100 });
  });
});

describe('core parsing', () => {
  it('parses outcomes and outcome prices from JSON strings and arrays', () => {
    expect(parseOutcomes('["Up","Down"]')).toEqual(['Up', 'Down']);
    expect(parseOutcomePrices(['0.25', '0.75'])).toEqual([0.25, 0.75]);
  });

  it('extracts target price from explicit metadata before text', () => {
    expect(extractTargetPrice({ targetPrice: '100,250', question: 'BTC Up or Down from $99,000 target?' })).toBe(100_250);
  });

  it('extracts target price from question text defensively', () => {
    expect(extractTargetPrice({ question: 'Bitcoin Up or Down - starting price $104,500?' })).toBe(104_500);
  });

  it('returns null when no target price is present', () => {
    expect(extractTargetPrice({ question: 'Bitcoin Up or Down in the next 5 minutes?' })).toBeNull();
  });

  it('determines winner from final outcome prices', () => {
    expect(determineMarketWinner({}, ['Up', 'Down'], [1, 0])).toBe('up');
    expect(determineMarketWinner({ winner: 'Down' }, ['Up', 'Down'], [0.5, 0.5])).toBe('down');
  });
});

describe('market validation and summary', () => {
  const market: NormalizedMarket = {
    marketSlug: 'btc-updown-5m-example',
    conditionId: 'condition',
    question: 'Bitcoin Up or Down from $100,000?',
    marketStartTimestampMilliseconds: 1_000,
    marketEndTimestampMilliseconds: 301_000,
    upTokenId: 'up-token',
    downTokenId: 'down-token',
    targetPrice: 100_000,
    winner: 'up',
    isResolved: true,
    isClosed: true,
    rawOutcomes: '["Up","Down"]',
    rawOutcomePrices: '["1","0"]',
    dataQualityFlags: [],
  };

  it('accepts complete markets and rejects markets without target', () => {
    expect(validateMarketForAnalysis(market).accepted).toBe(true);
    expect(validateMarketForAnalysis({ ...market, targetPrice: null }).rejectionReason).toBe('target_price_missing');
  });

  it('builds market summary thresholds', () => {
    const pricePoints: NormalizedPricePoint[] = [
      { marketSlug: market.marketSlug, conditionId: market.conditionId, timestampMilliseconds: 101_000, secondsLeft: 200, targetPrice: 100_000, chainlinkPrice: 100_500, chainlinkTimestampMilliseconds: 101_000, chainlinkDistanceUsd: 500, chainlinkDistanceBasisPoints: 50, binancePrice: 100_510, binanceTimestampMilliseconds: 101_000, binanceDistanceUsd: 510, binanceDistanceBasisPoints: 51, binanceMinusChainlinkBasisPoints: 1, upPrice: 0.7, downPrice: 0.3, winner: 'up', isResolved: true, dataQualityFlags: [] },
      { marketSlug: market.marketSlug, conditionId: market.conditionId, timestampMilliseconds: 201_000, secondsLeft: 100, targetPrice: 100_000, chainlinkPrice: 101_000, chainlinkTimestampMilliseconds: 201_000, chainlinkDistanceUsd: 1_000, chainlinkDistanceBasisPoints: 100, binancePrice: 101_010, binanceTimestampMilliseconds: 201_000, binanceDistanceUsd: 1_010, binanceDistanceBasisPoints: 101, binanceMinusChainlinkBasisPoints: 1, upPrice: 0.92, downPrice: 0.08, winner: 'up', isResolved: true, dataQualityFlags: [] },
    ];
    const summary = buildMarketSummary(market, pricePoints);
    expect(summary.maximumUpPrice).toBe(0.92);
    expect(summary.firstTimestampUpPriceGreaterThanOrEqual090).toBe(201_000);
    expect(summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual090).toBe(100);
  });
});



const alignmentMarket: NormalizedMarket = {
  marketSlug: 'btc-updown-5m-example',
  conditionId: 'condition',
  question: 'Bitcoin Up or Down from $100,000?',
  marketStartTimestampMilliseconds: 1_000,
  marketEndTimestampMilliseconds: 301_000,
  upTokenId: 'up-token',
  downTokenId: 'down-token',
  targetPrice: 100_000,
  winner: 'up',
  isResolved: true,
  isClosed: true,
  rawOutcomes: '["Up","Down"]',
  rawOutcomePrices: '["1","0"]',
  dataQualityFlags: [],
};
describe('causal as-of price alignment', () => {
  it('chooses the price before the timestamp when one point is before and one is after', () => {
    expect(findLatestBinancePricePointAtOrBeforeTimestamp([
      { timestampMilliseconds: 1_000, btcPrice: 100 },
      { timestampMilliseconds: 3_000, btcPrice: 300 },
    ], 2_000)).toEqual({ timestampMilliseconds: 1_000, btcPrice: 100 });
  });

  it('returns null when only a future price exists', () => {
    expect(findLatestBinancePricePointAtOrBeforeTimestamp([{ timestampMilliseconds: 3_000, btcPrice: 300 }], 2_000)).toBeNull();
  });

  it('chooses the exact timestamp when one exists', () => {
    expect(findLatestBinancePricePointAtOrBeforeTimestamp([
      { timestampMilliseconds: 1_000, btcPrice: 100 },
      { timestampMilliseconds: 2_000, btcPrice: 200 },
    ], 2_000)).toEqual({ timestampMilliseconds: 2_000, btcPrice: 200 });
  });

  it('does not use future external prices in normalized rows', () => {
    const rows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.6 }],
      downPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.4 }],
      primaryExternalPricePoints: [{ timestampMilliseconds: 3_000, price: 100_100, sourceName: 'chainlink' }],
      requestedFidelityMinutes: 1,
    });
    expect(rows).toEqual([]);
  });
});

describe('price history quality flags', () => {
  it('flags one or two points as too few for five-minute market analysis', () => {
    expect(buildPriceHistoryQualityFlags('up', [{ timestampMilliseconds: 1_000, price: 0.5 }], alignmentMarket, 1)).toContain('price_history_too_few_points_for_five_minute_market');
    expect(buildPriceHistoryQualityFlags('down', [
      { timestampMilliseconds: 1_000, price: 0.5 },
      { timestampMilliseconds: 301_000, price: 0.6 },
    ], alignmentMarket, 1)).toContain('price_history_too_few_points_for_five_minute_market');
  });
});
