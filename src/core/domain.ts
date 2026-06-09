export type MarketOutcome = 'Up' | 'Down' | 'Yes' | 'No' | 'Unknown';
export type MarketWinner = 'up' | 'down' | 'unknown' | null;
export type MarketDuration = '1h' | '4h' | '1d';
export type UnsupportedMarketDuration = '15m' | '5m';
export type DetectedMarketDuration = MarketDuration | UnsupportedMarketDuration;
export type RequestedMarketDuration = MarketDuration | 'all';
export type ExternalPriceSourceName = 'chainlink' | 'binance' | string;
export type PrimaryPriceSourceName = 'chainlink' | 'binance_proxy';

export interface NormalizedMarket {
  marketSlug: string;
  conditionId: string | null;
  question: string;
  marketDuration: MarketDuration;
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
  detectedMarketDuration?: DetectedMarketDuration | null;
}

export interface PriceHistoryPoint {
  timestampMilliseconds: number;
  price: number;
}

export interface ExternalPricePoint {
  timestampMilliseconds: number;
  price: number;
  sourceName: ExternalPriceSourceName;
}

export interface BinancePricePoint {
  timestampMilliseconds: number;
  btcPrice: number;
}

export interface PriceHistoryQualityMetrics {
  pointsCount: number;
  minimumTimestampMilliseconds: number | null;
  maximumTimestampMilliseconds: number | null;
  medianGapMilliseconds: number | null;
  maximumGapMilliseconds: number | null;
}

export interface FuturePriceLabels {
  futureMaximumUpPrice: number | null;
  futureMaximumDownPrice: number | null;
  futureMinimumUpPrice: number | null;
  futureMinimumDownPrice: number | null;
  futureFinalUpPrice: number | null;
  futureFinalDownPrice: number | null;
  futureSecondsUntilUpPriceGreaterThanOrEqual075: number | null;
  futureSecondsUntilUpPriceGreaterThanOrEqual080: number | null;
  futureSecondsUntilUpPriceGreaterThanOrEqual090: number | null;
  futureSecondsUntilUpPriceGreaterThanOrEqual095: number | null;
  futureSecondsUntilUpPriceGreaterThanOrEqual099: number | null;
  futureSecondsUntilDownPriceGreaterThanOrEqual075: number | null;
  futureSecondsUntilDownPriceGreaterThanOrEqual080: number | null;
  futureSecondsUntilDownPriceGreaterThanOrEqual090: number | null;
  futureSecondsUntilDownPriceGreaterThanOrEqual095: number | null;
  futureSecondsUntilDownPriceGreaterThanOrEqual099: number | null;
  futureReachesUp075: boolean;
  futureReachesUp080: boolean;
  futureReachesUp090: boolean;
  futureReachesUp095: boolean;
  futureReachesUp099: boolean;
  futureReachesDown075: boolean;
  futureReachesDown080: boolean;
  futureReachesDown090: boolean;
  futureReachesDown095: boolean;
  futureReachesDown099: boolean;
}

export interface NormalizedPricePoint extends FuturePriceLabels {
  marketSlug: string;
  conditionId: string | null;
  marketDuration: MarketDuration;
  timestampMilliseconds: number;
  secondsLeft: number;
  targetPrice: number;
  upPrice: number | null;
  downPrice: number | null;
  primaryPriceSourceName: PrimaryPriceSourceName;
  primaryPrice: number;
  primaryTimestampMilliseconds: number;
  primaryDistanceUsd: number;
  primaryDistanceBasisPoints: number;
  chainlinkPrice: number | null;
  chainlinkTimestampMilliseconds: number | null;
  chainlinkDistanceUsd: number | null;
  chainlinkDistanceBasisPoints: number | null;
  binancePrice: number | null;
  binanceTimestampMilliseconds: number | null;
  binanceDistanceUsd: number | null;
  binanceDistanceBasisPoints: number | null;
  binanceMinusChainlinkBasisPoints: number | null;
  winner: MarketWinner;
  isResolved: boolean;
  dataQualityFlags: string[];
}

export interface MarketSummary {
  marketSlug: string;
  conditionId: string | null;
  marketDuration: MarketDuration;
  marketStartTimestampMilliseconds: number;
  marketEndTimestampMilliseconds: number;
  targetPrice: number;
  winner: MarketWinner;
  primaryPriceSourceName: PrimaryPriceSourceName | null;
  closePrimaryPrice: number | null;
  finalPrimaryDistanceBasisPoints: number | null;
  closeChainlinkPrice: number | null;
  finalChainlinkDistanceBasisPoints: number | null;
  closeBinancePrice: number | null;
  finalBinanceDistanceBasisPoints: number | null;
  finalBinanceMinusChainlinkBasisPoints: number | null;
  maximumUpPrice: number | null;
  maximumDownPrice: number | null;
  upPriceOpen: number | null;
  downPriceOpen: number | null;
  upPriceClose: number | null;
  downPriceClose: number | null;
  upPriceMinimum: number | null;
  upPriceMaximum: number | null;
  downPriceMinimum: number | null;
  downPriceMaximum: number | null;
  upPriceRange: number | null;
  downPriceRange: number | null;
  upPriceLast: number | null;
  downPriceLast: number | null;
  upPriceMean: number | null;
  downPriceMean: number | null;
  upPriceMedian: number | null;
  downPriceMedian: number | null;
  upPriceStandardDeviation: number | null;
  downPriceStandardDeviation: number | null;
  upPriceNumberOfObservations: number;
  downPriceNumberOfObservations: number;
  pricePointsCount: number;
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

export interface StrategyTrainingRow {
  marketSlug: string;
  conditionId: string | null;
  marketDuration: MarketDuration;
  timestampMilliseconds: number;
  secondsLeft: number;
  targetPrice: number;
  upPrice: number | null;
  downPrice: number | null;
  primaryPriceSourceName: PrimaryPriceSourceName;
  primaryPrice: number;
  primaryTimestampMilliseconds: number;
  primaryDistanceUsd: number;
  primaryDistanceBasisPoints: number;
  binancePrice: number | null;
  binanceTimestampMilliseconds: number | null;
  binanceDistanceUsd: number | null;
  binanceDistanceBasisPoints: number | null;
  binanceMinusChainlinkBasisPoints: number | null;
  upPriceChangePrevious1Point: number | null;
  downPriceChangePrevious1Point: number | null;
  upPriceChangePrevious2Points: number | null;
  downPriceChangePrevious2Points: number | null;
  upPriceChangePrevious3Points: number | null;
  downPriceChangePrevious3Points: number | null;
  winner: MarketWinner;
  upWinsBinary: number | null;
  futureMaximumUpPrice: number | null;
  futureMaximumDownPrice: number | null;
  futureMinimumUpPrice: number | null;
  futureMinimumDownPrice: number | null;
  futureFinalUpPrice: number | null;
  futureFinalDownPrice: number | null;
  futureSecondsUntilUpPriceGreaterThanOrEqual090: number | null;
  futureSecondsUntilDownPriceGreaterThanOrEqual090: number | null;
  futureReachesUp090: boolean;
  futureReachesUp095: boolean;
  futureReachesUp099: boolean;
  futureReachesDown090: boolean;
  futureReachesDown095: boolean;
  futureReachesDown099: boolean;
  dataQualityFlags: string[];
}
