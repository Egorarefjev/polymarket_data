import type { ExternalPricePoint, FuturePriceLabels, NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint, PriceHistoryQualityMetrics, PrimaryPriceSourceName } from './domain.js';
import { calculateDistanceToTarget, calculateSecondsLeft } from './calculations.js';

export interface BuildNormalizedPricePointsForMarketResult {
  pricePoints: NormalizedPricePoint[];
  skippedRowsMissingPrimaryPriceBeforeTimestamp: number;
}

interface BuildNormalizedPricePointsForMarketParameters {
  market: NormalizedMarket;
  upPriceHistory: PriceHistoryPoint[];
  downPriceHistory: PriceHistoryPoint[];
  primaryExternalPricePoints: ExternalPricePoint[];
  primaryPriceSourceName?: PrimaryPriceSourceName;
  binanceSecondaryPricePoints?: ExternalPricePoint[];
  isBinanceSecondarySignalEnabled: boolean;
  isProxyPrimaryPriceSourceForDebug?: boolean;
  requestedFidelityMinutes: number;
}

const futureThresholds = [0.75, 0.8, 0.9, 0.95, 0.99] as const;

export function buildNormalizedPricePointsForMarket(parameters: BuildNormalizedPricePointsForMarketParameters): NormalizedPricePoint[] {
  return buildNormalizedPricePointsForMarketWithSkipCount(parameters).pricePoints;
}

export function buildNormalizedPricePointsForMarketWithSkipCount(parameters: BuildNormalizedPricePointsForMarketParameters): BuildNormalizedPricePointsForMarketResult {
  const {
    market,
    upPriceHistory,
    downPriceHistory,
    primaryExternalPricePoints,
    primaryPriceSourceName = parameters.isProxyPrimaryPriceSourceForDebug ? 'binance_proxy' : 'chainlink',
    binanceSecondaryPricePoints = [],
    isBinanceSecondarySignalEnabled,
    isProxyPrimaryPriceSourceForDebug = false,
    requestedFidelityMinutes,
  } = parameters;
  if (market.targetPrice === null) return { pricePoints: [], skippedRowsMissingPrimaryPriceBeforeTimestamp: 0 };

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
  const isOfficialChainlinkMode = primaryPriceSourceName === 'chainlink';
  const baseQualityFlags = mergeUniqueFlags([
    ...market.dataQualityFlags,
    ...buildPriceHistoryQualityFlags('up', upPriceHistory, market, requestedFidelityMinutes),
    ...buildPriceHistoryQualityFlags('down', downPriceHistory, market, requestedFidelityMinutes),
    ...(isOfficialChainlinkMode && orderedPrimaryPricePoints.length === 0 ? ['chainlink_data_unavailable'] : []),
    ...(isOfficialChainlinkMode && isExternalHistoryTooSparse(orderedPrimaryPricePoints, requestedFidelityMinutes) ? ['chainlink_history_too_sparse'] : []),
    ...(isProxyPrimaryPriceSourceForDebug ? ['proxy_primary_price_source_not_official'] : []),
  ]);

  let skippedRowsMissingPrimaryPriceBeforeTimestamp = 0;
  const pricePointsWithoutFutureLabels = allTimestamps.flatMap((timestampMilliseconds) => {
    // Causal as-of join: for each Polymarket price timestamp, use only the latest
    // primary price point at or before that timestamp. Never use future prices.
    const primaryPricePoint = findLatestExternalPricePointAtOrBeforeTimestamp(orderedPrimaryPricePoints, timestampMilliseconds);
    if (primaryPricePoint === null) {
      skippedRowsMissingPrimaryPriceBeforeTimestamp += 1;
      return [];
    }

    const primaryDistanceToTarget = calculateDistanceToTarget(primaryPricePoint.price, market.targetPrice ?? 0);
    const dataQualityFlags = [...baseQualityFlags];
    if (!upPriceByTimestamp.has(timestampMilliseconds)) dataQualityFlags.push('price_history_missing_up');
    if (!downPriceByTimestamp.has(timestampMilliseconds)) dataQualityFlags.push('price_history_missing_down');

    const binancePricePoint = findLatestExternalPricePointAtOrBeforeTimestamp(orderedBinancePricePoints, timestampMilliseconds);
    const binanceDistanceToTarget = binancePricePoint === null ? null : calculateDistanceToTarget(binancePricePoint.price, market.targetPrice ?? 0);
    if (isBinanceSecondarySignalEnabled && binancePricePoint === null) dataQualityFlags.push('binance_secondary_signal_missing');
    const chainlinkDistanceBasisPoints = isOfficialChainlinkMode ? primaryDistanceToTarget.distanceBasisPoints : null;
    const binanceMinusChainlinkBasisPoints = binanceDistanceToTarget === null || chainlinkDistanceBasisPoints === null
      ? null
      : binanceDistanceToTarget.distanceBasisPoints - chainlinkDistanceBasisPoints;
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
        upPrice: upPriceByTimestamp.get(timestampMilliseconds) ?? null,
        downPrice: downPriceByTimestamp.get(timestampMilliseconds) ?? null,
        primaryPriceSourceName,
        primaryPrice: primaryPricePoint.price,
        primaryTimestampMilliseconds: primaryPricePoint.timestampMilliseconds,
        primaryDistanceUsd: primaryDistanceToTarget.distanceUsd,
        primaryDistanceBasisPoints: primaryDistanceToTarget.distanceBasisPoints,
        chainlinkPrice: isOfficialChainlinkMode ? primaryPricePoint.price : null,
        chainlinkTimestampMilliseconds: isOfficialChainlinkMode ? primaryPricePoint.timestampMilliseconds : null,
        chainlinkDistanceUsd: isOfficialChainlinkMode ? primaryDistanceToTarget.distanceUsd : null,
        chainlinkDistanceBasisPoints,
        binancePrice: binancePricePoint?.price ?? null,
        binanceTimestampMilliseconds: binancePricePoint?.timestampMilliseconds ?? null,
        binanceDistanceUsd: binanceDistanceToTarget?.distanceUsd ?? null,
        binanceDistanceBasisPoints: binanceDistanceToTarget?.distanceBasisPoints ?? null,
        binanceMinusChainlinkBasisPoints,
        winner: market.winner,
        isResolved: market.isResolved,
        dataQualityFlags: mergeUniqueFlags(dataQualityFlags),
      },
    ];
  });

  return { pricePoints: addFutureLabels(pricePointsWithoutFutureLabels), skippedRowsMissingPrimaryPriceBeforeTimestamp };
}

export function addFutureLabels<T extends Omit<NormalizedPricePoint, keyof FuturePriceLabels>>(pricePoints: T[]): NormalizedPricePoint[] {
  const orderedPricePoints = [...pricePoints].sort((left, right) => left.timestampMilliseconds - right.timestampMilliseconds);
  return orderedPricePoints.map((pricePoint, index) => {
    const futureSlice = orderedPricePoints.slice(index);
    const futureUpPrices = futureSlice.map((point) => point.upPrice).filter((price): price is number => price !== null);
    const futureDownPrices = futureSlice.map((point) => point.downPrice).filter((price): price is number => price !== null);
    const labels = Object.fromEntries(futureThresholds.flatMap((threshold) => {
      const suffix = thresholdSuffix(threshold);
      const upHit = futureSlice.find((point) => (point.upPrice ?? -Infinity) >= threshold) ?? null;
      const downHit = futureSlice.find((point) => (point.downPrice ?? -Infinity) >= threshold) ?? null;
      return [
        [`futureSecondsUntilUpPriceGreaterThanOrEqual${suffix}`, upHit === null ? null : Math.max(0, (upHit.timestampMilliseconds - pricePoint.timestampMilliseconds) / 1_000)],
        [`futureSecondsUntilDownPriceGreaterThanOrEqual${suffix}`, downHit === null ? null : Math.max(0, (downHit.timestampMilliseconds - pricePoint.timestampMilliseconds) / 1_000)],
        [`futureReachesUp${suffix}`, upHit !== null],
        [`futureReachesDown${suffix}`, downHit !== null],
      ];
    }));
    return {
      ...pricePoint,
      futureMaximumUpPrice: futureUpPrices.length === 0 ? null : Math.max(...futureUpPrices),
      futureMaximumDownPrice: futureDownPrices.length === 0 ? null : Math.max(...futureDownPrices),
      futureMinimumUpPrice: futureUpPrices.length === 0 ? null : Math.min(...futureUpPrices),
      futureMinimumDownPrice: futureDownPrices.length === 0 ? null : Math.min(...futureDownPrices),
      futureFinalUpPrice: lastPresentPrice(futureSlice.map((point) => point.upPrice)),
      futureFinalDownPrice: lastPresentPrice(futureSlice.map((point) => point.downPrice)),
      ...labels,
    } as NormalizedPricePoint;
  });
}

export function findLatestExternalPricePointAtOrBeforeTimestamp(pricePoints: ExternalPricePoint[], timestampMilliseconds: number): ExternalPricePoint | null {
  let latestPricePoint: ExternalPricePoint | null = null;
  for (const pricePoint of pricePoints) {
    if (pricePoint.timestampMilliseconds > timestampMilliseconds) break;
    latestPricePoint = pricePoint;
  }
  return latestPricePoint;
}

export function findLatestBinancePricePointAtOrBeforeTimestamp(pricePoints: ExternalPricePoint[], timestampMilliseconds: number): ExternalPricePoint | null {
  return findLatestExternalPricePointAtOrBeforeTimestamp(pricePoints, timestampMilliseconds);
}

export function calculatePriceHistoryQualityMetrics(priceHistory: PriceHistoryPoint[]): PriceHistoryQualityMetrics {
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

function thresholdSuffix(threshold: number): string {
  return Math.round(threshold * 100).toString().padStart(3, '0');
}

function lastPresentPrice(prices: Array<number | null>): number | null {
  return [...prices].reverse().find((price): price is number => price !== null) ?? null;
}
