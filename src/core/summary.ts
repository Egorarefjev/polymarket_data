import type { MarketSummary, NormalizedMarket, NormalizedPricePoint } from './domain.js';
import { mergeDataQualityFlags } from './validation.js';

const probabilityThresholds = [0.75, 0.8, 0.9, 0.95, 0.99] as const;

export function buildMarketSummary(market: NormalizedMarket, pricePoints: NormalizedPricePoint[]): MarketSummary {
  const orderedPricePoints = [...pricePoints].sort(
    (leftPricePoint, rightPricePoint) => leftPricePoint.timestampMilliseconds - rightPricePoint.timestampMilliseconds,
  );
  const lastPricePoint = orderedPricePoints.at(-1) ?? null;
  const dataQualityFlags = mergeDataQualityFlags(market.dataQualityFlags, ...orderedPricePoints.map((pricePoint) => pricePoint.dataQualityFlags));

  return {
    marketSlug: market.marketSlug,
    conditionId: market.conditionId,
    marketStartTimestampMilliseconds: market.marketStartTimestampMilliseconds,
    marketEndTimestampMilliseconds: market.marketEndTimestampMilliseconds,
    targetPrice: market.targetPrice ?? 0,
    winner: market.winner,
    closeChainlinkPrice: lastPricePoint?.chainlinkPrice ?? null,
    finalChainlinkDistanceBasisPoints: lastPricePoint?.chainlinkDistanceBasisPoints ?? null,
    closeBinancePrice: lastPricePoint?.binancePrice ?? null,
    finalBinanceDistanceBasisPoints: lastPricePoint?.binanceDistanceBasisPoints ?? null,
    finalBinanceMinusChainlinkBasisPoints: lastPricePoint?.binanceMinusChainlinkBasisPoints ?? null,
    maximumUpPrice: maximumPrice(orderedPricePoints.map((pricePoint) => pricePoint.upPrice)),
    maximumDownPrice: maximumPrice(orderedPricePoints.map((pricePoint) => pricePoint.downPrice)),
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

function maximumPrice(prices: Array<number | null>): number | null {
  const presentPrices = prices.filter((price): price is number => price !== null);
  return presentPrices.length === 0 ? null : Math.max(...presentPrices);
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
