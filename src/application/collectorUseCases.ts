import pLimit from 'p-limit';
import type { FileStorage } from '../adapters/fileStorage.js';
import type { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { serializeDataQualityFlags } from '../adapters/parquetWriter.js';
import type { PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import type { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import type { BinanceArchiveApiAdapter, BinanceDataType, BinanceMarketType } from '../adapters/binanceArchiveApi.js';
import type { CollectorLogger } from '../adapters/logger.js';
import type { BinancePricePoint, NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint, RejectedMarket } from '../core/domain.js';
import { buildNormalizedPricePointsForMarket } from '../core/alignment.js';
import { buildMarketSummary } from '../core/summary.js';
import { marketsParquetSchema, marketSummaryParquetSchema, pricePointsParquetSchema, rejectedMarketsParquetSchema } from './schemas.js';
import { StateRepository } from './stateRepository.js';

export interface CollectorOptions {
  startDate: string;
  endDate: string;
  symbol: string;
  priceFidelitySeconds: number;
  force: boolean;
  requestDelayMilliseconds: number;
  maximumConcurrentRequests: number;
  binanceMarketType: BinanceMarketType;
  binanceDataType: BinanceDataType;
}

export class CollectorUseCases {
  private readonly stateRepository: StateRepository;

  public constructor(
    private readonly fileStorage: FileStorage,
    private readonly parquetWriter: LocalParquetWriter,
    private readonly gammaApiAdapter: PolymarketGammaApiAdapter,
    private readonly clobApiAdapter: PolymarketClobApiAdapter,
    private readonly binanceArchiveApiAdapter: BinanceArchiveApiAdapter,
    private readonly logger: CollectorLogger,
  ) {
    this.stateRepository = new StateRepository(fileStorage);
  }

  public async discoverMarkets(options: CollectorOptions): Promise<void> {
    await this.fileStorage.ensureDataDirectories();
    const rawGammaFilePath = rawGammaRelativeFilePath(options);
    const stateKey = dateRangeStateKey(options);
    if (!options.force && (await this.stateRepository.isStepCompleted(stateKey, 'discover_markets'))) {
      this.logger.info({ rawGammaFilePath }, 'Skipping market discovery because state marks it complete');
      return;
    }

    const rawMarkets = (await this.fileStorage.exists(rawGammaFilePath)) && !options.force
      ? await this.fileStorage.readJson<Record<string, unknown>[]>(rawGammaFilePath)
      : await this.gammaApiAdapter.discoverBitcoinUpDownFiveMinuteMarkets(options.startDate, options.endDate);
    await this.fileStorage.writeJson(rawGammaFilePath, rawMarkets, options.force);

    const discoveryResult = this.gammaApiAdapter.parseMarkets(rawMarkets, this.fileStorage.resolve(rawGammaFilePath));
    await this.fileStorage.writeJsonLines(acceptedMarketsRelativeFilePath(options), discoveryResult.acceptedMarkets, true);
    await this.fileStorage.writeJsonLines(rejectedMarketsRelativeFilePath(options), discoveryResult.rejectedMarkets, true);
    await this.writeMarketsParquet(options, discoveryResult.acceptedMarkets);
    await this.writeRejectedMarketsParquet(options, discoveryResult.rejectedMarkets);

    this.logger.info(
      {
        foundMarkets: rawMarkets.length,
        acceptedMarkets: discoveryResult.acceptedMarkets.length,
        rejectedMarkets: discoveryResult.rejectedMarkets.length,
        marketsWithoutTarget: discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'target_price_missing').length,
        marketsWithoutTokenIds: discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'token_ids_missing').length,
      },
      'Market discovery completed',
    );
    await this.stateRepository.markStepCompleted(stateKey, 'discover_markets');
  }

  public async downloadPolymarketPrices(options: CollectorOptions): Promise<void> {
    const markets = await this.readAcceptedMarkets(options);
    const limit = pLimit(options.maximumConcurrentRequests);
    let downloadedPriceHistories = 0;
    let emptyPriceHistories = 0;
    let coarsePriceHistories = 0;

    await Promise.all(
      markets.map((market) =>
        limit(async () => {
          if (market.upTokenId === null || market.downTokenId === null) return;
          for (const [outcome, tokenId] of [
            ['up', market.upTokenId],
            ['down', market.downTokenId],
          ] as const) {
            const relativeFilePath = rawPriceHistoryRelativeFilePath(options, market.marketSlug, outcome);
            if (!options.force && (await this.fileStorage.exists(relativeFilePath))) continue;
            const priceHistory = await this.clobApiAdapter.downloadPricesHistory({
              tokenId,
              startTimestampMilliseconds: market.marketStartTimestampMilliseconds,
              endTimestampMilliseconds: market.marketEndTimestampMilliseconds,
              fidelitySeconds: options.priceFidelitySeconds,
            });
            if (priceHistory.length === 0) emptyPriceHistories += 1;
            if (isPriceHistoryTooCoarse(priceHistory, options.priceFidelitySeconds)) coarsePriceHistories += 1;
            await this.fileStorage.writeJson(relativeFilePath, priceHistory, options.force);
            downloadedPriceHistories += 1;
          }
        }),
      ),
    );
    this.logger.info({ downloadedPriceHistories, emptyPriceHistories, coarsePriceHistories }, 'Polymarket price history download completed');
  }

  public async downloadPolymarketTrades(_options: CollectorOptions): Promise<void> {
    const tradeAvailability = await this.clobApiAdapter.tryDownloadPublicTrades();
    this.logger.warn({ dataQualityFlag: tradeAvailability.dataQualityFlag }, 'Public Polymarket trades are unavailable without authenticated endpoint');
  }

  public async downloadBinance(options: CollectorOptions): Promise<void> {
    let binanceFilesDownloaded = 0;
    for (const date of enumerateDates(options.startDate, options.endDate)) {
      const relativeFilePath = rawBinanceRelativeFilePath(options, date);
      if (!options.force && (await this.fileStorage.exists(relativeFilePath))) continue;
      const archiveResult = await this.binanceArchiveApiAdapter.downloadDailyPricePoints({
        date,
        symbol: options.symbol,
        marketType: options.binanceMarketType,
        dataType: options.binanceDataType,
      });
      await this.fileStorage.writeJson(relativeFilePath, archiveResult.pricePoints, options.force);
      binanceFilesDownloaded += 1;
    }
    this.logger.info({ binanceFilesDownloaded }, 'Binance archive download completed');
  }

  public async buildDataset(options: CollectorOptions): Promise<void> {
    const markets = await this.readAcceptedMarkets(options);
    const binancePricePoints = await this.readBinancePricePoints(options);
    const allPricePoints: NormalizedPricePoint[] = [];
    const rejectedMarkets: RejectedMarket[] = [];

    for (const market of markets) {
      try {
        const upPriceHistory = await this.readPriceHistory(options, market.marketSlug, 'up');
        const downPriceHistory = await this.readPriceHistory(options, market.marketSlug, 'down');
        const dataQualityFlags = [...market.dataQualityFlags];
        if (upPriceHistory.length === 0) dataQualityFlags.push('price_history_empty', 'price_history_missing_up');
        if (downPriceHistory.length === 0) dataQualityFlags.push('price_history_empty', 'price_history_missing_down');
        const pricePoints = buildNormalizedPricePointsForMarket({
          market: { ...market, dataQualityFlags },
          upPriceHistory,
          downPriceHistory,
          binancePricePoints,
        });
        allPricePoints.push(...pricePoints);
      } catch (error) {
        rejectedMarkets.push({
          marketSlug: market.marketSlug,
          conditionId: market.conditionId,
          question: market.question,
          rejectionReason: 'dataset_build_error',
          rawMarketFilePath: rawGammaRelativeFilePath(options),
          dataQualityFlags: [`dataset_build_error:${(error as Error).message}`],
        });
      }
    }

    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedPricePointsRelativeFilePath(options)), pricePointsParquetSchema, allPricePoints.map(toPricePointParquetRow));
    await this.fileStorage.writeJson(processedPricePointsDebugRelativeFilePath(options), allPricePoints, true);
    const existingRejectedMarkets = (await this.fileStorage.exists(rejectedMarketsRelativeFilePath(options)))
      ? await this.fileStorage.readJsonLines<RejectedMarket>(rejectedMarketsRelativeFilePath(options))
      : [];
    await this.writeRejectedMarketsParquet(options, [...existingRejectedMarkets, ...rejectedMarkets]);
    this.logger.info({ pricePointsBuilt: allPricePoints.length, additionalRejectedMarkets: rejectedMarkets.length }, 'Dataset build completed');
  }

  public async summarizeMarkets(options: CollectorOptions): Promise<void> {
    const markets = await this.readAcceptedMarkets(options);
    const pricePoints = await this.readBuiltPricePointsDebugJsonIfPresent(options);
    const summaries = markets.map((market) => buildMarketSummary(market, pricePoints.filter((pricePoint) => pricePoint.marketSlug === market.marketSlug)));
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedMarketSummaryRelativeFilePath(options)), marketSummaryParquetSchema, summaries.map(toMarketSummaryParquetRow));
    this.logger.info({ summariesCreated: summaries.length }, 'Market summaries completed');
  }

  public async runFullPipeline(options: CollectorOptions): Promise<void> {
    await this.discoverMarkets(options);
    await this.downloadPolymarketPrices(options);
    await this.downloadPolymarketTrades(options);
    await this.downloadBinance(options);
    await this.buildDataset(options);
    await this.summarizeMarkets(options);
  }

  private async writeMarketsParquet(options: CollectorOptions, markets: NormalizedMarket[]): Promise<void> {
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedMarketsRelativeFilePath(options)), marketsParquetSchema, markets.map(toMarketParquetRow));
  }

  private async writeRejectedMarketsParquet(options: CollectorOptions, rejectedMarkets: RejectedMarket[]): Promise<void> {
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedRejectedMarketsRelativeFilePath(options)), rejectedMarketsParquetSchema, rejectedMarkets.map(toRejectedMarketParquetRow));
  }

  private async readAcceptedMarkets(options: CollectorOptions): Promise<NormalizedMarket[]> {
    return this.fileStorage.readJsonLines<NormalizedMarket>(acceptedMarketsRelativeFilePath(options));
  }

  private async readPriceHistory(options: CollectorOptions, marketSlug: string, outcome: 'up' | 'down'): Promise<PriceHistoryPoint[]> {
    const relativeFilePath = rawPriceHistoryRelativeFilePath(options, marketSlug, outcome);
    return (await this.fileStorage.exists(relativeFilePath)) ? this.fileStorage.readJson<PriceHistoryPoint[]>(relativeFilePath) : [];
  }

  private async readBinancePricePoints(options: CollectorOptions): Promise<BinancePricePoint[]> {
    const allPricePoints: BinancePricePoint[] = [];
    for (const date of enumerateDates(options.startDate, options.endDate)) {
      const relativeFilePath = rawBinanceRelativeFilePath(options, date);
      if (await this.fileStorage.exists(relativeFilePath)) allPricePoints.push(...(await this.fileStorage.readJson<BinancePricePoint[]>(relativeFilePath)));
    }
    return allPricePoints;
  }

  private async readBuiltPricePointsDebugJsonIfPresent(options: CollectorOptions): Promise<NormalizedPricePoint[]> {
    const debugFilePath = processedPricePointsDebugRelativeFilePath(options);
    if (await this.fileStorage.exists(debugFilePath)) return this.fileStorage.readJson<NormalizedPricePoint[]>(debugFilePath);
    return [];
  }
}

function isPriceHistoryTooCoarse(priceHistory: PriceHistoryPoint[], requestedFidelitySeconds: number): boolean {
  if (priceHistory.length < 2) return false;
  const orderedHistory = [...priceHistory].sort((leftPoint, rightPoint) => leftPoint.timestampMilliseconds - rightPoint.timestampMilliseconds);
  const gaps = orderedHistory.slice(1).map((pricePoint, index) => pricePoint.timestampMilliseconds - (orderedHistory[index]?.timestampMilliseconds ?? pricePoint.timestampMilliseconds));
  const maximumGapMilliseconds = Math.max(...gaps);
  return maximumGapMilliseconds > requestedFidelitySeconds * 1_000 * 5;
}

export function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let timestampMilliseconds = Date.parse(`${startDate}T00:00:00.000Z`); timestampMilliseconds < Date.parse(`${endDate}T00:00:00.000Z`); timestampMilliseconds += 86_400_000) {
    dates.push(new Date(timestampMilliseconds).toISOString().slice(0, 10));
  }
  return dates;
}

export function dateRangeStateKey(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `${options.startDate}_${options.endDate}`; }
export function rawGammaRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `raw/gamma/btc-up-down-5m_${dateRangeStateKey(options)}.json`; }
export function acceptedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `processed/accepted_markets_${dateRangeStateKey(options)}.jsonl`; }
export function rejectedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `rejected/rejected_markets_${dateRangeStateKey(options)}.jsonl`; }
export function rawPriceHistoryRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'priceFidelitySeconds'>, marketSlug: string, outcome: 'up' | 'down'): string { return `raw/polymarket-prices/${dateRangeStateKey(options)}_${marketSlug}_${outcome}_${options.priceFidelitySeconds}s.json`; }
export function rawBinanceRelativeFilePath(options: Pick<CollectorOptions, 'symbol' | 'binanceMarketType' | 'binanceDataType'>, date: string): string { return `raw/binance/${options.binanceMarketType}_${options.binanceDataType}_${options.symbol}_${date}.json`; }
export function processedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `processed/markets_${dateRangeStateKey(options)}.parquet`; }
export function processedPricePointsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `processed/price_points_${dateRangeStateKey(options)}.parquet`; }
export function processedPricePointsDebugRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `processed/price_points_${dateRangeStateKey(options)}.debug.json`; }
export function processedMarketSummaryRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `processed/market_summary_${dateRangeStateKey(options)}.parquet`; }
export function processedRejectedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `processed/rejected_markets_${dateRangeStateKey(options)}.parquet`; }

function toMarketParquetRow(market: NormalizedMarket): Record<string, unknown> { return { market_slug: market.marketSlug, condition_id: market.conditionId, question: market.question, market_start_timestamp_milliseconds: market.marketStartTimestampMilliseconds, market_end_timestamp_milliseconds: market.marketEndTimestampMilliseconds, up_token_id: market.upTokenId, down_token_id: market.downTokenId, target_price: market.targetPrice, winner: market.winner, is_resolved: market.isResolved, is_closed: market.isClosed, raw_outcomes: market.rawOutcomes, raw_outcome_prices: market.rawOutcomePrices, data_quality_flags: serializeDataQualityFlags(market.dataQualityFlags) }; }
function toPricePointParquetRow(pricePoint: NormalizedPricePoint): Record<string, unknown> { return { market_slug: pricePoint.marketSlug, condition_id: pricePoint.conditionId, timestamp_milliseconds: pricePoint.timestampMilliseconds, seconds_left: pricePoint.secondsLeft, target_price: pricePoint.targetPrice, btc_price: pricePoint.btcPrice, distance_usd: pricePoint.distanceUsd, distance_basis_points: pricePoint.distanceBasisPoints, up_price: pricePoint.upPrice, down_price: pricePoint.downPrice, winner: pricePoint.winner, is_resolved: pricePoint.isResolved, data_quality_flags: serializeDataQualityFlags(pricePoint.dataQualityFlags) }; }
function toMarketSummaryParquetRow(summary: ReturnType<typeof buildMarketSummary>): Record<string, unknown> { return { market_slug: summary.marketSlug, condition_id: summary.conditionId, market_start_timestamp_milliseconds: summary.marketStartTimestampMilliseconds, market_end_timestamp_milliseconds: summary.marketEndTimestampMilliseconds, target_price: summary.targetPrice, winner: summary.winner, close_btc_price: summary.closeBtcPrice, final_distance_basis_points: summary.finalDistanceBasisPoints, maximum_up_price: summary.maximumUpPrice, maximum_down_price: summary.maximumDownPrice, first_timestamp_up_price_greater_than_or_equal_075: summary.firstTimestampUpPriceGreaterThanOrEqual075, first_timestamp_up_price_greater_than_or_equal_080: summary.firstTimestampUpPriceGreaterThanOrEqual080, first_timestamp_up_price_greater_than_or_equal_090: summary.firstTimestampUpPriceGreaterThanOrEqual090, first_timestamp_up_price_greater_than_or_equal_095: summary.firstTimestampUpPriceGreaterThanOrEqual095, first_timestamp_up_price_greater_than_or_equal_099: summary.firstTimestampUpPriceGreaterThanOrEqual099, seconds_left_at_first_up_price_greater_than_or_equal_090: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual090, first_timestamp_down_price_greater_than_or_equal_075: summary.firstTimestampDownPriceGreaterThanOrEqual075, first_timestamp_down_price_greater_than_or_equal_080: summary.firstTimestampDownPriceGreaterThanOrEqual080, first_timestamp_down_price_greater_than_or_equal_090: summary.firstTimestampDownPriceGreaterThanOrEqual090, first_timestamp_down_price_greater_than_or_equal_095: summary.firstTimestampDownPriceGreaterThanOrEqual095, first_timestamp_down_price_greater_than_or_equal_099: summary.firstTimestampDownPriceGreaterThanOrEqual099, seconds_left_at_first_down_price_greater_than_or_equal_090: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual090, data_quality_flags: serializeDataQualityFlags(summary.dataQualityFlags) }; }
function toRejectedMarketParquetRow(rejectedMarket: RejectedMarket): Record<string, unknown> { return { market_slug: rejectedMarket.marketSlug, condition_id: rejectedMarket.conditionId, question: rejectedMarket.question, rejection_reason: rejectedMarket.rejectionReason, raw_market_file_path: rejectedMarket.rawMarketFilePath, data_quality_flags: serializeDataQualityFlags(rejectedMarket.dataQualityFlags) }; }
