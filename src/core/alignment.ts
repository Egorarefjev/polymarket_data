import type { ExternalPricePoint, NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint } from './domain.js';
import { calculateDistanceToTarget, calculateSecondsLeft } from './calculations.js';

export function buildNormalizedPricePointsForMarket(parameters: {
  market: NormalizedMarket;
  upPriceHistory: PriceHistoryPoint[];
  downPriceHistory: PriceHistoryPoint[];
  primaryExternalPricePoints: ExternalPricePoint[];
  binanceSecondaryPricePoints?: ExternalPricePoint[];
  requestedFidelityMinutes: number;
}): NormalizedPricePoint[] {
  const { market, upPriceHistory, downPriceHistory, primaryExternalPricePoints, binanceSecondaryPricePoints = [], requestedFidelityMinutes } = parameters;
  if (market.targetPrice === null) return [];

  const upPriceByTimestamp = new Map(upPriceHistory.map((pricePoint) => [pricePoint.timestampMilliseconds, pricePoint.price]));
  const downPriceByTimestamp = new Map(downPriceHistory.map((pricePoint) => [pricePoint.timestampMilliseconds, pricePoint.price]));
  const allTimestamps = [...new Set([...upPriceByTimestamp.keys(), ...downPriceByTimestamp.keys()])].sort(
    (leftTimestamp, rightTimestamp) => leftTimestamp - rightTimestamp,
  );
  const orderedPrimaryPricePoints = [...primaryExternalPricePoints].sort(
    (leftPricePoint, rightPricePoint) => leftPricePoint.timestampMilliseconds - rightPricePoint.timestampMilliseconds,
  );
  const orderedBinancePricePoints = [...binanceSecondaryPricePoints].sort(
    (leftPricePoint, rightPricePoint) => leftPricePoint.timestampMilliseconds - rightPricePoint.timestampMilliseconds,
  );
  const baseQualityFlags = mergeUniqueFlags([
    ...market.dataQualityFlags,
    ...buildPriceHistoryQualityFlags('up', upPriceHistory, market, requestedFidelityMinutes),
    ...buildPriceHistoryQualityFlags('down', downPriceHistory, market, requestedFidelityMinutes),
    ...(orderedPrimaryPricePoints.length === 0 ? ['chainlink_data_unavailable'] : []),
    ...(isExternalHistoryTooSparse(orderedPrimaryPricePoints, requestedFidelityMinutes) ? ['chainlink_history_too_sparse'] : []),
  ]);

  return allTimestamps.flatMap((timestampMilliseconds) => {
    // Causal as-of join: for each Polymarket price timestamp, use only the latest
    // Chainlink BTC/USD Data Stream point at or before that timestamp. Never use future prices.
    const chainlinkPricePoint = findLatestExternalPricePointAtOrBeforeTimestamp(orderedPrimaryPricePoints, timestampMilliseconds);
    if (chainlinkPricePoint === null) return [];

    const chainlinkDistanceToTarget = calculateDistanceToTarget(chainlinkPricePoint.price, market.targetPrice ?? 0);
    const dataQualityFlags = [...baseQualityFlags];
    if (!upPriceByTimestamp.has(timestampMilliseconds)) dataQualityFlags.push('price_history_missing_up');
    if (!downPriceByTimestamp.has(timestampMilliseconds)) dataQualityFlags.push('price_history_missing_down');

    const binancePricePoint = findLatestExternalPricePointAtOrBeforeTimestamp(orderedBinancePricePoints, timestampMilliseconds);
    const binanceDistanceToTarget = binancePricePoint === null ? null : calculateDistanceToTarget(binancePricePoint.price, market.targetPrice ?? 0);
    if (binancePricePoint === null) dataQualityFlags.push('binance_secondary_signal_missing');
    const binanceMinusChainlinkBasisPoints = binanceDistanceToTarget === null
      ? null
      : binanceDistanceToTarget.distanceBasisPoints - chainlinkDistanceToTarget.distanceBasisPoints;
    if (binanceMinusChainlinkBasisPoints !== null && Math.abs(binanceMinusChainlinkBasisPoints) > 10) {
      dataQualityFlags.push('binance_chainlink_divergence_high');
    }

    return [
      {
        marketSlug: market.marketSlug,
        conditionId: market.conditionId,
        timestampMilliseconds,
        secondsLeft: calculateSecondsLeft(market.marketEndTimestampMilliseconds, timestampMilliseconds),
        targetPrice: market.targetPrice ?? 0,
        chainlinkPrice: chainlinkPricePoint.price,
        chainlinkTimestampMilliseconds: chainlinkPricePoint.timestampMilliseconds,
        chainlinkDistanceUsd: chainlinkDistanceToTarget.distanceUsd,
        chainlinkDistanceBasisPoints: chainlinkDistanceToTarget.distanceBasisPoints,
        binancePrice: binancePricePoint?.price ?? null,
        binanceTimestampMilliseconds: binancePricePoint?.timestampMilliseconds ?? null,
        binanceDistanceUsd: binanceDistanceToTarget?.distanceUsd ?? null,
        binanceDistanceBasisPoints: binanceDistanceToTarget?.distanceBasisPoints ?? null,
        binanceMinusChainlinkBasisPoints,
        upPrice: upPriceByTimestamp.get(timestampMilliseconds) ?? null,
        downPrice: downPriceByTimestamp.get(timestampMilliseconds) ?? null,
        winner: market.winner,
        isResolved: market.isResolved,
        dataQualityFlags: mergeUniqueFlags(dataQualityFlags),
      },
    ];
  });
}

export function findLatestExternalPricePointAtOrBeforeTimestamp<T extends { timestampMilliseconds: number }>(
  pricePoints: T[],
  timestampMilliseconds: number,
): T | null {
  if (pricePoints.length === 0) return null;
  let leftIndex = 0;
  let rightIndex = pricePoints.length - 1;
  let bestMatch: T | null = null;
  while (leftIndex <= rightIndex) {
    const middleIndex = Math.floor((leftIndex + rightIndex) / 2);
    const middlePricePoint = pricePoints[middleIndex];
    if (middlePricePoint === undefined) return bestMatch;
    if (middlePricePoint.timestampMilliseconds <= timestampMilliseconds) {
      bestMatch = middlePricePoint;
      leftIndex = middleIndex + 1;
    } else {
      rightIndex = middleIndex - 1;
    }
  }
  return bestMatch;
}

export function findLatestBinancePricePointAtOrBeforeTimestamp<T extends { timestampMilliseconds: number }>(
  pricePoints: T[],
  timestampMilliseconds: number,
): T | null {
  return findLatestExternalPricePointAtOrBeforeTimestamp(pricePoints, timestampMilliseconds);
}

export function calculatePriceHistoryQualityMetrics(priceHistory: PriceHistoryPoint[]) {
  if (priceHistory.length === 0) {
    return { pointsCount: 0, minimumTimestampMilliseconds: null, maximumTimestampMilliseconds: null, medianGapMilliseconds: null, maximumGapMilliseconds: null };
  }
  const orderedHistory = [...priceHistory].sort((leftPoint, rightPoint) => leftPoint.timestampMilliseconds - rightPoint.timestampMilliseconds);
  const gaps = orderedHistory.slice(1).map((pricePoint, index) => pricePoint.timestampMilliseconds - (orderedHistory[index]?.timestampMilliseconds ?? pricePoint.timestampMilliseconds));
  return {
    pointsCount: orderedHistory.length,
    minimumTimestampMilliseconds: orderedHistory[0]?.timestampMilliseconds ?? null,
    maximumTimestampMilliseconds: orderedHistory.at(-1)?.timestampMilliseconds ?? null,
    medianGapMilliseconds: gaps.length === 0 ? null : median(gaps),
    maximumGapMilliseconds: gaps.length === 0 ? null : Math.max(...gaps),
  };
}

export function buildPriceHistoryQualityFlags(
  outcome: 'up' | 'down',
  priceHistory: PriceHistoryPoint[],
  market: NormalizedMarket,
  requestedFidelityMinutes: number,
): string[] {
  const metrics = calculatePriceHistoryQualityMetrics(priceHistory);
  const flags: string[] = [];
  if (metrics.pointsCount === 0) flags.push('price_history_empty', `price_history_missing_${outcome}`);
  if (metrics.pointsCount < 3) flags.push('price_history_too_few_points_for_five_minute_market');
  if (metrics.medianGapMilliseconds !== null && metrics.medianGapMilliseconds > requestedFidelityMinutes * 60_000 * 2) flags.push('price_history_too_coarse');
  if (metrics.minimumTimestampMilliseconds === null || metrics.minimumTimestampMilliseconds > market.marketStartTimestampMilliseconds + requestedFidelityMinutes * 60_000 * 2) {
    flags.push('price_history_does_not_cover_market_start');
  }
  if (metrics.maximumTimestampMilliseconds === null || metrics.maximumTimestampMilliseconds < market.marketEndTimestampMilliseconds - requestedFidelityMinutes * 60_000 * 2) {
    flags.push('price_history_does_not_cover_market_end');
  }
  return flags;
}

function isExternalHistoryTooSparse(pricePoints: ExternalPricePoint[], requestedFidelityMinutes: number): boolean {
  if (pricePoints.length < 2) return pricePoints.length === 0;
  const gaps = pricePoints.slice(1).map((pricePoint, index) => pricePoint.timestampMilliseconds - (pricePoints[index]?.timestampMilliseconds ?? pricePoint.timestampMilliseconds));
  return median(gaps) > requestedFidelityMinutes * 60_000 * 2;
}

function median(values: number[]): number {
  const orderedValues = [...values].sort((leftValue, rightValue) => leftValue - rightValue);
  const middleIndex = Math.floor(orderedValues.length / 2);
  return orderedValues.length % 2 === 0
    ? ((orderedValues[middleIndex - 1] ?? 0) + (orderedValues[middleIndex] ?? 0)) / 2
    : orderedValues[middleIndex] ?? 0;
}

function mergeUniqueFlags(flags: string[]): string[] {
  return [...new Set(flags)];
}
