import type { FuturePriceLabels, NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint, PriceHistoryQualityMetrics } from './domain.js';
import { calculateSecondsLeft } from './calculations.js';

export interface BuildNormalizedPricePointsForMarketResult { pricePoints: NormalizedPricePoint[]; skippedRowsMissingPolymarketPrice: number; skippedRowsInvalidPolymarketPrice: number; }
export interface BuildNormalizedPricePointsForMarketParameters { market: NormalizedMarket; upPriceHistory: PriceHistoryPoint[]; downPriceHistory: PriceHistoryPoint[]; requestedFidelityMinutes: number; }
const futureThresholds = [0.75, 0.8, 0.9, 0.95, 0.99] as const;

export function buildNormalizedPricePointsForMarket(parameters: BuildNormalizedPricePointsForMarketParameters): NormalizedPricePoint[] { return buildNormalizedPricePointsForMarketWithSkipCount(parameters).pricePoints; }
export function buildNormalizedPricePointsForMarketWithSkipCount({ market, upPriceHistory, downPriceHistory, requestedFidelityMinutes }: BuildNormalizedPricePointsForMarketParameters): BuildNormalizedPricePointsForMarketResult {
  const upPriceByTimestamp = new Map(upPriceHistory.map((p) => [p.timestampMilliseconds, p.price]));
  const downPriceByTimestamp = new Map(downPriceHistory.map((p) => [p.timestampMilliseconds, p.price]));
  const allTimestamps = [...new Set([...upPriceByTimestamp.keys(), ...downPriceByTimestamp.keys()])].sort((a, b) => a - b);
  const baseQualityFlags = mergeUniqueFlags([...market.dataQualityFlags, ...buildPriceHistoryQualityFlags('up', upPriceHistory, market, requestedFidelityMinutes), ...buildPriceHistoryQualityFlags('down', downPriceHistory, market, requestedFidelityMinutes)]);
  let skippedRowsMissingPolymarketPrice = 0;
  let skippedRowsInvalidPolymarketPrice = 0;
  const points = allTimestamps.flatMap((timestampMilliseconds) => {
    const upPrice = upPriceByTimestamp.get(timestampMilliseconds) ?? null;
    const downPrice = downPriceByTimestamp.get(timestampMilliseconds) ?? null;
    if (upPrice === null && downPrice === null) { skippedRowsMissingPolymarketPrice += 1; return []; }
    if (!isValidPrice(upPrice) || !isValidPrice(downPrice)) { skippedRowsInvalidPolymarketPrice += 1; return []; }
    const dataQualityFlags = [...baseQualityFlags];
    if (upPrice === null) dataQualityFlags.push('price_history_missing_up');
    if (downPrice === null) dataQualityFlags.push('price_history_missing_down');
    return [{ marketSlug: market.marketSlug, conditionId: market.conditionId, marketDuration: market.marketDuration, timestampMilliseconds, timestampIso: new Date(timestampMilliseconds).toISOString(), secondsLeft: calculateSecondsLeft(market.marketEndTimestampMilliseconds, timestampMilliseconds), targetPrice: market.targetPrice, upPrice, downPrice, winner: market.winner, isResolved: market.isResolved, dataQualityFlags: mergeUniqueFlags(dataQualityFlags) }];
  });
  return { pricePoints: addFutureLabels(points), skippedRowsMissingPolymarketPrice, skippedRowsInvalidPolymarketPrice };
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
      return [[`futureSecondsUntilUpPriceGreaterThanOrEqual${suffix}`, upHit === null ? null : Math.max(0, (upHit.timestampMilliseconds - pricePoint.timestampMilliseconds) / 1_000)], [`futureSecondsUntilDownPriceGreaterThanOrEqual${suffix}`, downHit === null ? null : Math.max(0, (downHit.timestampMilliseconds - pricePoint.timestampMilliseconds) / 1_000)], [`futureReachesUp${suffix}`, upHit !== null], [`futureReachesDown${suffix}`, downHit !== null]];
    }));
    return { ...pricePoint, futureMaximumUpPrice: futureUpPrices.length === 0 ? null : Math.max(...futureUpPrices), futureMaximumDownPrice: futureDownPrices.length === 0 ? null : Math.max(...futureDownPrices), futureMinimumUpPrice: futureUpPrices.length === 0 ? null : Math.min(...futureUpPrices), futureMinimumDownPrice: futureDownPrices.length === 0 ? null : Math.min(...futureDownPrices), futureFinalUpPrice: lastPresentPrice(futureSlice.map((point) => point.upPrice)), futureFinalDownPrice: lastPresentPrice(futureSlice.map((point) => point.downPrice)), ...labels } as NormalizedPricePoint;
  });
}
export function calculatePriceHistoryQualityMetrics(priceHistory: PriceHistoryPoint[]): PriceHistoryQualityMetrics { if (priceHistory.length === 0) return { pointsCount: 0, minimumTimestampMilliseconds: null, maximumTimestampMilliseconds: null, medianGapMilliseconds: null, maximumGapMilliseconds: null }; const ordered = [...priceHistory].sort((a,b)=>a.timestampMilliseconds-b.timestampMilliseconds); const gaps = ordered.slice(1).map((p,i)=>p.timestampMilliseconds-(ordered[i]?.timestampMilliseconds ?? p.timestampMilliseconds)); return { pointsCount: ordered.length, minimumTimestampMilliseconds: ordered[0]?.timestampMilliseconds ?? null, maximumTimestampMilliseconds: ordered.at(-1)?.timestampMilliseconds ?? null, medianGapMilliseconds: gaps.length === 0 ? null : median(gaps), maximumGapMilliseconds: gaps.length === 0 ? null : Math.max(...gaps) }; }
export function buildPriceHistoryQualityFlags(outcome: 'up' | 'down', priceHistory: PriceHistoryPoint[], market: NormalizedMarket, requestedFidelityMinutes: number): string[] { const metrics = calculatePriceHistoryQualityMetrics(priceHistory); const flags: string[] = []; if (metrics.pointsCount === 0) flags.push('price_history_empty', `price_history_missing_${outcome}`); if (metrics.pointsCount < minimumExpectedPricePointsForDuration(market.marketDuration)) flags.push('price_history_too_few_points_for_duration'); if (metrics.medianGapMilliseconds !== null && metrics.medianGapMilliseconds > requestedFidelityMinutes * 60_000 * 2) flags.push('price_history_too_coarse'); if (metrics.minimumTimestampMilliseconds === null || metrics.minimumTimestampMilliseconds > market.marketStartTimestampMilliseconds + requestedFidelityMinutes * 60_000 * 2) flags.push('price_history_does_not_cover_market_start'); if (metrics.maximumTimestampMilliseconds === null || metrics.maximumTimestampMilliseconds < market.marketEndTimestampMilliseconds - requestedFidelityMinutes * 60_000 * 2) flags.push('price_history_does_not_cover_market_end'); return flags; }
function isValidPrice(price: number | null): boolean { return price === null || (Number.isFinite(price) && price >= 0 && price <= 1); }
function median(values: number[]): number { const ordered = [...values].sort((a,b)=>a-b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 === 0 ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2 : ordered[middle] ?? 0; }
function mergeUniqueFlags(flags: string[]): string[] { return [...new Set(flags)]; }
function thresholdSuffix(threshold: number): string { return Math.round(threshold * 100).toString().padStart(3, '0'); }
function lastPresentPrice(prices: Array<number | null>): number | null { return [...prices].reverse().find((price): price is number => price !== null) ?? null; }
function minimumExpectedPricePointsForDuration(marketDuration: NormalizedMarket['marketDuration']): number { if (marketDuration === '1h') return 10; if (marketDuration === '4h') return 30; return 100; }
