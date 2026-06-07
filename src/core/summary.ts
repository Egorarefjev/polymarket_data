import type { MarketSummary, NormalizedMarket, NormalizedPricePoint } from './domain.js';
import { mergeDataQualityFlags } from './validation.js';

const probabilityThresholds = [0.75, 0.8, 0.9, 0.95, 0.99] as const;

export function buildMarketSummary(market: NormalizedMarket, pricePoints: NormalizedPricePoint[]): MarketSummary {
  const orderedPricePoints = [...pricePoints].sort(
    (leftPricePoint, rightPricePoint) => leftPricePoint.timestampMilliseconds - rightPricePoint.timestampMilliseconds,
  );
  const lastPricePoint = orderedPricePoints.at(-1) ?? null;
  const upStats = priceStats(orderedPricePoints.map((pricePoint) => pricePoint.upPrice));
  const downStats = priceStats(orderedPricePoints.map((pricePoint) => pricePoint.downPrice));
  const dataQualityFlags = mergeDataQualityFlags(market.dataQualityFlags, ...orderedPricePoints.map((pricePoint) => pricePoint.dataQualityFlags));

  return {
    marketSlug: market.marketSlug,
    conditionId: market.conditionId,
    marketStartTimestampMilliseconds: market.marketStartTimestampMilliseconds,
    marketEndTimestampMilliseconds: market.marketEndTimestampMilliseconds,
    targetPrice: market.targetPrice ?? 0,
    winner: market.winner,
    primaryPriceSourceName: lastPricePoint?.primaryPriceSourceName ?? null,
    closePrimaryPrice: lastPricePoint?.primaryPrice ?? null,
    finalPrimaryDistanceBasisPoints: lastPricePoint?.primaryDistanceBasisPoints ?? null,
    closeChainlinkPrice: lastPricePoint?.chainlinkPrice ?? null,
    finalChainlinkDistanceBasisPoints: lastPricePoint?.chainlinkDistanceBasisPoints ?? null,
    closeBinancePrice: lastPricePoint?.binancePrice ?? null,
    finalBinanceDistanceBasisPoints: lastPricePoint?.binanceDistanceBasisPoints ?? null,
    finalBinanceMinusChainlinkBasisPoints: lastPricePoint?.binanceMinusChainlinkBasisPoints ?? null,
    maximumUpPrice: upStats.maximum,
    maximumDownPrice: downStats.maximum,
    upPriceOpen: upStats.open,
    downPriceOpen: downStats.open,
    upPriceClose: upStats.close,
    downPriceClose: downStats.close,
    upPriceMinimum: upStats.minimum,
    upPriceMaximum: upStats.maximum,
    downPriceMinimum: downStats.minimum,
    downPriceMaximum: downStats.maximum,
    upPriceRange: upStats.range,
    downPriceRange: downStats.range,
    upPriceLast: upStats.close,
    downPriceLast: downStats.close,
    upPriceMean: upStats.mean,
    downPriceMean: downStats.mean,
    upPriceMedian: upStats.median,
    downPriceMedian: downStats.median,
    upPriceStandardDeviation: upStats.standardDeviation,
    downPriceStandardDeviation: downStats.standardDeviation,
    upPriceNumberOfObservations: upStats.count,
    downPriceNumberOfObservations: downStats.count,
    pricePointsCount: orderedPricePoints.length,
    firstTimestampUpPriceGreaterThanOrEqual075: firstTimestampAtThreshold(orderedPricePoints, 'upPrice', probabilityThresholds[0]),
    firstTimestampUpPriceGreaterThanOrEqual080: firstTimestampAtThreshold(orderedPricePoints, 'upPrice', probabilityThresholds[1]),
    firstTimestampUpPriceGreaterThanOrEqual090: firstTimestampAtThreshold(orderedPricePoints, 'upPrice', probabilityThresholds[2]),
    firstTimestampUpPriceGreaterThanOrEqual095: firstTimestampAtThreshold(orderedPricePoints, 'upPrice', probabilityThresholds[3]),
    firstTimestampUpPriceGreaterThanOrEqual099: firstTimestampAtThreshold(orderedPricePoints, 'upPrice', probabilityThresholds[4]),
    secondsLeftAtFirstUpPriceGreaterThanOrEqual090: firstSecondsLeftAtThreshold(orderedPricePoints, 'upPrice', probabilityThresholds[2]),
    firstTimestampDownPriceGreaterThanOrEqual075: firstTimestampAtThreshold(orderedPricePoints, 'downPrice', probabilityThresholds[0]),
    firstTimestampDownPriceGreaterThanOrEqual080: firstTimestampAtThreshold(orderedPricePoints, 'downPrice', probabilityThresholds[1]),
    firstTimestampDownPriceGreaterThanOrEqual090: firstTimestampAtThreshold(orderedPricePoints, 'downPrice', probabilityThresholds[2]),
    firstTimestampDownPriceGreaterThanOrEqual095: firstTimestampAtThreshold(orderedPricePoints, 'downPrice', probabilityThresholds[3]),
    firstTimestampDownPriceGreaterThanOrEqual099: firstTimestampAtThreshold(orderedPricePoints, 'downPrice', probabilityThresholds[4]),
    secondsLeftAtFirstDownPriceGreaterThanOrEqual090: firstSecondsLeftAtThreshold(orderedPricePoints, 'downPrice', probabilityThresholds[2]),
    dataQualityFlags,
  };
}

function firstTimestampAtThreshold(
  pricePoints: NormalizedPricePoint[],
  priceFieldName: 'upPrice' | 'downPrice',
  threshold: number,
): number | null {
  return pricePoints.find((pricePoint) => (pricePoint[priceFieldName] ?? -Infinity) >= threshold)?.timestampMilliseconds ?? null;
}

function firstSecondsLeftAtThreshold(
  pricePoints: NormalizedPricePoint[],
  priceFieldName: 'upPrice' | 'downPrice',
  threshold: number,
): number | null {
  return pricePoints.find((pricePoint) => (pricePoint[priceFieldName] ?? -Infinity) >= threshold)?.secondsLeft ?? null;
}

function priceStats(prices: Array<number | null>): {
  open: number | null;
  close: number | null;
  minimum: number | null;
  maximum: number | null;
  range: number | null;
  mean: number | null;
  median: number | null;
  standardDeviation: number | null;
  count: number;
} {
  const presentPrices = prices.filter((price): price is number => price !== null);
  if (presentPrices.length === 0) return { open: null, close: null, minimum: null, maximum: null, range: null, mean: null, median: null, standardDeviation: null, count: 0 };
  const minimum = Math.min(...presentPrices);
  const maximum = Math.max(...presentPrices);
  const mean = presentPrices.reduce((sum, price) => sum + price, 0) / presentPrices.length;
  const variance = presentPrices.reduce((sum, price) => sum + (price - mean) ** 2, 0) / presentPrices.length;
  return {
    open: presentPrices[0] ?? null,
    close: presentPrices.at(-1) ?? null,
    minimum,
    maximum,
    range: maximum - minimum,
    mean,
    median: median(presentPrices),
    standardDeviation: Math.sqrt(variance),
    count: presentPrices.length,
  };
}

function median(values: number[]): number {
  const orderedValues = [...values].sort((leftValue, rightValue) => leftValue - rightValue);
  const middleIndex = Math.floor(orderedValues.length / 2);
  return orderedValues.length % 2 === 0
    ? ((orderedValues[middleIndex - 1] ?? 0) + (orderedValues[middleIndex] ?? 0)) / 2
    : orderedValues[middleIndex] ?? 0;
}
