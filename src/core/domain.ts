export type MarketOutcome = 'Up' | 'Down' | 'Yes' | 'No' | 'Unknown';
export type MarketWinner = 'up' | 'down' | 'unknown' | null;

export interface NormalizedMarket {
  marketSlug: string;
  conditionId: string | null;
  question: string;
  marketStartTimestampMilliseconds: number;
  marketEndTimestampMilliseconds: number;
  upTokenId: string | null;
  downTokenId: string | null;
  targetPrice: number | null;
  winner: MarketWinner;
  isResolved: boolean;
  isClosed: boolean;
  rawOutcomes: string;
  rawOutcomePrices: string;
  dataQualityFlags: string[];
}

export interface RejectedMarket {
  marketSlug: string | null;
  conditionId: string | null;
  question: string | null;
  rejectionReason: string;
  rawMarketFilePath: string;
  dataQualityFlags: string[];
}

export interface PriceHistoryPoint {
  timestampMilliseconds: number;
  price: number;
}

export interface BinancePricePoint {
  timestampMilliseconds: number;
  btcPrice: number;
}

export interface NormalizedPricePoint {
  marketSlug: string;
  conditionId: string | null;
  timestampMilliseconds: number;
  secondsLeft: number;
  targetPrice: number;
  btcPrice: number;
  distanceUsd: number;
  distanceBasisPoints: number;
  upPrice: number | null;
  downPrice: number | null;
  winner: MarketWinner;
  isResolved: boolean;
  dataQualityFlags: string[];
}

export interface MarketSummary {
  marketSlug: string;
  conditionId: string | null;
  marketStartTimestampMilliseconds: number;
  marketEndTimestampMilliseconds: number;
  targetPrice: number;
  winner: MarketWinner;
  closeBtcPrice: number | null;
  finalDistanceBasisPoints: number | null;
  maximumUpPrice: number | null;
  maximumDownPrice: number | null;
  firstTimestampUpPriceGreaterThanOrEqual075: number | null;
  firstTimestampUpPriceGreaterThanOrEqual080: number | null;
  firstTimestampUpPriceGreaterThanOrEqual090: number | null;
  firstTimestampUpPriceGreaterThanOrEqual095: number | null;
  firstTimestampUpPriceGreaterThanOrEqual099: number | null;
  secondsLeftAtFirstUpPriceGreaterThanOrEqual090: number | null;
  firstTimestampDownPriceGreaterThanOrEqual075: number | null;
  firstTimestampDownPriceGreaterThanOrEqual080: number | null;
  firstTimestampDownPriceGreaterThanOrEqual090: number | null;
  firstTimestampDownPriceGreaterThanOrEqual095: number | null;
  firstTimestampDownPriceGreaterThanOrEqual099: number | null;
  secondsLeftAtFirstDownPriceGreaterThanOrEqual090: number | null;
  dataQualityFlags: string[];
}
