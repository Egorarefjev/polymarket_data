import type { NormalizedMarket } from './domain.js';

export interface MarketValidationResult {
  accepted: boolean;
  rejectionReason: string | null;
  dataQualityFlags: string[];
}

export function validateMarketForAnalysis(market: NormalizedMarket): MarketValidationResult {
  const dataQualityFlags = [...market.dataQualityFlags];

  if (market.targetPrice === null) {
    dataQualityFlags.push('target_price_missing');
    return { accepted: false, rejectionReason: 'target_price_missing', dataQualityFlags };
  }

  if (market.upTokenId === null || market.downTokenId === null) {
    dataQualityFlags.push('token_ids_missing');
    return { accepted: false, rejectionReason: 'token_ids_missing', dataQualityFlags };
  }

  if (market.marketEndTimestampMilliseconds <= market.marketStartTimestampMilliseconds) {
    dataQualityFlags.push('invalid_market_time_range');
    return { accepted: false, rejectionReason: 'invalid_market_time_range', dataQualityFlags };
  }

  return { accepted: true, rejectionReason: null, dataQualityFlags };
}

export function mergeDataQualityFlags(...dataQualityFlagCollections: string[][]): string[] {
  return [...new Set(dataQualityFlagCollections.flat())].sort();
}
