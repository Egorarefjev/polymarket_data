import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { calculateDistanceToTarget, calculateSecondsLeft, normalizeTimestampMilliseconds } from '../../src/core/calculations.js';
import { determineMarketWinner, extractTargetPrice, parseOutcomePrices, parseOutcomes } from '../../src/core/parsing.js';
import { validateMarketForAnalysis } from '../../src/core/validation.js';
import { buildMarketSummary } from '../../src/core/summary.js';
import { buildNormalizedPricePointsForMarket, buildNormalizedPricePointsForMarketWithSkipCount, buildPriceHistoryQualityFlags, findLatestBinancePricePointAtOrBeforeTimestamp } from '../../src/core/alignment.js';
import { ChainlinkLocalFilePriceSource, parseChainlinkLocalFilePricePoints } from '../../src/adapters/externalPriceSource.js';
import { FileStorage } from '../../src/adapters/fileStorage.js';
import { CollectorUseCases, type CollectorOptions, rawBinanceRelativeFilePath, rawPriceHistoryRelativeFilePath, acceptedMarketsRelativeFilePath, processedPricePointsDebugRelativeFilePath, shouldDownloadBinanceDuringFullPipeline, determinePrimaryPriceMode, buildStrategyTrainingRows } from '../../src/application/collectorUseCases.js';
import type { NormalizedMarket, NormalizedPricePoint } from '../../src/core/domain.js';

describe('core calculations', () => {
  it('normalizes seconds, milliseconds, and microseconds to milliseconds', () => {
    expect(normalizeTimestampMilliseconds(1_717_200_000)).toBe(1_717_200_000_000);
    expect(normalizeTimestampMilliseconds(1_717_200_000_000)).toBe(1_717_200_000_000);
    expect(normalizeTimestampMilliseconds(1_717_200_000_000_000)).toBe(1_717_200_000_000);
  });

  it('calculates seconds left without negative values', () => {
    expect(calculateSecondsLeft(2_000, 1_000)).toBe(1);
    expect(calculateSecondsLeft(1_000, 2_000)).toBe(0);
  });

  it('calculates USD and basis point distance to target', () => {
    expect(calculateDistanceToTarget(101_000, 100_000)).toEqual({ distanceUsd: 1_000, distanceBasisPoints: 100 });
  });
});

describe('core parsing', () => {
  it('parses outcomes and outcome prices from JSON strings and arrays', () => {
    expect(parseOutcomes('["Up","Down"]')).toEqual(['Up', 'Down']);
    expect(parseOutcomePrices(['0.25', '0.75'])).toEqual([0.25, 0.75]);
  });

  it('extracts target price from explicit metadata before text', () => {
    expect(extractTargetPrice({ targetPrice: '100,250', question: 'BTC Up or Down from $99,000 target?' })).toBe(100_250);
  });

  it('extracts target price from question text defensively', () => {
    expect(extractTargetPrice({ question: 'Bitcoin Up or Down - starting price $104,500?' })).toBe(104_500);
  });

  it('returns null when no target price is present', () => {
    expect(extractTargetPrice({ question: 'Bitcoin Up or Down in the next 5 minutes?' })).toBeNull();
  });

  it('determines winner from final outcome prices', () => {
    expect(determineMarketWinner({}, ['Up', 'Down'], [1, 0])).toBe('up');
    expect(determineMarketWinner({ winner: 'Down' }, ['Up', 'Down'], [0.5, 0.5])).toBe('down');
  });
});

describe('market validation and summary', () => {
  const market: NormalizedMarket = {
    marketSlug: 'btc-updown-5m-example',
    conditionId: 'condition',
    question: 'Bitcoin Up or Down from $100,000?',
    marketStartTimestampMilliseconds: 1_000,
    marketEndTimestampMilliseconds: 301_000,
    upTokenId: 'up-token',
    downTokenId: 'down-token',
    targetPrice: 100_000,
    winner: 'up',
    isResolved: true,
    isClosed: true,
    rawOutcomes: '["Up","Down"]',
    rawOutcomePrices: '["1","0"]',
    dataQualityFlags: [],
  };

  it('accepts complete markets and rejects markets without target', () => {
    expect(validateMarketForAnalysis(market).accepted).toBe(true);
    expect(validateMarketForAnalysis({ ...market, targetPrice: null }).rejectionReason).toBe('target_price_missing');
  });

  it('builds market summary thresholds and trajectory statistics', () => {
    const pricePoints = buildNormalizedPricePointsForMarket({
      market,
      upPriceHistory: [
        { timestampMilliseconds: 101_000, price: 0.7 },
        { timestampMilliseconds: 201_000, price: 0.92 },
      ],
      downPriceHistory: [
        { timestampMilliseconds: 101_000, price: 0.3 },
        { timestampMilliseconds: 201_000, price: 0.08 },
      ],
      primaryExternalPricePoints: [
        { timestampMilliseconds: 101_000, price: 100_500, sourceName: 'chainlink' },
        { timestampMilliseconds: 201_000, price: 101_000, sourceName: 'chainlink' },
      ],
      binanceSecondaryPricePoints: [
        { timestampMilliseconds: 101_000, price: 100_510, sourceName: 'binance' },
        { timestampMilliseconds: 201_000, price: 101_010, sourceName: 'binance' },
      ],
      isBinanceSecondarySignalEnabled: true,
      requestedFidelityMinutes: 1,
    });
    const summary = buildMarketSummary(market, pricePoints);
    expect(summary.maximumUpPrice).toBe(0.92);
    expect(summary.pricePointsCount).toBe(2);
    expect(summary.upPriceOpen).toBe(0.7);
    expect(summary.upPriceClose).toBe(0.92);
    expect(summary.closePrimaryPrice).toBe(101_000);
    expect(summary.firstTimestampUpPriceGreaterThanOrEqual090).toBe(201_000);
    expect(summary.secondsLeftAtFirstUpPriceGreaterThanOrEqual090).toBe(100);
  });
});



const alignmentMarket: NormalizedMarket = {
  marketSlug: 'btc-updown-5m-example',
  conditionId: 'condition',
  question: 'Bitcoin Up or Down from $100,000?',
  marketStartTimestampMilliseconds: 1_000,
  marketEndTimestampMilliseconds: 301_000,
  upTokenId: 'up-token',
  downTokenId: 'down-token',
  targetPrice: 100_000,
  winner: 'up',
  isResolved: true,
  isClosed: true,
  rawOutcomes: '["Up","Down"]',
  rawOutcomePrices: '["1","0"]',
  dataQualityFlags: [],
};
describe('causal as-of price alignment', () => {
  it('chooses the price before the timestamp when one point is before and one is after', () => {
    expect(findLatestBinancePricePointAtOrBeforeTimestamp([
      { timestampMilliseconds: 1_000, price: 100, sourceName: 'binance' },
      { timestampMilliseconds: 3_000, price: 300, sourceName: 'binance' },
    ], 2_000)).toEqual({ timestampMilliseconds: 1_000, price: 100, sourceName: 'binance' });
  });

  it('returns null when only a future price exists', () => {
    expect(findLatestBinancePricePointAtOrBeforeTimestamp([{ timestampMilliseconds: 3_000, price: 300, sourceName: 'binance' }], 2_000)).toBeNull();
  });

  it('chooses the exact timestamp when one exists', () => {
    expect(findLatestBinancePricePointAtOrBeforeTimestamp([
      { timestampMilliseconds: 1_000, price: 100, sourceName: 'binance' },
      { timestampMilliseconds: 2_000, price: 200, sourceName: 'binance' },
    ], 2_000)).toEqual({ timestampMilliseconds: 2_000, price: 200, sourceName: 'binance' });
  });



  it('uses Chainlink causal as-of join and never future Chainlink prices', () => {
    const rows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [
        { timestampMilliseconds: 2_000, price: 0.6 },
        { timestampMilliseconds: 4_000, price: 0.7 },
      ],
      downPriceHistory: [
        { timestampMilliseconds: 2_000, price: 0.4 },
        { timestampMilliseconds: 4_000, price: 0.3 },
      ],
      primaryExternalPricePoints: [
        { timestampMilliseconds: 1_000, price: 99_900, sourceName: 'chainlink' },
        { timestampMilliseconds: 3_000, price: 100_100, sourceName: 'chainlink' },
        { timestampMilliseconds: 5_000, price: 100_500, sourceName: 'chainlink' },
      ],
      isBinanceSecondarySignalEnabled: false,
      requestedFidelityMinutes: 1,
    });
    expect(rows.map((row) => row.chainlinkPrice)).toEqual([99_900, 100_100]);
  });

  it('does not add Binance missing flag when secondary signal is disabled', () => {
    const rows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.6 }],
      downPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.4 }],
      primaryExternalPricePoints: [{ timestampMilliseconds: 1_000, price: 100_100, sourceName: 'chainlink' }],
      isBinanceSecondarySignalEnabled: false,
      requestedFidelityMinutes: 1,
    });
    expect(rows[0]?.binancePrice).toBeNull();
    expect(rows[0]?.dataQualityFlags).not.toContain('binance_secondary_signal_missing');
  });

  it('adds Binance missing flag when secondary signal is enabled and no matching point exists', () => {
    const rows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.6 }],
      downPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.4 }],
      primaryExternalPricePoints: [{ timestampMilliseconds: 1_000, price: 100_100, sourceName: 'chainlink' }],
      isBinanceSecondarySignalEnabled: true,
      requestedFidelityMinutes: 1,
    });
    expect(rows[0]?.dataQualityFlags).toContain('binance_secondary_signal_missing');
  });

  it('adds proxy debug flag to every row in proxy primary mode', () => {
    const rows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.6 }],
      downPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.4 }],
      primaryExternalPricePoints: [{ timestampMilliseconds: 1_000, price: 100_100, sourceName: 'binance' }],
      isBinanceSecondarySignalEnabled: false,
      isProxyPrimaryPriceSourceForDebug: true,
      requestedFidelityMinutes: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.dataQualityFlags.includes('proxy_primary_price_source_not_official'))).toBe(true);
  });

  it('does not use future external prices in normalized rows', () => {
    const rows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.6 }],
      downPriceHistory: [{ timestampMilliseconds: 2_000, price: 0.4 }],
      primaryExternalPricePoints: [{ timestampMilliseconds: 3_000, price: 100_100, sourceName: 'chainlink' }],
      isBinanceSecondarySignalEnabled: true,
      requestedFidelityMinutes: 1,
    });
    expect(rows).toEqual([]);
  });

  it('skips only rows missing a prior primary price and does not add missing-before flag to valid rows', () => {
    const result = buildNormalizedPricePointsForMarketWithSkipCount({
      market: alignmentMarket,
      upPriceHistory: [
        { timestampMilliseconds: 500, price: 0.55 },
        { timestampMilliseconds: 2_000, price: 0.6 },
      ],
      downPriceHistory: [
        { timestampMilliseconds: 500, price: 0.45 },
        { timestampMilliseconds: 2_000, price: 0.4 },
      ],
      primaryExternalPricePoints: [{ timestampMilliseconds: 1_000, price: 100_100, sourceName: 'chainlink' }],
      isBinanceSecondarySignalEnabled: false,
      requestedFidelityMinutes: 1,
    });
    expect(result.skippedRowsMissingPrimaryPriceBeforeTimestamp).toBe(1);
    expect(result.pricePoints).toHaveLength(1);
    expect(result.pricePoints[0]?.timestampMilliseconds).toBe(2_000);
    expect(result.pricePoints[0]?.dataQualityFlags).not.toContain('primary_price_missing_before_timestamp');
    expect(result.pricePoints[0]?.dataQualityFlags).not.toContain('chainlink_price_missing_before_timestamp');
  });
});

describe('future labels and strategy training rows', () => {
  it('preserves full trajectory, computes future labels inside one market, and builds past-only strategy features', () => {
    const marketTwo = { ...alignmentMarket, marketSlug: 'btc-updown-5m-second', winner: 'down' as const };
    const firstMarketRows = buildNormalizedPricePointsForMarket({
      market: alignmentMarket,
      upPriceHistory: [
        { timestampMilliseconds: 2_000, price: 0.4 },
        { timestampMilliseconds: 3_000, price: 0.91 },
        { timestampMilliseconds: 4_000, price: 0.7 },
        { timestampMilliseconds: 5_000, price: 0.95 },
        { timestampMilliseconds: 6_000, price: 0.6 },
      ],
      downPriceHistory: [
        { timestampMilliseconds: 2_000, price: 0.6 },
        { timestampMilliseconds: 3_000, price: 0.09 },
        { timestampMilliseconds: 4_000, price: 0.3 },
        { timestampMilliseconds: 5_000, price: 0.05 },
        { timestampMilliseconds: 6_000, price: 0.4 },
      ],
      primaryExternalPricePoints: [{ timestampMilliseconds: 1_000, price: 100_100, sourceName: 'chainlink' }],
      isBinanceSecondarySignalEnabled: false,
      requestedFidelityMinutes: 1,
    });
    const secondMarketRows = buildNormalizedPricePointsForMarket({
      market: marketTwo,
      upPriceHistory: [{ timestampMilliseconds: 7_000, price: 0.99 }],
      downPriceHistory: [{ timestampMilliseconds: 7_000, price: 0.01 }],
      primaryExternalPricePoints: [{ timestampMilliseconds: 1_000, price: 100_100, sourceName: 'chainlink' }],
      isBinanceSecondarySignalEnabled: false,
      requestedFidelityMinutes: 1,
    });

    expect(firstMarketRows).toHaveLength(5);
    expect(firstMarketRows.map((row) => row.upPrice)).toEqual([0.4, 0.91, 0.7, 0.95, 0.6]);
    expect(firstMarketRows[0]?.futureMaximumUpPrice).toBe(0.95);
    expect(firstMarketRows[0]?.futureSecondsUntilUpPriceGreaterThanOrEqual090).toBe(1);
    expect(firstMarketRows[4]?.futureSecondsUntilUpPriceGreaterThanOrEqual090).toBeNull();
    expect(firstMarketRows[4]?.futureReachesUp090).toBe(false);
    expect(firstMarketRows[4]?.futureMaximumUpPrice).toBe(0.6);
    expect(secondMarketRows[0]?.futureMaximumUpPrice).toBe(0.99);

    const strategyRows = buildStrategyTrainingRows([...firstMarketRows, ...secondMarketRows]);
    expect(strategyRows[0]?.winner).toBe('up');
    expect(strategyRows[0]?.upWinsBinary).toBe(1);
    expect(strategyRows[0]?.upPriceChangePrevious1Point).toBeNull();
    expect(strategyRows[1]?.upPriceChangePrevious1Point).toBeCloseTo(0.51);
    expect(strategyRows[2]?.upPriceChangePrevious2Points).toBeCloseTo(0.3);
    expect(strategyRows[5]?.upPriceChangePrevious1Point).toBeNull();
    expect(strategyRows[0]).toHaveProperty('futureMaximumUpPrice');
    expect(strategyRows[0]).not.toHaveProperty('closePrimaryPrice');
  });
});

describe('price history quality flags', () => {
  it('flags one or two points as too few for five-minute market analysis', () => {
    expect(buildPriceHistoryQualityFlags('up', [{ timestampMilliseconds: 1_000, price: 0.5 }], alignmentMarket, 1)).toContain('price_history_too_few_points_for_five_minute_market');
    expect(buildPriceHistoryQualityFlags('down', [
      { timestampMilliseconds: 1_000, price: 0.5 },
      { timestampMilliseconds: 301_000, price: 0.6 },
    ], alignmentMarket, 1)).toContain('price_history_too_few_points_for_five_minute_market');
  });
});


describe('Chainlink local input parsing', () => {
  it('parses CSV timestamp_milliseconds and price columns', () => {
    expect(parseChainlinkLocalFilePricePoints('timestamp_milliseconds,price\n1717200000000,67500.12\n')).toEqual([
      { timestampMilliseconds: 1_717_200_000_000, price: 67_500.12, sourceName: 'chainlink' },
    ]);
  });

  it('parses JSONL timestampMilliseconds and price fields', () => {
    expect(parseChainlinkLocalFilePricePoints('{"timestampMilliseconds":1717200000000,"price":67500.12}\n')).toEqual([
      { timestampMilliseconds: 1_717_200_000_000, price: 67_500.12, sourceName: 'chainlink' },
    ]);
  });

  it('normalizes seconds, milliseconds, and microseconds', () => {
    const rows = parseChainlinkLocalFilePricePoints([
      '{"observationsTimestamp":1717200000,"benchmarkPrice":67500.12}',
      '{"timestamp_milliseconds":1717200060000,"price":67501.12}',
      '{"timestamp_ms":1717200120000000,"price":67502.12}',
    ].join('\n'));
    expect(rows.map((row) => row.timestampMilliseconds)).toEqual([1_717_200_000_000, 1_717_200_060_000, 1_717_200_120_000]);
  });

  it('rejects invalid or negative price', () => {
    expect(() => parseChainlinkLocalFilePricePoints('timestamp_milliseconds,price\n1717200000000,-1\n')).toThrow('Invalid Chainlink price');
  });

  it('sorts ascending and deduplicates timestamps keeping the last record', () => {
    const rows = parseChainlinkLocalFilePricePoints([
      'timestamp_milliseconds,price',
      '1717200060000,67501',
      '1717200000000,67500',
      '1717200000000,67502',
    ].join('\n'));
    expect(rows).toEqual([
      { timestampMilliseconds: 1_717_200_000_000, price: 67_502, sourceName: 'chainlink' },
      { timestampMilliseconds: 1_717_200_060_000, price: 67_501, sourceName: 'chainlink' },
    ]);
  });
});


describe('full pipeline Binance download decision', () => {
  const baseOptions: CollectorOptions = {
    startDate: '2026-05-01',
    endDate: '2026-05-02',
    symbol: 'BTCUSDT',
    priceFidelityMinutes: 1,
    force: true,
    requestDelayMilliseconds: 0,
    maximumConcurrentRequests: 1,
    binanceMarketType: 'spot',
    binanceDataType: 'aggTrades',
    primaryPriceSource: 'chainlink',
    includeBinanceSecondarySignal: false,
    allowProxyPrimaryPriceSourceForDebug: false,
  };

  function makePipelineUseCases(): CollectorUseCases {
    return new CollectorUseCases(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('shouldDownloadBinanceDuringFullPipeline matches secondary/proxy guardrails', () => {
    expect(shouldDownloadBinanceDuringFullPipeline({ ...baseOptions, includeBinanceSecondarySignal: true })).toBe(true);
    expect(shouldDownloadBinanceDuringFullPipeline({ ...baseOptions, allowProxyPrimaryPriceSourceForDebug: true })).toBe(true);
    expect(shouldDownloadBinanceDuringFullPipeline({ ...baseOptions, allowProxyPrimaryPriceSourceForDebug: true, chainlinkInputFile: './chainlink.jsonl' })).toBe(false);
    expect(shouldDownloadBinanceDuringFullPipeline({ ...baseOptions, includeBinanceSecondarySignal: false, allowProxyPrimaryPriceSourceForDebug: false })).toBe(false);
  });

  it('runFullPipeline downloads Binance in proxy mode without Chainlink when secondary signal is disabled', async () => {
    const useCases = makePipelineUseCases();
    vi.spyOn(useCases, 'discoverMarkets').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'downloadPolymarketPrices').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'downloadPolymarketTrades').mockResolvedValue(undefined);
    const downloadBinanceSpy = vi.spyOn(useCases, 'downloadBinance').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'buildDataset').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'summarizeMarkets').mockResolvedValue(undefined);

    await useCases.runFullPipeline({ ...baseOptions, allowProxyPrimaryPriceSourceForDebug: true, includeBinanceSecondarySignal: false });

    expect(downloadBinanceSpy).toHaveBeenCalledTimes(1);
  });

  it('runFullPipeline does not download Binance when Chainlink input exists and secondary signal is disabled', async () => {
    const useCases = makePipelineUseCases();
    vi.spyOn(useCases, 'discoverMarkets').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'downloadPolymarketPrices').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'downloadPolymarketTrades').mockResolvedValue(undefined);
    const downloadBinanceSpy = vi.spyOn(useCases, 'downloadBinance').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'buildDataset').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'summarizeMarkets').mockResolvedValue(undefined);

    await useCases.runFullPipeline({ ...baseOptions, allowProxyPrimaryPriceSourceForDebug: true, includeBinanceSecondarySignal: false, chainlinkInputFile: './chainlink.jsonl' });

    expect(downloadBinanceSpy).not.toHaveBeenCalled();
  });

  it('runFullPipeline downloads Binance when Chainlink input exists and secondary signal is enabled', async () => {
    const useCases = makePipelineUseCases();
    vi.spyOn(useCases, 'discoverMarkets').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'downloadPolymarketPrices').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'downloadPolymarketTrades').mockResolvedValue(undefined);
    const downloadBinanceSpy = vi.spyOn(useCases, 'downloadBinance').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'buildDataset').mockResolvedValue(undefined);
    vi.spyOn(useCases, 'summarizeMarkets').mockResolvedValue(undefined);

    await useCases.runFullPipeline({ ...baseOptions, includeBinanceSecondarySignal: true, chainlinkInputFile: './chainlink.jsonl' });

    expect(downloadBinanceSpy).toHaveBeenCalledTimes(1);
  });

  it('determinePrimaryPriceMode refuses empty Chainlink fallback and selects proxy only without Chainlink input', () => {
    expect(() => determinePrimaryPriceMode({ ...baseOptions, chainlinkInputFile: './empty.csv', allowProxyPrimaryPriceSourceForDebug: true }, [])).toThrow('Refusing to fallback to Binance proxy');
    expect(determinePrimaryPriceMode({ ...baseOptions, chainlinkInputFile: './valid.csv' }, [{ timestampMilliseconds: 1, price: 100, sourceName: 'chainlink' }]).mode).toBe('official_chainlink');
    expect(determinePrimaryPriceMode({ ...baseOptions, allowProxyPrimaryPriceSourceForDebug: true }, []).mode).toBe('binance_proxy_debug');
    expect(() => determinePrimaryPriceMode({ ...baseOptions, allowProxyPrimaryPriceSourceForDebug: false }, [])).toThrow('Chainlink input is required');
  });
});

describe('dataset build with Chainlink input and proxy guardrails', () => {
  const options: CollectorOptions = {
    startDate: '2026-05-01',
    endDate: '2026-05-02',
    symbol: 'BTCUSDT',
    priceFidelityMinutes: 1,
    force: true,
    requestDelayMilliseconds: 0,
    maximumConcurrentRequests: 1,
    binanceMarketType: 'spot',
    binanceDataType: 'aggTrades',
    primaryPriceSource: 'chainlink',
    includeBinanceSecondarySignal: false,
    allowProxyPrimaryPriceSourceForDebug: false,
  };

  function makeMemoryLogger(): { logger: { info: (payload: Record<string, unknown>, message: string) => void; warn: () => void; error: () => void; debug: () => void }; infoEntries: Array<{ payload: Record<string, unknown>; message: string }> } {
    const infoEntries: Array<{ payload: Record<string, unknown>; message: string }> = [];
    return {
      infoEntries,
      logger: {
        info: (payload: Record<string, unknown>, message: string) => infoEntries.push({ payload, message }),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    };
  }

  async function makeUseCases(dataDirectoryPath: string, chainlinkInputFile?: string): Promise<{ useCases: CollectorUseCases; fileStorage: FileStorage; infoEntries: Array<{ payload: Record<string, unknown>; message: string }> }> {
    const fileStorage = new FileStorage(dataDirectoryPath);
    await fileStorage.ensureDataDirectories();
    const { logger, infoEntries } = makeMemoryLogger();
    return {
      fileStorage,
      infoEntries,
      useCases: new CollectorUseCases(
        fileStorage,
        { writeRows: async () => undefined } as never,
        {} as never,
        {} as never,
        {} as never,
        logger as never,
        chainlinkInputFile === undefined ? undefined : new ChainlinkLocalFilePriceSource(chainlinkInputFile),
      ),
    };
  }

  async function seedMarket(fileStorage: FileStorage, seededOptions: CollectorOptions): Promise<void> {
    await fileStorage.writeJsonLines(acceptedMarketsRelativeFilePath(seededOptions), [alignmentMarket], true);
    await fileStorage.writeJson(rawPriceHistoryRelativeFilePath(seededOptions, alignmentMarket.marketSlug, 'up'), [{ timestampMilliseconds: 2_000, price: 0.6 }], true);
    await fileStorage.writeJson(rawPriceHistoryRelativeFilePath(seededOptions, alignmentMarket.marketSlug, 'down'), [{ timestampMilliseconds: 2_000, price: 0.4 }], true);
  }

  it('creates rows when Chainlink input exists', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'pm-chainlink-'));
    try {
      const chainlinkPath = join(directoryPath, 'chainlink.jsonl');
      await writeFile(chainlinkPath, '{"timestampMilliseconds":1,"price":100100}\n', 'utf8');
      const { useCases, fileStorage } = await makeUseCases(directoryPath, chainlinkPath);
      const seededOptions = { ...options, chainlinkInputFile: chainlinkPath };
      await seedMarket(fileStorage, seededOptions);
      await useCases.buildDataset(seededOptions);
      const rows = JSON.parse(await readFile(fileStorage.resolve(processedPricePointsDebugRelativeFilePath(seededOptions)), 'utf8')) as NormalizedPricePoint[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.chainlinkPrice).toBe(100_100);
      expect(rows[0]?.dataQualityFlags).not.toContain('chainlink_data_unavailable');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('empty and header-only Chainlink input files are fatal and do not fallback to proxy', async () => {
    for (const fileContent of ['', 'timestamp_milliseconds,price\n']) {
      const directoryPath = await mkdtemp(join(tmpdir(), 'pm-empty-chainlink-'));
      try {
        const chainlinkPath = join(directoryPath, 'chainlink.csv');
        await writeFile(chainlinkPath, fileContent, 'utf8');
        const { useCases, fileStorage } = await makeUseCases(directoryPath, chainlinkPath);
        const seededOptions = { ...options, chainlinkInputFile: chainlinkPath, allowProxyPrimaryPriceSourceForDebug: true };
        await seedMarket(fileStorage, seededOptions);
        await fileStorage.writeJson(rawBinanceRelativeFilePath(seededOptions, '2026-05-01'), [{ timestampMilliseconds: 1_000, btcPrice: 100_100 }], true);
        await expect(useCases.buildDataset(seededOptions)).rejects.toThrow('Refusing to fallback to Binance proxy');
      } finally {
        await rm(directoryPath, { recursive: true, force: true });
      }
    }
  });

  it('throws clear error when Chainlink input is missing and proxy debug is disabled', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'pm-no-chainlink-'));
    try {
      const { useCases, fileStorage } = await makeUseCases(directoryPath);
      await seedMarket(fileStorage, options);
      await expect(useCases.buildDataset(options)).rejects.toThrow('Chainlink input is required for official dataset build');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('proxy debug mode creates rows with non-official proxy flag', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'pm-proxy-'));
    try {
      const { useCases, fileStorage } = await makeUseCases(directoryPath);
      const proxyOptions = { ...options, allowProxyPrimaryPriceSourceForDebug: true };
      await seedMarket(fileStorage, proxyOptions);
      await fileStorage.writeJson(rawBinanceRelativeFilePath(proxyOptions, '2026-05-01'), [{ timestampMilliseconds: 1_000, btcPrice: 100_100 }], true);
      await useCases.buildDataset(proxyOptions);
      const rows = JSON.parse(await readFile(fileStorage.resolve(processedPricePointsDebugRelativeFilePath(proxyOptions)), 'utf8')) as NormalizedPricePoint[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.primaryPriceSourceName).toBe('binance_proxy');
      expect(rows[0]?.primaryPrice).toBe(100_100);
      expect(rows[0]?.chainlinkPrice).toBeNull();
      expect(rows.every((row) => row.dataQualityFlags.includes('proxy_primary_price_source_not_official'))).toBe(true);
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });


  it('proxy debug mode without raw Binance files throws clear proxy-data-required error', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'pm-proxy-missing-'));
    try {
      const { useCases, fileStorage } = await makeUseCases(directoryPath);
      const proxyOptions = { ...options, allowProxyPrimaryPriceSourceForDebug: true };
      await seedMarket(fileStorage, proxyOptions);
      await expect(useCases.buildDataset(proxyOptions)).rejects.toThrow('Binance proxy primary data is required');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('official Chainlink mode creates rows without proxy and Binance missing flags when Binance secondary is disabled', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'pm-official-flags-'));
    try {
      const chainlinkPath = join(directoryPath, 'chainlink.jsonl');
      await writeFile(chainlinkPath, '{"timestampMilliseconds":1,"price":100100}\n', 'utf8');
      const { useCases, fileStorage } = await makeUseCases(directoryPath, chainlinkPath);
      const seededOptions = { ...options, chainlinkInputFile: chainlinkPath, includeBinanceSecondarySignal: false };
      await seedMarket(fileStorage, seededOptions);
      await useCases.buildDataset(seededOptions);
      const rows = JSON.parse(await readFile(fileStorage.resolve(processedPricePointsDebugRelativeFilePath(seededOptions)), 'utf8')) as NormalizedPricePoint[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.dataQualityFlags).not.toContain('proxy_primary_price_source_not_official');
      expect(rows[0]?.dataQualityFlags).not.toContain('binance_secondary_signal_missing');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it('counts skipped rows missing a prior primary price without contaminating valid rows', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'pm-skipped-primary-'));
    try {
      const chainlinkPath = join(directoryPath, 'chainlink.jsonl');
      await writeFile(chainlinkPath, '{"timestampMilliseconds":1,"price":100100}\n', 'utf8');
      const { useCases, fileStorage, infoEntries } = await makeUseCases(directoryPath, chainlinkPath);
      const seededOptions = { ...options, chainlinkInputFile: chainlinkPath };
      await fileStorage.writeJsonLines(acceptedMarketsRelativeFilePath(seededOptions), [alignmentMarket], true);
      await fileStorage.writeJson(rawPriceHistoryRelativeFilePath(seededOptions, alignmentMarket.marketSlug, 'up'), [
        { timestampMilliseconds: 500, price: 0.55 },
        { timestampMilliseconds: 2_000, price: 0.6 },
      ], true);
      await fileStorage.writeJson(rawPriceHistoryRelativeFilePath(seededOptions, alignmentMarket.marketSlug, 'down'), [
        { timestampMilliseconds: 500, price: 0.45 },
        { timestampMilliseconds: 2_000, price: 0.4 },
      ], true);
      await useCases.buildDataset(seededOptions);
      const rows = JSON.parse(await readFile(fileStorage.resolve(processedPricePointsDebugRelativeFilePath(seededOptions)), 'utf8')) as NormalizedPricePoint[];
      expect(rows.map((row) => row.timestampMilliseconds)).toEqual([2_000]);
      expect(rows[0]?.dataQualityFlags).not.toContain('primary_price_missing_before_timestamp');
      expect(rows[0]?.dataQualityFlags).not.toContain('chainlink_price_missing_before_timestamp');
      const buildLog = infoEntries.find((entry) => entry.message === 'Dataset build completed');
      expect(buildLog?.payload['skippedRowsMissingPrimaryPriceBeforeTimestamp']).toBe(1);
      expect(buildLog?.payload).not.toHaveProperty('missingChainlinkBeforeTimestampRows');
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });
});
