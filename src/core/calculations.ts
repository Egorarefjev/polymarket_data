export function normalizeTimestampMilliseconds(timestampValue: number): number {
  if (!Number.isFinite(timestampValue) || timestampValue <= 0) {
    throw new Error(`Invalid timestamp value: ${timestampValue}`);
  }

  // Normalize by magnitude instead of trusting one source-specific schema forever.
  if (timestampValue >= 10_000_000_000_000_000) {
    return Math.floor(timestampValue / 1_000);
  }

  if (timestampValue >= 10_000_000_000_000) {
    return Math.floor(timestampValue / 1_000);
  }

  if (timestampValue < 10_000_000_000) {
    return Math.floor(timestampValue * 1_000);
  }

  return Math.floor(timestampValue);
}

export function calculateSecondsLeft(marketEndTimestampMilliseconds: number, timestampMilliseconds: number): number {
  return Math.max(0, Math.floor((marketEndTimestampMilliseconds - timestampMilliseconds) / 1_000));
}

export interface DistanceToTarget {
  distanceUsd: number;
  distanceBasisPoints: number;
}

export function calculateDistanceToTarget(btcPrice: number, targetPrice: number): DistanceToTarget {
  if (targetPrice <= 0) {
    throw new Error('Target price must be greater than zero');
  }

  const distanceUsd = btcPrice - targetPrice;
  return {
    distanceUsd,
    distanceBasisPoints: (distanceUsd / targetPrice) * 10_000,
  };
}
