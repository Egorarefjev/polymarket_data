import type { BinancePricePoint, NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint } from './domain.js';
import { calculateDistanceToTarget, calculateSecondsLeft } from './calculations.js';

export function buildNormalizedPricePointsForMarket(parameters: {
  market: NormalizedMarket;
  upPriceHistory: PriceHistoryPoint[];
  downPriceHistory: PriceHistoryPoint[];
  binancePricePoints: BinancePricePoint[];
}): NormalizedPricePoint[] {
  const { market, upPriceHistory, downPriceHistory, binancePricePoints } = parameters;
  if (market.targetPrice === null) return [];

  const upPriceByTimestamp = new Map(upPriceHistory.map((pricePoint) => [pricePoint.timestampMilliseconds, pricePoint.price]));
  const downPriceByTimestamp = new Map(downPriceHistory.map((pricePoint) => [pricePoint.timestampMilliseconds, pricePoint.price]));
  const allTimestamps = [...new Set([...upPriceByTimestamp.keys(), ...downPriceByTimestamp.keys()])].sort(
    (leftTimestamp, rightTimestamp) => leftTimestamp - rightTimestamp,
  );
  const orderedBinancePricePoints = [...binancePricePoints].sort(
    (leftPricePoint, rightPricePoint) => leftPricePoint.timestampMilliseconds - rightPricePoint.timestampMilliseconds,
  );

  return allTimestamps.flatMap((timestampMilliseconds) => {
    // This is an as-of join: for each Polymarket price timestamp we use the nearest BTC
    // archive point. We do not interpolate or fabricate BTC prices between observations.
    const nearestBinancePricePoint = findNearestBinancePricePoint(orderedBinancePricePoints, timestampMilliseconds);
    if (nearestBinancePricePoint === null) return [];

    const distanceToTarget = calculateDistanceToTarget(nearestBinancePricePoint.btcPrice, market.targetPrice ?? 0);
    const dataQualityFlags = [...market.dataQualityFlags];
    if (!upPriceByTimestamp.has(timestampMilliseconds)) dataQualityFlags.push('price_history_missing_up');
    if (!downPriceByTimestamp.has(timestampMilliseconds)) dataQualityFlags.push('price_history_missing_down');

    return [
      {
        marketSlug: market.marketSlug,
        conditionId: market.conditionId,
        timestampMilliseconds,
        secondsLeft: calculateSecondsLeft(market.marketEndTimestampMilliseconds, timestampMilliseconds),
        targetPrice: market.targetPrice ?? 0,
        btcPrice: nearestBinancePricePoint.btcPrice,
        distanceUsd: distanceToTarget.distanceUsd,
        distanceBasisPoints: distanceToTarget.distanceBasisPoints,
        upPrice: upPriceByTimestamp.get(timestampMilliseconds) ?? null,
        downPrice: downPriceByTimestamp.get(timestampMilliseconds) ?? null,
        winner: market.winner,
        isResolved: market.isResolved,
        dataQualityFlags,
      },
    ];
  });
}

function findNearestBinancePricePoint(binancePricePoints: BinancePricePoint[], timestampMilliseconds: number): BinancePricePoint | null {
  if (binancePricePoints.length === 0) return null;
  let leftIndex = 0;
  let rightIndex = binancePricePoints.length - 1;
  while (leftIndex < rightIndex) {
    const middleIndex = Math.floor((leftIndex + rightIndex) / 2);
    const middlePricePoint = binancePricePoints[middleIndex];
    if (middlePricePoint === undefined) return null;
    if (middlePricePoint.timestampMilliseconds < timestampMilliseconds) leftIndex = middleIndex + 1;
    else rightIndex = middleIndex;
  }
  const candidateAfter = binancePricePoints[leftIndex] ?? null;
  const candidateBefore = binancePricePoints[leftIndex - 1] ?? null;
  if (candidateBefore === null) return candidateAfter;
  if (candidateAfter === null) return candidateBefore;
  return Math.abs(candidateBefore.timestampMilliseconds - timestampMilliseconds) <=
    Math.abs(candidateAfter.timestampMilliseconds - timestampMilliseconds)
    ? candidateBefore
    : candidateAfter;
}
