import pLimit from 'p-limit';
import type { FileStorage } from '../adapters/fileStorage.js';
import type { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { serializeDataQualityFlags } from '../adapters/parquetWriter.js';
import { determineMarketWinner, parseOutcomePrices, parseOutcomes } from '../core/parsing.js';
import { candidateHasTargetPrice, detectMarketDuration, extractClobTokenIds, extractTime, isBitcoinUpDownMarket, type GammaDiscoveryOptions, type PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import type { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import type { CollectorLogger } from '../adapters/logger.js';
import type { NormalizedMarket, NormalizedPricePoint, PriceHistoryPoint, RejectedMarket, RequestedMarketDuration, StrategyTrainingRow } from '../core/domain.js';
import { buildNormalizedPricePointsForMarketWithSkipCount } from '../core/alignment.js';
import { buildMarketSummary } from '../core/summary.js';
import { marketsParquetSchema, marketSummaryParquetSchema, pricePointsParquetSchema, rejectedMarketsParquetSchema, strategyTrainingRowsParquetSchema } from './schemas.js';
import { StateRepository } from './stateRepository.js';

export interface CollectorOptions {
  startDate: string;
  endDate: string;
  priceFidelityMinutes: number;
  marketDuration: RequestedMarketDuration;
  force: boolean;
  requestDelayMilliseconds: number;
  maximumConcurrentRequests: number;
  writeDebugJson: boolean;
  allowBroadGammaDateScan: boolean;
  allowEmptyMarketSet: boolean;
  discoveryTimeoutSeconds?: number;
  discoveryMaxPagesPerQuery?: number;
  discoveryMaxTotalRequests?: number;
  discoveryMaxCandidates?: number;
  discoveryRequestTimeoutSeconds?: number;
  discoveryExpandedSearch?: boolean;
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
    private readonly logger: CollectorLogger,
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
      : await this.gammaApiAdapter.discoverBitcoinUpDownMarkets(options.startDate, options.endDate, buildGammaDiscoveryOptions(options));
    await this.fileStorage.writeJson(rawGammaFilePath, rawMarkets, options.force);

    const discoveryResult = this.gammaApiAdapter.parseMarkets(rawMarkets, this.fileStorage.resolve(rawGammaFilePath), options.marketDuration);
    await this.fileStorage.writeJsonLines(acceptedMarketsRelativeFilePath(options), discoveryResult.acceptedMarkets, true);
    await this.fileStorage.writeJsonLines(rejectedMarketsRelativeFilePath(options), discoveryResult.rejectedMarkets, true);
    await this.writeMarketsParquet(options, discoveryResult.acceptedMarkets);
    await this.writeRejectedMarketsParquet(options, discoveryResult.rejectedMarkets);
    const discoveryDebug = this.gammaApiAdapter.attachParseResultsToLastDiscoveryDebug(discoveryResult);
    if (discoveryDebug !== null) await this.fileStorage.writeJson(discoveryDebugRelativeFilePath(options), discoveryDebug, true);
    if (discoveryDebug !== null) await this.fileStorage.writeJson(discoveryAuditRelativeFilePath(options), buildDiscoveryAudit(options, rawMarkets, discoveryResult, discoveryDebug), true);

    this.logger.info(
      {
        rawMarketsFetched: rawMarkets.length,
        candidateMarketsFetched: rawMarkets.length,
        locallyMatchedMarkets: rawMarkets.filter(isBitcoinUpDownMarket).length,
        acceptedMarkets: discoveryResult.acceptedMarkets.length,
        rejectedMarkets: discoveryResult.rejectedMarkets.length,
        marketsWithoutTarget: discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'target_price_missing').length,
        marketsWithoutTokenIds: discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'token_ids_missing').length,
        outsideRequestedDateRange: discoveryDebug?.outsideRequestedDateRange ?? discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'outside_requested_date_range').length,
        hydrationAttempted: discoveryDebug?.hydrationAttempted ?? null,
        hydrationSucceeded: discoveryDebug?.hydrationSucceeded ?? null,
        targetPriceMissingAfterHydration: discoveryDebug?.targetPriceMissingAfterHydration ?? discoveryResult.rejectedMarkets.filter((market) => market.rejectionReason === 'target_price_missing').length,
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
    const totalPolymarketPriceRows = await markets.reduce(async (sumPromise, market) => { const sum = await sumPromise; const up = await this.readPriceHistory(options, market.marketSlug, 'up'); const down = await this.readPriceHistory(options, market.marketSlug, 'down'); return sum + up.length + down.length; }, Promise.resolve(0));
    this.logger.info({ downloadedPriceHistories, emptyPriceHistories, totalPolymarketPriceRows }, 'Polymarket price history download completed');
    await this.stateRepository.markStepCompleted(collectorStateKey(options), 'download_polymarket_prices');
  }

  public async buildDataset(options: CollectorOptions): Promise<BuildDatasetResult> {
    const markets = await this.readAcceptedMarkets(options);
    const allPricePoints: NormalizedPricePoint[] = [];
    const rejectedMarkets: RejectedMarket[] = [];
    let polymarketRowsRead = 0;
    let skippedRowsMissingPolymarketPrice = 0;
    let skippedRowsInvalidPolymarketPrice = 0;

    for (const market of markets) {
      try {
        const upPriceHistory = await this.readPriceHistory(options, market.marketSlug, 'up');
        const downPriceHistory = await this.readPriceHistory(options, market.marketSlug, 'down');
        polymarketRowsRead += upPriceHistory.length + downPriceHistory.length;
        const buildResult = buildNormalizedPricePointsForMarketWithSkipCount({
          market,
          upPriceHistory,
          downPriceHistory,
          requestedFidelityMinutes: options.priceFidelityMinutes,
        });
        skippedRowsMissingPolymarketPrice += buildResult.skippedRowsMissingPolymarketPrice;
        skippedRowsInvalidPolymarketPrice += buildResult.skippedRowsInvalidPolymarketPrice;
        allPricePoints.push(...buildResult.pricePoints);
      } catch (error) {
        rejectedMarkets.push({ marketSlug: market.marketSlug, conditionId: market.conditionId, question: market.question, rejectionReason: 'dataset_build_error', rawMarketFilePath: rawGammaRelativeFilePath(options), dataQualityFlags: [`dataset_build_error:${(error as Error).message}`], detectedMarketDuration: market.marketDuration });
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
      const deletedDebugJsonResults = await Promise.all([this.fileStorage.deleteIfExists(processedPricePointsDebugRelativeFilePath(options)), this.fileStorage.deleteIfExists(processedStrategyTrainingRowsDebugRelativeFilePath(options))]);
      deletedDebugJsonFiles = deletedDebugJsonResults.filter((wasDeleted) => wasDeleted).length;
    }
    const existingRejectedMarkets = (await this.fileStorage.exists(rejectedMarketsRelativeFilePath(options))) ? await this.fileStorage.readJsonLines<RejectedMarket>(rejectedMarketsRelativeFilePath(options)) : [];
    await this.writeRejectedMarketsParquet(options, [...existingRejectedMarkets, ...rejectedMarkets]);
    this.logger.info({ polymarketRowsRead, pricePointsBuilt: allPricePoints.length, strategyTrainingRowsBuilt: strategyTrainingRows.length, skippedRowsMissingPolymarketPrice, skippedRowsInvalidPolymarketPrice, additionalRejectedMarkets: rejectedMarkets.length, writeDebugJson: options.writeDebugJson, deletedDebugJsonFiles }, 'Dataset build completed');
    await this.stateRepository.markStepCompleted(collectorStateKey(options), 'build_dataset');
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
      const audit = await this.fileStorage.readJson<Record<string, unknown>>(discoveryAuditRelativeFilePath(options));
      this.logger.info({ discoveryDebugFilePath: this.fileStorage.resolve(discoveryDebugRelativeFilePath(options)), discoveryAuditFilePath: this.fileStorage.resolve(discoveryAuditRelativeFilePath(options)), acceptedMarkets: audit['acceptedMarkets'], acceptedByDuration: audit['acceptedByDuration'], candidatesInsideRequestedDateRange: audit['candidatesInsideRequestedDateRange'], insideDateRangeByDuration: audit['insideDateRangeByDuration'], rejectedByReason: audit['rejectedByReason'], missingHourlyWindowsCount: Array.isArray(audit['missingHourlyWindows']) ? audit['missingHourlyWindows'].length : 0 }, 'Discovery diagnosis completed');
    }
  }

  public async runFullPipeline(options: CollectorOptions): Promise<void> {
    await this.discoverMarkets(options);
    const acceptedMarkets = await this.readAcceptedMarkets(options);
    if (acceptedMarkets.length === 0 && !options.allowEmptyMarketSet) {
      throw new Error('No BTC Up/Down markets accepted for requested 1h/4h/1d date range. Inspect discovery_debug JSON.');
    }
    await this.downloadPolymarketPrices(options);
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
    this.logger.info({ summariesCreated: summaries.length, marketSummaryRowsBuilt: summaries.length }, 'Market summaries completed');
    await this.stateRepository.markStepCompleted(collectorStateKey(options), 'build_market_summary');
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

function buildGammaDiscoveryOptions(options: CollectorOptions): GammaDiscoveryOptions {
  const discoveryOptions: GammaDiscoveryOptions = {
    allowBroadGammaDateScan: options.allowBroadGammaDateScan,
    requestedMarketDuration: options.marketDuration,
  };
  if (options.discoveryTimeoutSeconds !== undefined) discoveryOptions.discoveryTimeoutSeconds = options.discoveryTimeoutSeconds;
  if (options.discoveryMaxPagesPerQuery !== undefined) discoveryOptions.discoveryMaxPagesPerQuery = options.discoveryMaxPagesPerQuery;
  if (options.discoveryMaxTotalRequests !== undefined) discoveryOptions.discoveryMaxTotalRequests = options.discoveryMaxTotalRequests;
  if (options.discoveryMaxCandidates !== undefined) discoveryOptions.discoveryMaxCandidates = options.discoveryMaxCandidates;
  if (options.discoveryRequestTimeoutSeconds !== undefined) discoveryOptions.discoveryRequestTimeoutSeconds = options.discoveryRequestTimeoutSeconds;
  if (options.discoveryExpandedSearch !== undefined) discoveryOptions.discoveryExpandedSearch = options.discoveryExpandedSearch;
  return discoveryOptions;
}

export function dateRangeStateKey(options: Pick<CollectorOptions, 'startDate' | 'endDate'>): string { return `${options.startDate}_${options.endDate}`; }
export function collectorStateKey(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `${marketDurationStateKey(options)}_${dateRangeStateKey(options)}`; }
export function marketDurationStateKey(options: Pick<CollectorOptions, 'marketDuration'>): string { return options.marketDuration; }
export function rawGammaRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `raw/gamma/btc-up-down_candidates_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.json`; }
export function discoveryDebugRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `raw/gamma/discovery_debug_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.json`; }
export function discoveryAuditRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/discovery_audit_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.json`; }
export function acceptedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `processed/accepted_markets_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.jsonl`; }
export function rejectedMarketsRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>): string { return `rejected/rejected_markets_${marketDurationStateKey(options)}_${dateRangeStateKey(options)}.jsonl`; }
export function rawPriceHistoryRelativeFilePath(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'priceFidelityMinutes' | 'marketDuration'>, marketSlug: string, outcome: 'up' | 'down'): string { return `raw/polymarket-prices/${marketDurationStateKey(options)}_${dateRangeStateKey(options)}_${marketSlug}_${outcome}_${options.priceFidelityMinutes}m.json`; }
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
      ...pricePoint,
      upWinsBinary: pricePoint.winner === 'up' ? 1 : pricePoint.winner === 'down' ? 0 : null,
      upPriceChangePrevious1Point: previousPriceChange(ordered, index, 'upPrice', 1),
      downPriceChangePrevious1Point: previousPriceChange(ordered, index, 'downPrice', 1),
      upPriceChangePrevious2Points: previousPriceChange(ordered, index, 'upPrice', 2),
      downPriceChangePrevious2Points: previousPriceChange(ordered, index, 'downPrice', 2),
      upPriceChangePrevious3Points: previousPriceChange(ordered, index, 'upPrice', 3),
      downPriceChangePrevious3Points: previousPriceChange(ordered, index, 'downPrice', 3),
    }));
  });
}

function previousPriceChange(pricePoints: NormalizedPricePoint[], index: number, fieldName: 'upPrice' | 'downPrice', lag: number): number | null {
  const currentPrice = pricePoints[index]?.[fieldName] ?? null;
  const previousPrice = pricePoints[index - lag]?.[fieldName] ?? null;
  return currentPrice === null || previousPrice === null ? null : currentPrice - previousPrice;
}

function toMarketParquetRow(market: NormalizedMarket): Record<string, unknown> { return { market_slug: market.marketSlug, condition_id: market.conditionId, question: market.question, market_duration: market.marketDuration, market_start_timestamp_milliseconds: market.marketStartTimestampMilliseconds, market_end_timestamp_milliseconds: market.marketEndTimestampMilliseconds, up_token_id: market.upTokenId, down_token_id: market.downTokenId, target_price: market.targetPrice, winner: market.winner, is_resolved: market.isResolved, is_closed: market.isClosed, raw_outcomes: market.rawOutcomes, raw_outcome_prices: market.rawOutcomePrices, data_quality_flags: serializeDataQualityFlags(market.dataQualityFlags) }; }
function toPricePointParquetRow(pricePoint: NormalizedPricePoint): Record<string, unknown> { return { market_slug: pricePoint.marketSlug, condition_id: pricePoint.conditionId, market_duration: pricePoint.marketDuration, timestamp_milliseconds: pricePoint.timestampMilliseconds, timestamp_iso: pricePoint.timestampIso, seconds_left: pricePoint.secondsLeft, up_price: pricePoint.upPrice, down_price: pricePoint.downPrice, target_price: pricePoint.targetPrice, winner: pricePoint.winner, is_resolved: pricePoint.isResolved, data_quality_flags: serializeDataQualityFlags(pricePoint.dataQualityFlags), future_maximum_up_price: pricePoint.futureMaximumUpPrice, future_maximum_down_price: pricePoint.futureMaximumDownPrice, future_minimum_up_price: pricePoint.futureMinimumUpPrice, future_minimum_down_price: pricePoint.futureMinimumDownPrice, future_final_up_price: pricePoint.futureFinalUpPrice, future_final_down_price: pricePoint.futureFinalDownPrice, future_reaches_up_075: pricePoint.futureReachesUp075, future_reaches_up_080: pricePoint.futureReachesUp080, future_reaches_up_090: pricePoint.futureReachesUp090, future_reaches_up_095: pricePoint.futureReachesUp095, future_reaches_up_099: pricePoint.futureReachesUp099, future_reaches_down_075: pricePoint.futureReachesDown075, future_reaches_down_080: pricePoint.futureReachesDown080, future_reaches_down_090: pricePoint.futureReachesDown090, future_reaches_down_095: pricePoint.futureReachesDown095, future_reaches_down_099: pricePoint.futureReachesDown099 }; }
function toMarketSummaryParquetRow(summary: ReturnType<typeof buildMarketSummary>): Record<string, unknown> { return { market_slug: summary.marketSlug, condition_id: summary.conditionId, market_duration: summary.marketDuration, market_start_timestamp_milliseconds: summary.marketStartTimestampMilliseconds, market_end_timestamp_milliseconds: summary.marketEndTimestampMilliseconds, target_price: summary.targetPrice, winner: summary.winner, is_resolved: summary.isResolved, price_points_count: summary.pricePointsCount, first_timestamp: summary.firstTimestamp, last_timestamp: summary.lastTimestamp, up_price_open: summary.upPriceOpen, down_price_open: summary.downPriceOpen, up_price_close: summary.upPriceClose, down_price_close: summary.downPriceClose, final_up_price: summary.finalUpPrice, final_down_price: summary.finalDownPrice, up_price_min: summary.upPriceMinimum, up_price_max: summary.upPriceMaximum, up_price_mean: summary.upPriceMean, up_price_median: summary.upPriceMedian, up_price_stdev: summary.upPriceStandardDeviation, down_price_min: summary.downPriceMinimum, down_price_max: summary.downPriceMaximum, down_price_mean: summary.downPriceMean, down_price_median: summary.downPriceMedian, down_price_stdev: summary.downPriceStandardDeviation, first_up_reaches_075_timestamp: summary.firstTimestampUpPriceGreaterThanOrEqual075, first_up_reaches_080_timestamp: summary.firstTimestampUpPriceGreaterThanOrEqual080, first_up_reaches_090_timestamp: summary.firstTimestampUpPriceGreaterThanOrEqual090, first_up_reaches_095_timestamp: summary.firstTimestampUpPriceGreaterThanOrEqual095, first_up_reaches_099_timestamp: summary.firstTimestampUpPriceGreaterThanOrEqual099, first_down_reaches_075_timestamp: summary.firstTimestampDownPriceGreaterThanOrEqual075, first_down_reaches_080_timestamp: summary.firstTimestampDownPriceGreaterThanOrEqual080, first_down_reaches_090_timestamp: summary.firstTimestampDownPriceGreaterThanOrEqual090, first_down_reaches_095_timestamp: summary.firstTimestampDownPriceGreaterThanOrEqual095, first_down_reaches_099_timestamp: summary.firstTimestampDownPriceGreaterThanOrEqual099, first_up_reaches_075_seconds_left: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual075, first_up_reaches_080_seconds_left: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual080, first_up_reaches_090_seconds_left: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual090, first_up_reaches_095_seconds_left: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual095, first_up_reaches_099_seconds_left: summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual099, first_down_reaches_075_seconds_left: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual075, first_down_reaches_080_seconds_left: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual080, first_down_reaches_090_seconds_left: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual090, first_down_reaches_095_seconds_left: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual095, first_down_reaches_099_seconds_left: summary.secondsLeftAtFirstDownPriceGreaterThanOrEqual099, data_quality_flags: serializeDataQualityFlags(summary.dataQualityFlags) }; }
function toStrategyTrainingRowParquetRow(row: StrategyTrainingRow): Record<string, unknown> { return { ...toPricePointParquetRow(row), up_wins_binary: row.upWinsBinary, up_price_change_previous_1_point: row.upPriceChangePrevious1Point, down_price_change_previous_1_point: row.downPriceChangePrevious1Point, up_price_change_previous_2_points: row.upPriceChangePrevious2Points, down_price_change_previous_2_points: row.downPriceChangePrevious2Points, up_price_change_previous_3_points: row.upPriceChangePrevious3Points, down_price_change_previous_3_points: row.downPriceChangePrevious3Points }; }

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
    outside_requested_date_range: 0,
    end_date_missing: 0,
    non_terminal_market_template: 0,
  };
  for (const market of markets) counts[market.rejectionReason] = (counts[market.rejectionReason] ?? 0) + 1;
  return counts;
}

function toRejectedMarketParquetRow(rejectedMarket: RejectedMarket): Record<string, unknown> { return { market_slug: rejectedMarket.marketSlug, condition_id: rejectedMarket.conditionId, question: rejectedMarket.question, detected_market_duration: rejectedMarket.detectedMarketDuration ?? null, rejection_reason: rejectedMarket.rejectionReason, raw_market_file_path: rejectedMarket.rawMarketFilePath, data_quality_flags: serializeDataQualityFlags(rejectedMarket.dataQualityFlags) }; }

export function buildExpectedHourlyWindows(startDate: string, endDate: string): string[] {
  const windows: string[] = [];
  for (let timestamp = Date.parse(`${startDate}T00:00:00.000Z`); timestamp < Date.parse(`${endDate}T00:00:00.000Z`); timestamp += 60 * 60_000) windows.push(new Date(timestamp).toISOString());
  return windows;
}

export function buildDiscoveryAudit(options: Pick<CollectorOptions, 'startDate' | 'endDate' | 'marketDuration'>, rawMarkets: Record<string, unknown>[], discoveryResult: { acceptedMarkets: NormalizedMarket[]; rejectedMarkets: RejectedMarket[] }, debug?: { discoveryMaxTotalRequests?: number; rawResponsesFetched?: number; candidateMarketsFetched: number; deduplicatedCandidateMarkets: number; rejectedByReason: Record<string, number>; acceptedByDuration: Record<string, number>; stopReason?: string; searchedExactTitleTermsCount?: number; searchedExactTitleTermsByDuration?: Record<string, number>; searchedGenericTermsCount?: number }): Record<string, unknown> {
  const acceptedSlugs = new Set(discoveryResult.acceptedMarkets.map((market) => market.marketSlug));
  const auditRejectedMarkets = discoveryResult.rejectedMarkets.filter((market) => market.marketSlug === null || !acceptedSlugs.has(market.marketSlug));
  const auditDebug = debug ?? { candidateMarketsFetched: rawMarkets.length, deduplicatedCandidateMarkets: rawMarkets.length, rejectedByReason: countRejectedByReason(auditRejectedMarkets), acceptedByDuration: countAcceptedByDuration(discoveryResult.acceptedMarkets) };
  const rejectedByKey = new Map(auditRejectedMarkets.map((market) => [auditKey(market.conditionId, market.marketSlug, null), market]));
  const acceptedByKey = new Map(discoveryResult.acceptedMarkets.map((market) => [auditKey(market.conditionId, market.marketSlug, [market.upTokenId, market.downTokenId].filter((value): value is string => value !== null)), market]));
  const rejectedBySlug = new Map(auditRejectedMarkets.filter((market) => market.marketSlug !== null).map((market) => [market.marketSlug as string, market]));
  const acceptedBySlug = new Map(discoveryResult.acceptedMarkets.map((market) => [market.marketSlug, market]));
  const insideMarkets = rawMarkets.filter((market) => rawMarketInsideRequestedRange(market, options.startDate, options.endDate));
  const foundByDuration = countRawByDuration(rawMarkets);
  const insideDateRangeByDuration = countRawByDuration(insideMarkets);
  const unsupportedInsideDateRangeByDuration: Record<string, number> = { '5m': insideDateRangeByDuration['5m'] ?? 0, '15m': insideDateRangeByDuration['15m'] ?? 0, unknown: insideDateRangeByDuration['unknown'] ?? 0 };
  const insideDateRangeMarketsByKey = new Map<string, Record<string, unknown>>();
  for (const market of insideMarkets) {
    const key = auditKey(typeof market['conditionId'] === 'string' ? market['conditionId'] : typeof market['condition_id'] === 'string' ? market['condition_id'] : null, typeof market['slug'] === 'string' ? market['slug'] : typeof market['marketSlug'] === 'string' ? market['marketSlug'] : null, extractClobTokenIds(market));
    const slug = typeof market['slug'] === 'string' ? market['slug'] : typeof market['marketSlug'] === 'string' ? market['marketSlug'] : null;
    const accepted = acceptedByKey.get(key) ?? (slug === null ? undefined : acceptedBySlug.get(slug));
    const rejected = rejectedByKey.get(key) ?? rejectedByKey.get(auditKey(typeof market['conditionId'] === 'string' ? market['conditionId'] : typeof market['condition_id'] === 'string' ? market['condition_id'] : null, slug, null)) ?? (slug === null ? undefined : rejectedBySlug.get(slug));
    const outcomes = safeOutcomes(market);
    const prices = parseOutcomePrices(market['outcomePrices'] ?? []);
    const summary = { marketSlug: market['slug'] ?? market['marketSlug'] ?? null, question: market['question'] ?? market['title'] ?? null, detectedMarketDuration: accepted?.marketDuration ?? rejected?.detectedMarketDuration ?? detectMarketDuration(market), endDate: timestampIso(extractTime(market, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime'])), eventStartTime: timestampIso(extractTime(market, ['eventStartTime'])), startTime: timestampIso(extractTime(market, ['startTime', 'gameStartTime'])), startDate: timestampIso(extractTime(market, ['startDate', 'startDateIso'])), rejectionReason: accepted === undefined ? rejected?.rejectionReason ?? null : null, hasTargetPrice: candidateHasTargetPrice(market), hasClobTokenIds: extractClobTokenIds(market).length > 0, winner: determineMarketWinner(market, outcomes, prices), isClosed: typeof market['closed'] === 'boolean' ? market['closed'] : null, rawOutcomePrices: market['outcomePrices'] ?? [] };
    const displayKey = slug === null ? key : `slug:${slug}`;
    const existing = insideDateRangeMarketsByKey.get(displayKey);
    if (existing === undefined || (existing['rejectionReason'] !== null && summary.rejectionReason === null)) insideDateRangeMarketsByKey.set(displayKey, summary);
  }
  const insideDateRangeMarkets = [...insideDateRangeMarketsByKey.values()];
  const acceptedHourlyEnds = new Set(discoveryResult.acceptedMarkets.filter((market) => market.marketDuration === '1h').map((market) => new Date(market.marketEndTimestampMilliseconds).toISOString()));
  const missingHourlyWindows = options.marketDuration === 'all' || options.marketDuration === '1h' ? buildExpectedHourlyWindows(options.startDate, options.endDate).filter((endIso) => !acceptedHourlyEnds.has(endIso)) : [];
  const outsideDateRangeSample = auditRejectedMarkets.filter((market) => market.rejectionReason === 'outside_requested_date_range').slice(0, 20).map((market) => {
    const rawMarket = rawMarkets.find((raw) => (raw['slug'] ?? raw['marketSlug']) === market.marketSlug || raw['conditionId'] === market.conditionId || raw['condition_id'] === market.conditionId) ?? {};
    return { marketSlug: market.marketSlug, question: market.question, detectedMarketDuration: market.detectedMarketDuration, endDate: timestampIso(extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime'])) };
  });
  return { startDate: options.startDate, endDate: options.endDate, requestedMarketDuration: options.marketDuration, discoveryMaxTotalRequests: debug?.discoveryMaxTotalRequests ?? null, rawResponsesFetched: debug?.rawResponsesFetched ?? null, rawCandidates: auditDebug.candidateMarketsFetched, deduplicatedCandidates: auditDebug.deduplicatedCandidateMarkets, candidatesInsideRequestedDateRange: insideMarkets.length, acceptedMarkets: discoveryResult.acceptedMarkets.length, rejectedMarkets: discoveryResult.rejectedMarkets.length, acceptedByDuration: auditDebug.acceptedByDuration, rejectedByReason: auditDebug.rejectedByReason, foundByDuration, insideDateRangeByDuration, unsupportedInsideDateRangeByDuration, insideDateRangeMarkets, outsideDateRangeSample, missingHourlyWindows, stopReason: debug?.stopReason ?? null, searchedExactTitleTermsCount: debug?.searchedExactTitleTermsCount ?? null, searchedExactTitleTermsByDuration: debug?.searchedExactTitleTermsByDuration ?? null, searchedGenericTermsCount: debug?.searchedGenericTermsCount ?? null };
}

function rawMarketInsideRequestedRange(market: Record<string, unknown>, startDate: string, endDate: string): boolean {
  const end = extractTime(market, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
  return end !== null && end >= Date.parse(`${startDate}T00:00:00.000Z`) && end < Date.parse(`${endDate}T00:00:00.000Z`);
}
function countRawByDuration(markets: Record<string, unknown>[]): Record<string, number> { const counts: Record<string, number> = { '1h': 0, '4h': 0, '1d': 0, '15m': 0, '5m': 0, unknown: 0 }; for (const market of markets) { const duration = detectMarketDuration(market) ?? 'unknown'; counts[duration] = (counts[duration] ?? 0) + 1; } return counts; }
function auditKey(conditionId: string | null, slug: string | null, tokenIds: string[] | null): string { if (conditionId) return `condition:${conditionId}`; if (slug) return `slug:${slug}`; if (tokenIds !== null && tokenIds.length > 0) return `tokens:${tokenIds.join('|')}`; return 'unknown'; }
function timestampIso(timestamp: number | null): string | null { return timestamp === null ? null : new Date(timestamp).toISOString(); }
function safeOutcomes(market: Record<string, unknown>): string[] { try { return parseOutcomes(market['outcomes'] ?? market['shortOutcomes'] ?? []); } catch { return []; } }
