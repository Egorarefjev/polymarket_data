import pLimit from 'p-limit';
import type { FileStorage } from '../adapters/fileStorage.js';
import type { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { serializeDataQualityFlags } from '../adapters/parquetWriter.js';
import { isBitcoinUpDownMarket, type PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import type { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import type { BinanceArchiveApiAdapter, BinanceDataType, BinanceMarketType } from '../adapters/binanceArchiveApi.js';
import type { ExternalPriceSource } from '../adapters/externalPriceSource.js';
import type { CollectorLogger } from '../adapters/logger.js';
import type { ExternalPricePoint, NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint, RejectedMarket, RequestedMarketDuration, StrategyTrainingRow } from '../core/domain.js';
import { CausalAsOfPriceLookup, buildNormalizedPricePointsForMarketWithSkipCount, buildPriceHistoryQualityFlags, sortExternalPricePointsOnce } from '../core/alignment.js';
import { buildMarketSummary } from '../core/summary.js';
import { marketsParquetSchema, marketSummaryParquetSchema, pricePointsParquetSchema, rejectedMarketsParquetSchema, strategyTrainingRowsParquetSchema } from './schemas.js';
import { StateRepository } from './stateRepository.js';

export interface CollectorOptions {
  startDate: string;
  endDate: string;
  symbol: string;
  priceFidelityMinutes: number;
  marketDuration: RequestedMarketDuration;
  force: boolean;
  requestDelayMilliseconds: number;
  maximumConcurrentRequests: number;
  binanceMarketType: BinanceMarketType;
  binanceDataType: BinanceDataType;
  primaryPriceSource: 'chainlink';
  includeBinanceSecondarySignal: boolean;
  chainlinkInputFile?: string;
  allowProxyPrimaryPriceSourceForDebug: boolean;
  writeDebugJson: boolean;
  allowBroadGammaDateScan: boolean;
  allowEmptyMarketSet: boolean;
}

export interface BuildDatasetResult {
  pricePoints: NormalizedPricePoint[];
  strategyTrainingRows: StrategyTrainingRow[];
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
    private readonly primaryExternalPriceSource?: ExternalPriceSource,
    private readonly optionalSecondaryExternalPriceSource?: ExternalPriceSource,
  ) {
    this.stateRepository = new StateRepository(fileStorage);
  }

  public async discoverMarkets(options: CollectorOptions): Promise<void> {
    await this.fileStorage.ensureDataDirectories();
    const rawGammaFilePath = rawGammaRelativeFilePath(options);
    const stateKey = collectorStateKey(options);
    if (!options.force && (await this.stateRepository.isStepCompleted(stateKey, 'discover_markets'))) {
      this.logger.info({ rawGammaFilePath }, 'Skipping market discovery because state marks it complete');
      return;
    }

    const rawMarkets = (await this.fileStorage.exists(rawGammaFilePath)) && !options.force
      ? await this.fileStorage.readJson<Record<string, unknown>[]>(rawGammaFilePath)
      : await this.gammaApiAdapter.discoverBitcoinUpDownMarkets(options.startDate, options.endDate, { allowBroadGammaDateScan: options.allowBroadGammaDateScan, requestedMarketDuration: options.marketDuration });
    await this.fileStorage.writeJson(rawGammaFilePath, rawMarkets, options.force);

    const discoveryResult = this.gammaApiAdapter.parseMarkets(rawMarkets, this.fileStorage.resolve(rawGammaFilePath), options.marketDuration);
    await this.fileStorage.writeJsonLines(acceptedMarketsRelativeFilePath(options), discoveryResult.acceptedMarkets, true);
    await this.fileStorage.writeJsonLines(rejectedMarketsRelativeFilePath(options), discoveryResult.rejectedMarkets, true);
    await this.writeMarketsParquet(options, discoveryResult.acceptedMarkets);
    await this.writeRejectedMarketsParquet(options, discoveryResult.rejectedMarkets);
    const discoveryDebug = this.gammaApiAdapter.attachParseResultsToLastDiscoveryDebug(discoveryResult);
    if (discoveryDebug !== null) await this.fileStorage.writeJson(discoveryDebugRelativeFilePath(options), discoveryDebug, true);

    this.logger.info(
      {
        rawMarketsFetched: rawMarkets.length,
        candidateMarketsFetched: rawMarkets.length,
        locallyMatchedMarkets: rawMarkets.filter(isBitcoinUpDownMarket).length,
        acceptedMarkets: discoveryResult.acceptedMarkets.length,
        rejectedMarkets: discoveryResult.rejectedMarkets.length,
        marketsWithoutTarget: discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'target_price_missing').length,
        marketsWithoutTokenIds: discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'token_ids_missing').length,
        rawResponsesFetched: discoveryDebug?.rawResponsesFetched ?? null,
        deduplicatedCandidateMarkets: discoveryDebug?.deduplicatedCandidateMarkets ?? rawMarkets.length,
        acceptedByDuration: discoveryDebug?.acceptedByDuration ?? countAcceptedByDuration(discoveryResult.acceptedMarkets),
        rejectedByReason: discoveryDebug?.rejectedByReason ?? countRejectedByReason(discoveryResult.rejectedMarkets),
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
              fidelityMinutes: options.priceFidelityMinutes,
            });
            if (priceHistory.length === 0) emptyPriceHistories += 1;
            if (isPriceHistoryTooCoarse(priceHistory, options.priceFidelityMinutes)) coarsePriceHistories += 1;
            await this.fileStorage.writeJson(relativeFilePath, priceHistory, options.force);
            downloadedPriceHistories += 1;
          }
        }),
      ),
    );
    this.logger.info({ downloadedPriceHistories, emptyPriceHistories, coarsePriceHistories }, 'Polymarket price history download completed');
  }

  public async downloadPolymarketTrades(_options: CollectorOptions): Promise<void> {
    this.logger.warn({ dataQualityFlag: 'polymarket_trades_command_deprecated' }, 'download-polymarket-trades is deprecated; normal collection uses Polymarket price-history and does not collect trades');
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

  public async buildDataset(options: CollectorOptions): Promise<BuildDatasetResult> {
    const markets = await this.readAcceptedMarkets(options);
    const chainlinkPricePoints = await this.readChainlinkPricePoints(options);
    const initialPrimaryPriceMode = determinePrimaryPriceMode(options, chainlinkPricePoints);
    const binancePricePoints = (initialPrimaryPriceMode.mode === 'binance_proxy_debug' || options.includeBinanceSecondarySignal) ? await this.readBinancePricePoints(options) : [];
    const primaryPriceMode = initialPrimaryPriceMode.mode === 'binance_proxy_debug'
      ? { ...initialPrimaryPriceMode, primaryPricePoints: binancePricePoints }
      : initialPrimaryPriceMode;
    if (primaryPriceMode.mode === 'binance_proxy_debug' && primaryPriceMode.primaryPricePoints.length === 0) {
      throw new Error('Binance proxy primary data is required when --allow-proxy-primary-price-source-for-debug true is used without --chainlink-input-file. Run download-binance first or disable proxy debug mode.');
    }
    if (primaryPriceMode.mode === 'missing_primary_price_source') {
      throw new Error('Chainlink input is required for official dataset build. Provide --chainlink-input-file or use --allow-proxy-primary-price-source-for-debug true for non-official proxy testing.');
    }

    const sortedPrimaryPricePoints = sortExternalPricePointsOnce(primaryPriceMode.primaryPricePoints);
    const sortedBinancePricePoints = sortExternalPricePointsOnce(binancePricePoints);
    const sortedBinanceSecondaryPricePoints = options.includeBinanceSecondarySignal ? sortedBinancePricePoints : [];
    const primaryPriceLookup = new CausalAsOfPriceLookup(sortedPrimaryPricePoints);
    const binanceSecondaryPriceLookup = new CausalAsOfPriceLookup(sortedBinanceSecondaryPricePoints);

    const allPricePoints: NormalizedPricePoint[] = [];
    const rejectedMarkets: RejectedMarket[] = [];
    let skippedRowsMissingPrimaryPriceBeforeTimestamp = 0;

    for (const market of markets) {
      try {
        const upPriceHistory = await this.readPriceHistory(options, market.marketSlug, 'up');
        const downPriceHistory = await this.readPriceHistory(options, market.marketSlug, 'down');
        const dataQualityFlags = [
          ...market.dataQualityFlags,
          ...buildPriceHistoryQualityFlags('up', upPriceHistory, market, options.priceFidelityMinutes),
          ...buildPriceHistoryQualityFlags('down', downPriceHistory, market, options.priceFidelityMinutes),
          ...(primaryPriceMode.mode === 'binance_proxy_debug' ? ['proxy_primary_price_source_not_official'] : []),
        ];
        const buildResult = buildNormalizedPricePointsForMarketWithSkipCount({
          market: { ...market, dataQualityFlags },
          upPriceHistory,
          downPriceHistory,
          primaryExternalPricePoints: sortedPrimaryPricePoints,
          primaryPriceLookup,
          primaryPriceSourceName: primaryPriceMode.mode === 'binance_proxy_debug' ? 'binance_proxy' : 'chainlink',
          binanceSecondaryPricePoints: sortedBinanceSecondaryPricePoints,
          binanceSecondaryPriceLookup,
          isBinanceSecondarySignalEnabled: options.includeBinanceSecondarySignal,
          isProxyPrimaryPriceSourceForDebug: primaryPriceMode.mode === 'binance_proxy_debug',
          requestedFidelityMinutes: options.priceFidelityMinutes,
        });
        skippedRowsMissingPrimaryPriceBeforeTimestamp += buildResult.skippedRowsMissingPrimaryPriceBeforeTimestamp;
        allPricePoints.push(...buildResult.pricePoints);
      } catch (error) {
        rejectedMarkets.push({
          marketSlug: market.marketSlug,
          conditionId: market.conditionId,
          question: market.question,
          rejectionReason: 'dataset_build_error',
          rawMarketFilePath: rawGammaRelativeFilePath(options),
          dataQualityFlags: [`dataset_build_error:${(error as Error).message}`],
          detectedMarketDuration: market.marketDuration,
        });
      }
    }

    const strategyTrainingRows = buildStrategyTrainingRows(allPricePoints);
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedPricePointsRelativeFilePath(options)), pricePointsParquetSchema, allPricePoints.map(toPricePointParquetRow));
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedStrategyTrainingRowsRelativeFilePath(options)), strategyTrainingRowsParquetSchema, strategyTrainingRows.map(toStrategyTrainingRowParquetRow));
    await this.writeMarketSummariesFromPricePoints(options, markets, allPricePoints);
    let deletedDebugJsonFiles = 0;
    if (options.writeDebugJson) {
      await this.fileStorage.writeJson(processedPricePointsDebugRelativeFilePath(options), allPricePoints, true);
      await this.fileStorage.writeJson(processedStrategyTrainingRowsDebugRelativeFilePath(options), strategyTrainingRows, true);
    } else {
      const deletedDebugJsonResults = await Promise.all([
        this.fileStorage.deleteIfExists(processedPricePointsDebugRelativeFilePath(options)),
        this.fileStorage.deleteIfExists(processedStrategyTrainingRowsDebugRelativeFilePath(options)),
      ]);
      deletedDebugJsonFiles = deletedDebugJsonResults.filter((wasDeleted) => wasDeleted).length;
      this.logger.info({ deletedDebugJsonFiles }, 'Stale debug JSON cleanup completed');
    }
    const existingRejectedMarkets = (await this.fileStorage.exists(rejectedMarketsRelativeFilePath(options)))
      ? await this.fileStorage.readJsonLines<RejectedMarket>(rejectedMarketsRelativeFilePath(options))
      : [];
    await this.writeRejectedMarketsParquet(options, [...existingRejectedMarkets, ...rejectedMarkets]);
    this.logger.info({ pricePointsBuilt: allPricePoints.length, strategyTrainingRowsBuilt: strategyTrainingRows.length, additionalRejectedMarkets: rejectedMarkets.length, skippedRowsMissingPrimaryPriceBeforeTimestamp, writeDebugJson: options.writeDebugJson, deletedDebugJsonFiles }, 'Dataset build completed');
    return { pricePoints: allPricePoints, strategyTrainingRows };
  }

  public async summarizeMarkets(options: CollectorOptions): Promise<void> {
    if (options.writeDebugJson !== true) {
      throw new Error('Standalone summarize reads debug JSON and is only allowed with --write-debug-json true. For normal runs use all/build-dataset, which writes market_summary.parquet directly from fresh in-memory price_points.');
    }
    const markets = await this.readAcceptedMarkets(options);
    const pricePoints = await this.readBuiltPricePointsDebugJson(options);
    await this.writeMarketSummariesFromPricePoints(options, markets, pricePoints);
  }

  public async diagnoseDiscovery(options: CollectorOptions): Promise<void> {
    await this.discoverMarkets(options);
    const debug = this.gammaApiAdapter.getLastDiscoveryDebug();
    if (debug !== null) {
      for (const query of debug.queries) this.logger.info(query, 'Discovery query/source result');
      this.logger.info({ discoveryDebugFilePath: this.fileStorage.resolve(discoveryDebugRelativeFilePath(options)), ...debug }, 'Discovery diagnosis completed');
    }
  }

  public async runFullPipeline(options: CollectorOptions): Promise<void> {
    await this.discoverMarkets(options);
    const acceptedMarkets = await this.readAcceptedMarkets(options);
    if (acceptedMarkets.length === 0 && !options.allowEmptyMarketSet) {
      throw new Error('No BTC Up/Down markets accepted for requested 1h/4h/1d date range. Inspect discovery_debug JSON.');
    }
    await this.downloadPolymarketPrices(options);
    // Proxy debug mode without Chainlink needs Binance raw files because Binance becomes the non-official primary proxy source.
    if (shouldDownloadBinanceDuringFullPipeline(options)) await this.downloadBinance(options);
    await this.buildDataset(options);
  }

  private async writeMarketsParquet(options: CollectorOptions, markets: NormalizedMarket[]): Promise<void> {
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedMarketsRelativeFilePath(options)), marketsParquetSchema, markets.map(toMarketParquetRow));
  }

  private async writeMarketSummariesFromPricePoints(options: CollectorOptions, markets: NormalizedMarket[], pricePoints: NormalizedPricePoint[]): Promise<void> {
    const pricePointsByMarketSlug = new Map<string, NormalizedPricePoint[]>();
    for (const pricePoint of pricePoints) pricePointsByMarketSlug.set(pricePoint.marketSlug, [...(pricePointsByMarketSlug.get(pricePoint.marketSlug) ?? []), pricePoint]);
    const summaries = markets.map((market) => buildMarketSummary(market, pricePointsByMarketSlug.get(market.marketSlug) ?? []));
    await this.parquetWriter.writeRows(this.fileStorage.resolve(processedMarketSummaryRelativeFilePath(options)), marketSummaryParquetSchema, summaries.map(toMarketSummaryParquetRow));
    this.logger.info({ summariesCreated: summaries.length }, 'Market summaries completed');
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

  private async readChainlinkPricePoints(options: CollectorOptions): Promise<ExternalPricePoint[]> {
    if (this.primaryExternalPriceSource === undefined) return [];
    return this.primaryExternalPriceSource.getPricePointsForDateRange(options);
  }

  private async readBinancePricePoints(options: CollectorOptions): Promise<ExternalPricePoint[]> {
    const allPricePoints: ExternalPricePoint[] = [];
    for (const date of enumerateDates(options.startDate, options.endDate)) {
      const relativeFilePath = rawBinanceRelativeFilePath(options, date);
      if (await this.fileStorage.exists(relativeFilePath)) {
        const rawPricePoints = await this.fileStorage.readJson<{ timestampMilliseconds: number; btcPrice: number }[]>(relativeFilePath);
        allPricePoints.push(...rawPricePoints.map((pricePoint) => ({
          timestampMilliseconds: pricePoint.timestampMilliseconds,
          price: pricePoint.btcPrice,
          sourceName: 'binance',
        })));
      }
    }
    return allPricePoints;
  }

  private async readBuiltPricePointsDebugJson(options: CollectorOptions): Promise<NormalizedPricePoint[]> {
    const debugFilePath = processedPricePointsDebugRelativeFilePath(options);
    if (await this.fileStorage.exists(debugFilePath)) return this.fileStorage.readJson<NormalizedPricePoint[]>(debugFilePath);
    throw new Error(`Standalone summarize requires debug JSON, but ${debugFilePath} does not exist. Run all/build-dataset with --write-debug-json true for this date range first.`);
  }
}

export function isPriceHistoryTooCoarse(priceHistory: PriceHistoryPoint[], requestedFidelityMinutes: number): boolean {
  if (priceHistory.length < 2) return false;
  const orderedHistory = [...priceHistory].sort((leftPoint, rightPoint) => leftPoint.timestampMilliseconds - rightPoint.timestampMilliseconds);
  const gaps = orderedHistory.slice(1).map((pricePoint, index) => pricePoint.timestampMilliseconds - (orderedHistory[index]?.timestampMilliseconds ?? pricePoint.timestampMilliseconds));
  const maximumGapMilliseconds = Math.max(...gaps);
  return maximumGapMilliseconds > requestedFidelityMinutes * 60_000 * 5;
}

export function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let timestampMilliseconds = Date.parse(`${startDate}T00:00:00.000Z`); timestampMilliseconds < Date.parse(`${endDate}T00:00:00.000Z`); timestampMilliseconds += 86_400_000) {
    dates.push(new Date(timestampMilliseconds).toISOString().slice(0, 10));
  }
  return dates;
}


export type PrimaryPriceMode =
  | { mode: 'official_chainlink'; primaryPricePoints: ExternalPricePoint[] }
  | { mode: 'binance_proxy_debug'; primaryPricePoints: ExternalPricePoint[] }
  | { mode: 'missing_primary_price_source' };

export function determinePrimaryPriceMode(options: Pick<CollectorOptions, 'chainlinkInputFile' | 'allowProxyPrimaryPriceSourceForDebug'>, chainlinkPricePoints: ExternalPricePoint[]): PrimaryPriceMode {
  if (options.chainlinkInputFile !== undefined) {
    if (chainlinkPricePoints.length === 0) {
      throw new Error('Chainlink input file was provided but contains zero valid price points. Refusing to fallback to Binance proxy because official Chainlink mode was requested.');
    }
    return { mode: 'official_chainlink', primaryPricePoints: chainlinkPricePoints };
  }
  if (options.allowProxyPrimaryPriceSourceForDebug === true) return { mode: 'binance_proxy_debug', primaryPricePoints: [] };
  throw new Error('Chainlink input is required for official dataset build. Provide --chainlink-input-file or use --allow-proxy-primary-price-source-for-debug true for non-official proxy testing.');
}

export function shouldDownloadBinanceDuringFullPipeline(options: Pick<CollectorOptions, 'includeBinanceSecondarySignal' | 'allowProxyPrimaryPriceSourceForDebug' | 'chainlinkInputFile'>): boolean {
  return (
    options.includeBinanceSecondarySignal === true ||
    (
      options.chainlinkInputFile === undefined &&
      options.allowProxyPrimaryPriceSourceForDebug === true
    )
  );
}

export function dateRangeStateKey(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `${options.startDate}_${options.endDate}`; }
export function collectorStateKey(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `${marketDurationStateKey(options)}_${dateRangeStateKey(options)}`; }
export function marketDurationStateKey(options: Pick<CollectorOptions, 'marketDuration'>): string { return options.marketDuration; }
export function rawGammaRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `raw/gamma/btc-up-down_candidates_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.json`; }
export function discoveryDebugRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `raw/gamma/discovery_debug_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.json`; }
export function acceptedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/accepted_markets_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.jsonl`; }
export function rejectedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `rejected/rejected_markets_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.jsonl`; }
export function rawPriceHistoryRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'priceFidelityMinutes' | 'marketDuration'>, marketSlug: string, outcome: 'up' | 'down'): string { return `raw/polymarket-prices/${marketDurationStateKey(options)}_${dateRangeStateKey(options)}_${marketSlug}_${outcome}_${options.priceFidelityMinutes}m.json`; }
export function rawBinanceRelativeFilePath(options: Pick<CollectorOptions, 'symbol' | 'binanceMarketType' | 'binanceDataType'>, date: string): string { return `raw/binance/${options.binanceMarketType}_${options.binanceDataType}_${options.symbol}_${date}.json`; }
export function processedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/markets_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.parquet`; }
export function processedPricePointsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/price_points_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.parquet`; }
export function processedPricePointsDebugRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/price_points_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.debug.json`; }
export function processedMarketSummaryRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/market_summary_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.parquet`; }
export function processedStrategyTrainingRowsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/strategy_training_rows_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.parquet`; }
export function processedStrategyTrainingRowsDebugRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/strategy_training_rows_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.debug.json`; }
export function processedRejectedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/rejected_markets_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.parquet`; }

export function buildStrategyTrainingRows(pricePoints: NormalizedPricePoint[]): StrategyTrainingRow[] {
  const byMarket = new Map<string, NormalizedPricePoint[]>();
  for (const pricePoint of pricePoints) byMarket.set(pricePoint.marketSlug, [...(byMarket.get(pricePoint.marketSlug) ?? []), pricePoint]);
  return [...byMarket.values()].flatMap((marketPricePoints) => {
    const ordered = [...marketPricePoints].sort((left, right) => left.timestampMilliseconds - right.timestampMilliseconds);
    return ordered.map((pricePoint, index): StrategyTrainingRow => ({
      marketSlug: pricePoint.marketSlug,
      conditionId: pricePoint.conditionId,
      marketDuration: pricePoint.marketDuration,
      timestampMilliseconds: pricePoint.timestampMilliseconds,
      secondsLeft: pricePoint.secondsLeft,
      targetPrice: pricePoint.targetPrice,
      upPrice: pricePoint.upPrice,
      downPrice: pricePoint.downPrice,
      primaryPriceSourceName: pricePoint.primaryPriceSourceName,
      primaryPrice: pricePoint.primaryPrice,
      primaryTimestampMilliseconds: pricePoint.primaryTimestampMilliseconds,
      primaryDistanceUsd: pricePoint.primaryDistanceUsd,
      primaryDistanceBasisPoints: pricePoint.primaryDistanceBasisPoints,
      binancePrice: pricePoint.binancePrice,
      binanceTimestampMilliseconds: pricePoint.binanceTimestampMilliseconds,
      binanceDistanceUsd: pricePoint.binanceDistanceUsd,
      binanceDistanceBasisPoints: pricePoint.binanceDistanceBasisPoints,
      binanceMinusChainlinkBasisPoints: pricePoint.binanceMinusChainlinkBasisPoints,
      upPriceChangePrevious1Point: previousPriceChange(ordered, index, 'upPrice', 1),
      downPriceChangePrevious1Point: previousPriceChange(ordered, index, 'downPrice', 1),
      upPriceChangePrevious2Points: previousPriceChange(ordered, index, 'upPrice', 2),
      downPriceChangePrevious2Points: previousPriceChange(ordered, index, 'downPrice', 2),
      upPriceChangePrevious3Points: previousPriceChange(ordered, index, 'upPrice', 3),
      downPriceChangePrevious3Points: previousPriceChange(ordered, index, 'downPrice', 3),
      winner: pricePoint.winner,
      upWinsBinary: pricePoint.winner === 'up' ? 1 : pricePoint.winner === 'down' ? 0 : null,
      futureMaximumUpPrice: pricePoint.futureMaximumUpPrice,
      futureMaximumDownPrice: pricePoint.futureMaximumDownPrice,
      futureMinimumUpPrice: pricePoint.futureMinimumUpPrice,
      futureMinimumDownPrice: pricePoint.futureMinimumDownPrice,
      futureFinalUpPrice: pricePoint.futureFinalUpPrice,
      futureFinalDownPrice: pricePoint.futureFinalDownPrice,
      futureSecondsUntilUpPriceGreaterThanOrEqual090: pricePoint.futureSecondsUntilUpPriceGreaterThanOrEqual090,
      futureSecondsUntilDownPriceGreaterThanOrEqual090: pricePoint.futureSecondsUntilDownPriceGreaterThanOrEqual090,
      futureReachesUp090: pricePoint.futureReachesUp090,
      futureReachesUp095: pricePoint.futureReachesUp095,
      futureReachesUp099: pricePoint.futureReachesUp099,
      futureReachesDown090: pricePoint.futureReachesDown090,
      futureReachesDown095: pricePoint.futureReachesDown095,
      futureReachesDown099: pricePoint.futureReachesDown099,
      dataQualityFlags: pricePoint.dataQualityFlags,
    }));
  });
}

function previousPriceChange(pricePoints: NormalizedPricePoint[], index: number, fieldName: 'upPrice' | 'downPrice', lag: number): number | null {
  const currentPrice = pricePoints[index]?.[fieldName] ?? null;
  const previousPrice = pricePoints[index - lag]?.[fieldName] ?? null;
  return currentPrice === null || previousPrice === null ? null : currentPrice - previousPrice;
}

function toMarketParquetRow(market: NormalizedMarket): Record<string, unknown> { return { market_slug: market.marketSlug, condition_id: market.conditionId, question: market.question, market_duration: market.marketDuration, market_start_timestamp_milliseconds: market.marketStartTimestampMilliseconds, market_end_timestamp_milliseconds: market.marketEndTimestampMilliseconds, up_token_id: market.upTokenId, down_token_id: market.downTokenId, target_price: market.targetPrice, winner: market.winner, is_resolved: market.isResolved, is_closed: market.isClosed, raw_outcomes: market.rawOutcomes, raw_outcome_prices: market.rawOutcomePrices, data_quality_flags: serializeDataQualityFlags(market.dataQualityFlags) }; }
function toPricePointParquetRow(pricePoint: NormalizedPricePoint): Record<string, unknown> { return { market_slug: pricePoint.marketSlug, condition_id: pricePoint.conditionId, market_duration: pricePoint.marketDuration, timestamp_milliseconds: pricePoint.timestampMilliseconds, seconds_left: pricePoint.secondsLeft, target_price: pricePoint.targetPrice, up_price: pricePoint.upPrice, down_price: pricePoint.downPrice, primary_price_source_name: pricePoint.primaryPriceSourceName, primary_price: pricePoint.primaryPrice, primary_timestamp_milliseconds: pricePoint.primaryTimestampMilliseconds, primary_distance_usd: pricePoint.primaryDistanceUsd, primary_distance_basis_points: pricePoint.primaryDistanceBasisPoints, chainlink_price: pricePoint.chainlinkPrice, chainlink_timestamp_milliseconds: pricePoint.chainlinkTimestampMilliseconds, chainlink_distance_usd: pricePoint.chainlinkDistanceUsd, chainlink_distance_basis_points: pricePoint.chainlinkDistanceBasisPoints, binance_price: pricePoint.binancePrice, binance_timestamp_milliseconds: pricePoint.binanceTimestampMilliseconds, binance_distance_usd: pricePoint.binanceDistanceUsd, binance_distance_basis_points: pricePoint.binanceDistanceBasisPoints, binance_minus_chainlink_basis_points: pricePoint.binanceMinusChainlinkBasisPoints, winner: pricePoint.winner, is_resolved: pricePoint.isResolved, data_quality_flags: serializeDataQualityFlags(pricePoint.dataQualityFlags), future_maximum_up_price: pricePoint.futureMaximumUpPrice, future_maximum_down_price: pricePoint.futureMaximumDownPrice, future_minimum_up_price: pricePoint.futureMinimumUpPrice, future_minimum_down_price: pricePoint.futureMinimumDownPrice, future_final_up_price: pricePoint.futureFinalUpPrice, future_final_down_price: pricePoint.futureFinalDownPrice, future_seconds_until_up_price_greater_than_or_equal_075: pricePoint.futureSecondsUntilUpPriceGreaterThanOrEqual075, future_seconds_until_up_price_greater_than_or_equal_080: pricePoint.futureSecondsUntilUpPriceGreaterThanOrEqual080, future_seconds_until_up_price_greater_than_or_equal_090: pricePoint.futureSecondsUntilUpPriceGreaterThanOrEqual090, future_seconds_until_up_price_greater_than_or_equal_095: pricePoint.futureSecondsUntilUpPriceGreaterThanOrEqual095, future_seconds_until_up_price_greater_than_or_equal_099: pricePoint.futureSecondsUntilUpPriceGreaterThanOrEqual099, future_seconds_until_down_price_greater_than_or_equal_075: pricePoint.futureSecondsUntilDownPriceGreaterThanOrEqual075, future_seconds_until_down_price_greater_than_or_equal_080: pricePoint.futureSecondsUntilDownPriceGreaterThanOrEqual080, future_seconds_until_down_price_greater_than_or_equal_090: pricePoint.futureSecondsUntilDownPriceGreaterThanOrEqual090, future_seconds_until_down_price_greater_than_or_equal_095: pricePoint.futureSecondsUntilDownPriceGreaterThanOrEqual095, future_seconds_until_down_price_greater_than_or_equal_099: pricePoint.futureSecondsUntilDownPriceGreaterThanOrEqual099, future_reaches_up_075: pricePoint.futureReachesUp075, future_reaches_up_080: pricePoint.futureReachesUp080, future_reaches_up_090: pricePoint.futureReachesUp090, future_reaches_up_095: pricePoint.futureReachesUp095, future_reaches_up_099: pricePoint.futureReachesUp099, future_reaches_down_075: pricePoint.futureReachesDown075, future_reaches_down_080: pricePoint.futureReachesDown080, future_reaches_down_090: pricePoint.futureReachesDown090, future_reaches_down_095: pricePoint.futureReachesDown095, future_reaches_down_099: pricePoint.futureReachesDown099 }; }
function toMarketSummaryParquetRow(summary: ReturnType<typeof buildMarketSummary>): Record<string, unknown> { return { market_slug: summary.marketSlug, condition_id: summary.conditionId, market_duration: summary.marketDuration, market_start_timestamp_milliseconds: summary.marketStartTimestampMilliseconds, market_end_timestamp_milliseconds: summary.marketEndTimestampMilliseconds, target_price: summary.targetPrice, winner: summary.winner, primary_price_source_name: summary.primaryPriceSourceName, close_primary_price: summary.closePrimaryPrice, final_primary_distance_basis_points: summary.finalPrimaryDistanceBasisPoints, close_chainlink_price: summary.closeChainlinkPrice, final_chainlink_distance_basis_points: summary.finalChainlinkDistanceBasisPoints, close_binance_price: summary.closeBinancePrice, final_binance_distance_basis_points: summary.finalBinanceDistanceBasisPoints, final_binance_minus_chainlink_basis_points: summary.finalBinanceMinusChainlinkBasisPoints, maximum_up_price: summary.maximumUpPrice, maximum_down_price: summary.maximumDownPrice, up_price_open: summary.upPriceOpen, down_price_open: summary.downPriceOpen, up_price_close: summary.upPriceClose, down_price_close: summary.downPriceClose, up_price_minimum: summary.upPriceMinimum, up_price_maximum: summary.upPriceMaximum, down_price_minimum: summary.downPriceMinimum, down_price_maximum: summary.downPriceMaximum, up_price_range: summary.upPriceRange, down_price_range: summary.downPriceRange, up_price_last: summary.upPriceLast, down_price_last: summary.downPriceLast, up_price_mean: summary.upPriceMean, down_price_mean: summary.downPriceMean, up_price_median: summary.upPriceMedian, down_price_median: summary.downPriceMedian, up_price_standard_deviation: summary.upPriceStandardDeviation, down_price_standard_deviation: summary.downPriceStandardDeviation, up_price_number_of_observations: summary.upPriceNumberOfObservations, down_price_number_of_observations: summary.downPriceNumberOfObservations, price_points_count: summary.pricePointsCount, first_timestamp_up_price_greater_than_or_equal_075: summary.firstTimestampUpPriceGreaterThanOrEqual075, first_timestamp_up_price_greater_than_or_equal_080: summary.firstTimestampUpPriceGreaterThanOrEqual080, first_timestamp_up_price_greater_than_or_equal_090: summary.firstTimestampUpPriceGreaterThanOrEqual090, first_timestamp_up_price_greater_than_or_equal_095: summary.firstTimestampUpPriceGreaterThanOrEqual095, first_timestamp_up_price_greater_than_or_equal_099: summary.firstTimestampUpPriceGreaterThanOrEqual099, seconds_left_at_first_up_price_greater_than_or_equal_090: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual090, first_timestamp_down_price_greater_than_or_equal_075: summary.firstTimestampDownPriceGreaterThanOrEqual075, first_timestamp_down_price_greater_than_or_equal_080: summary.firstTimestampDownPriceGreaterThanOrEqual080, first_timestamp_down_price_greater_than_or_equal_090: summary.firstTimestampDownPriceGreaterThanOrEqual090, first_timestamp_down_price_greater_than_or_equal_095: summary.firstTimestampDownPriceGreaterThanOrEqual095, first_timestamp_down_price_greater_than_or_equal_099: summary.firstTimestampDownPriceGreaterThanOrEqual099, seconds_left_at_first_down_price_greater_than_or_equal_090: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual090, data_quality_flags: serializeDataQualityFlags(summary.dataQualityFlags) }; }
function toStrategyTrainingRowParquetRow(row: StrategyTrainingRow): Record<string, unknown> { return { market_slug: row.marketSlug, condition_id: row.conditionId, market_duration: row.marketDuration, timestamp_milliseconds: row.timestampMilliseconds, seconds_left: row.secondsLeft, target_price: row.targetPrice, up_price: row.upPrice, down_price: row.downPrice, primary_price_source_name: row.primaryPriceSourceName, primary_price: row.primaryPrice, primary_timestamp_milliseconds: row.primaryTimestampMilliseconds, primary_distance_usd: row.primaryDistanceUsd, primary_distance_basis_points: row.primaryDistanceBasisPoints, binance_price: row.binancePrice, binance_timestamp_milliseconds: row.binanceTimestampMilliseconds, binance_distance_usd: row.binanceDistanceUsd, binance_distance_basis_points: row.binanceDistanceBasisPoints, binance_minus_chainlink_basis_points: row.binanceMinusChainlinkBasisPoints, up_price_change_previous_1_point: row.upPriceChangePrevious1Point, down_price_change_previous_1_point: row.downPriceChangePrevious1Point, up_price_change_previous_2_points: row.upPriceChangePrevious2Points, down_price_change_previous_2_points: row.downPriceChangePrevious2Points, up_price_change_previous_3_points: row.upPriceChangePrevious3Points, down_price_change_previous_3_points: row.downPriceChangePrevious3Points, winner: row.winner, up_wins_binary: row.upWinsBinary, future_maximum_up_price: row.futureMaximumUpPrice, future_maximum_down_price: row.futureMaximumDownPrice, future_minimum_up_price: row.futureMinimumUpPrice, future_minimum_down_price: row.futureMinimumDownPrice, future_final_up_price: row.futureFinalUpPrice, future_final_down_price: row.futureFinalDownPrice, future_seconds_until_up_price_greater_than_or_equal_090: row.futureSecondsUntilUpPriceGreaterThanOrEqual090, future_seconds_until_down_price_greater_than_or_equal_090: row.futureSecondsUntilDownPriceGreaterThanOrEqual090, future_reaches_up_090: row.futureReachesUp090, future_reaches_up_095: row.futureReachesUp095, future_reaches_up_099: row.futureReachesUp099, future_reaches_down_090: row.futureReachesDown090, future_reaches_down_095: row.futureReachesDown095, future_reaches_down_099: row.futureReachesDown099, data_quality_flags: serializeDataQualityFlags(row.dataQualityFlags) }; }

function countAcceptedByDuration(markets: NormalizedMarket[]): Record<'1h' | '4h' | '1d', number> {
  return {
    '1h': markets.filter((market) => market.marketDuration === '1h').length,
    '4h': markets.filter((market) => market.marketDuration === '4h').length,
    '1d': markets.filter((market) => market.marketDuration === '1d').length,
  };
}

function countRejectedByReason(markets: RejectedMarket[]): Record<string, number> {
  const counts: Record<string, number> = {
    unsupported_duration: 0,
    unknown_duration: 0,
    not_explicit_up_down_product: 0,
    non_up_down_outcomes: 0,
    target_price_missing: 0,
    token_ids_missing: 0,
  };
  for (const market of markets) counts[market.rejectionReason] = (counts[market.rejectionReason] ?? 0) + 1;
  return counts;
}

function toRejectedMarketParquetRow(rejectedMarket: RejectedMarket): Record<string, unknown> { return { market_slug: rejectedMarket.marketSlug, condition_id: rejectedMarket.conditionId, question: rejectedMarket.question, detected_market_duration: rejectedMarket.detectedMarketDuration ?? null, rejection_reason: rejectedMarket.rejectionReason, raw_market_file_path: rejectedMarket.rawMarketFilePath, data_quality_flags: serializeDataQualityFlags(rejectedMarket.dataQualityFlags) }; }
