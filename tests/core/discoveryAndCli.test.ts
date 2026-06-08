import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PolymarketGammaApiAdapter } from '../../src/adapters/polymarketGammaApi.js';
import { PolymarketClobApiAdapter } from '../../src/adapters/polymarketClobApi.js';
import { detectMarketDuration, findTokenIdForOutcome, hasExplicitUpDownOutcomes, isBitcoinUpDownMarket, isRequestedMarketDuration } from '../../src/adapters/polymarketGammaApi.js';
import { processedMarketSummaryRelativeFilePath, processedMarketsRelativeFilePath, processedPricePointsRelativeFilePath, processedStrategyTrainingRowsRelativeFilePath } from '../../src/application/collectorUseCases.js';
import { marketSummaryParquetSchema, marketsParquetSchema, pricePointsParquetSchema, rejectedMarketsParquetSchema, strategyTrainingRowsParquetSchema } from '../../src/application/schemas.js';
import { parseOptions } from '../../src/cli/collector.js';

class MockHttpClient {
  public urls: URL[] = [];
  public constructor(private readonly responses: unknown[]) {}

  public async getJson<T>(url: URL): Promise<T> {
    this.urls.push(url);
    return (this.responses.shift() ?? []) as T;
  }
}

function gammaMarket(id: number): Record<string, unknown> {
  return {
    slug: `bitcoin-up-down-hourly-${id}`,
    question: `Bitcoin Up or Down Hourly ${id}` ,
    startDate: '2026-05-01T00:00:00.000Z',
    endDate: '2026-05-01T01:00:00.000Z',
  };
}

describe('Gamma discovery pagination and filters', () => {
  it('passes server-side end_date_min/end_date_max filters to Gamma API', async () => {
    const httpClient = new MockHttpClient([[gammaMarket(1)]]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    await adapter.discoverBitcoinUpDownFiveMinuteMarkets('2026-05-01', '2026-05-02');
    const url = httpClient.urls[0];
    expect(url?.searchParams.get('closed')).toBe('true');
    expect(url?.searchParams.get('order')).toBe('endDate');
    expect(url?.searchParams.get('ascending')).toBe('true');
    expect(url?.searchParams.get('end_date_min')).toBe('2026-05-01T00:00:00.000Z');
    expect(url?.searchParams.get('end_date_max')).toBe('2026-05-02T00:00:00.000Z');
  });

  it('does not stop at the old 10,000 offset cap', async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => gammaMarket(index));
    const responses = Array.from({ length: 22 }, () => fullPage).concat([[gammaMarket(11_000)]]);
    const httpClient = new MockHttpClient(responses);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownFiveMinuteMarkets('2026-05-01', '2026-05-02');
    expect(Number(httpClient.urls.at(-1)?.searchParams.get('offset'))).toBeGreaterThan(10_000);
    expect(markets.length).toBeGreaterThan(10_000);
  });
});

describe('CLOB fidelity units', () => {
  it('passes fidelity minutes unchanged to CLOB', async () => {
    const httpClient = new MockHttpClient([{ history: [] }]);
    const adapter = new PolymarketClobApiAdapter(httpClient as never, 'https://clob.example.test');
    await adapter.downloadPricesHistory({ tokenId: 'token', startTimestampMilliseconds: 1_000, endTimestampMilliseconds: 2_000, fidelityMinutes: 7 });
    expect(httpClient.urls[0]?.searchParams.get('fidelity')).toBe('7');
  });
});

describe('collector CLI validation', () => {
  it('accepts one-minute price fidelity', () => {
    const result = spawnSync('npx', ['tsx', 'src/cli/collector.ts', 'discover', '--price-fidelity-minutes', '1', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });

  it('rejects price fidelity below one minute', () => {
    const result = spawnSync('npx', ['tsx', 'src/cli/collector.ts', 'discover', '--start-date', '2026-05-01', '--end-date', '2026-05-02', '--price-fidelity-minutes', '0'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('--price-fidelity-minutes must be a number greater than or equal to 1');
  });

  it('rejects removed price-fidelity-seconds alias as an unknown option', () => {
    const result = spawnSync('npx', ['tsx', 'src/cli/collector.ts', 'discover', '--start-date', '2026-05-01', '--end-date', '2026-05-02', '--price-fidelity-seconds', '5'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("unknown option '--price-fidelity-seconds'");
  });
});


describe('README proxy examples', () => {
  it('documents short proxy commands and automatic Binance download behavior', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('npm run collect:proxy:1h -- --date 2026-05-01');
    expect(readme).toContain('npm run collect:proxy:all -- --date 2026-05-01');
    expect(readme).toContain('npm run collector -- all --date 2026-05-01 --allow-proxy-primary-price-source-for-debug true');
    expect(readme).toContain('downloads the required raw Binance files automatically');
  });
});


describe('market duration discovery filters', () => {
  function rawMarket(startDate: string, endDate: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      slug: 'bitcoin-up-or-down-hourly',
      question: 'Bitcoin Up or Down - target price $100,000',
      startDate,
      endDate,
      outcomes: ['Up', 'Down'],
      outcomePrices: ['0.5', '0.5'],
      clobTokenIds: ['up-token', 'down-token'],
      ...overrides,
    };
  }

  it('detects 1h, 4h, and 1d markets by timestamps', () => {
    expect(detectMarketDuration(rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T01:00:00.000Z', { slug: 'btc-up-down-unknown' }))).toBe('1h');
    expect(detectMarketDuration(rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T04:00:00.000Z', { slug: 'btc-up-down-unknown' }))).toBe('4h');
    expect(detectMarketDuration(rawMarket('2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z', { slug: 'btc-up-down-unknown' }))).toBe('1d');
  });

  it('accepts explicit Bitcoin Up/Down product phrases', () => {
    expect(isBitcoinUpDownMarket({ slug: 'btc-updown-1h' })).toBe(true);
    expect(isBitcoinUpDownMarket({ title: 'BTC Up/Down Hourly' })).toBe(true);
    expect(isBitcoinUpDownMarket({ question: 'Bitcoin Up or Down - target price $100,000' })).toBe(true);
    expect(isBitcoinUpDownMarket({ slug: 'bitcoin-up-or-down-daily' })).toBe(true);
    expect(isBitcoinUpDownMarket({ slug: 'btc-up-down-1h' })).toBe(true);
    expect(isBitcoinUpDownMarket({ title: 'BTC Up Down Hourly' })).toBe(true);
    expect(isBitcoinUpDownMarket({ slug: 'bitcoin-updown-1h' })).toBe(true);
  });

  it('rejects standalone up/down Bitcoin wording and non-BTC Up/Down markets', () => {
    expect(isBitcoinUpDownMarket({ question: 'Will Bitcoin go up to $100,000 today?' })).toBe(false);
    expect(isBitcoinUpDownMarket({ question: 'Will BTC go down below $90,000?' })).toBe(false);
    expect(isBitcoinUpDownMarket({ question: 'Will Bitcoin be above $100,000?' })).toBe(false);
    expect(isBitcoinUpDownMarket({ question: 'Will BTC hit $120k?' })).toBe(false);
    expect(isBitcoinUpDownMarket({ question: 'Bitcoin higher than $100,000?' })).toBe(false);
    expect(isBitcoinUpDownMarket({ question: 'Will Bitcoin reach $100,000 today?' })).toBe(false);
    expect(isBitcoinUpDownMarket({ title: 'ETH Up/Down hourly' })).toBe(false);
  });

  it('maps token ids only from explicit Up/Down outcomes without Yes/No fallback', () => {
    expect(findTokenIdForOutcome(['Up', 'Down'], ['up-token', 'down-token'], 'up')).toBe('up-token');
    expect(findTokenIdForOutcome(['Up', 'Down'], ['up-token', 'down-token'], 'down')).toBe('down-token');
    expect(findTokenIdForOutcome(['DOWN', 'UP'], ['down-token', 'up-token'], 'up')).toBe('up-token');
    expect(findTokenIdForOutcome(['DOWN', 'UP'], ['down-token', 'up-token'], 'down')).toBe('down-token');
    expect(findTokenIdForOutcome(['Yes', 'No'], ['yes-token', 'no-token'], 'up')).toBeNull();
    expect(findTokenIdForOutcome(['Yes', 'No'], ['yes-token', 'no-token'], 'down')).toBeNull();
    expect(findTokenIdForOutcome(['Above', 'Below'], ['above-token', 'below-token'], 'up')).toBeNull();
    expect(findTokenIdForOutcome(['Above', 'Below'], ['above-token', 'below-token'], 'down')).toBeNull();
  });

  it('validates only explicit Up/Down outcome pairs', () => {
    expect(hasExplicitUpDownOutcomes(['Up', 'Down'])).toBe(true);
    expect(hasExplicitUpDownOutcomes(['UP', 'DOWN'])).toBe(true);
    expect(hasExplicitUpDownOutcomes(['Bitcoin Up', 'Bitcoin Down'])).toBe(true);
    expect(hasExplicitUpDownOutcomes(['Yes', 'No'])).toBe(false);
    expect(hasExplicitUpDownOutcomes(['Above', 'Below'])).toBe(false);
    expect(hasExplicitUpDownOutcomes(['Higher', 'Lower'])).toBe(false);
    expect(hasExplicitUpDownOutcomes(['Will', "Won't"])).toBe(false);
  });

  it('filters by requested duration and lets all accept supported durations', () => {
    expect(isRequestedMarketDuration('1h', '1h')).toBe(true);
    expect(isRequestedMarketDuration('4h', '1h')).toBe(false);
    expect(isRequestedMarketDuration('1h', 'all')).toBe(true);
    expect(isRequestedMarketDuration('4h', 'all')).toBe(true);
    expect(isRequestedMarketDuration('1d', 'all')).toBe(true);
  });

  it('parses accepted duration markets and rejects unknown, unsupported, and non-BTC markets with reasons', () => {
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([]) as never, 'https://example.test');
    const oneHour = rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T01:00:00.000Z');
    const fiveMinute = rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T00:05:00.000Z', { slug: 'bitcoin-up-down-5m', question: 'Bitcoin Up or Down 5 minute - target price $100,000' });
    const unknown = { ...oneHour, slug: 'bitcoin-up-down-unknown', startDate: undefined, endDate: undefined, question: 'Bitcoin Up or Down - target price $100,000' };
    const eth = { ...oneHour, slug: 'eth-up-down-hourly', question: 'Ethereum Up or Down - target price $2,000' };
    const result = adapter.parseMarkets([oneHour, fiveMinute, unknown, eth], '/tmp/raw.json', '1h');
    expect(result.acceptedMarkets).toHaveLength(1);
    expect(result.acceptedMarkets[0]?.marketDuration).toBe('1h');
    expect(result.rejectedMarkets.map((market) => market.rejectionReason)).toEqual(['unsupported_duration', 'unknown_duration', 'not_bitcoin_up_down']);
    expect(result.rejectedMarkets[0]?.detectedMarketDuration).toBeNull();
  });

  it('rejects supported Bitcoin Yes/No markets without explicit Up/Down product phrases', () => {
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([]) as never, 'https://example.test');
    const result = adapter.parseMarkets([
      {
        slug: 'will-bitcoin-go-up-to-100000-today',
        question: 'Will Bitcoin go up to $100,000 today?',
        startDate: '2026-05-01T00:00:00.000Z',
        endDate: '2026-05-01T01:00:00.000Z',
        outcomes: ['Yes', 'No'],
        clobTokenIds: ['yes-token', 'no-token'],
        targetPrice: '100000',
      },
    ], '/tmp/raw.json', '1h');

    expect(result.acceptedMarkets).toHaveLength(0);
    expect(result.rejectedMarkets).toHaveLength(1);
    expect(result.rejectedMarkets[0]?.rejectionReason).toBe('not_explicit_up_down_product');
  });

  it('rejects explicit product markets with non-Up/Down outcomes before token mapping', () => {
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([]) as never, 'https://example.test');
    const result = adapter.parseMarkets([
      rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T01:00:00.000Z', {
        slug: 'bitcoin-updown-1h-yes-no',
        question: 'Bitcoin Up/Down Hourly - target price $100,000',
        outcomes: ['Yes', 'No'],
        clobTokenIds: ['yes-token', 'no-token'],
      }),
    ], '/tmp/raw.json', '1h');

    expect(result.acceptedMarkets).toHaveLength(0);
    expect(result.rejectedMarkets[0]?.rejectionReason).toBe('non_up_down_outcomes');
    expect(findTokenIdForOutcome(['Yes', 'No'], ['yes-token', 'no-token'], 'up')).toBeNull();
    expect(findTokenIdForOutcome(['Yes', 'No'], ['yes-token', 'no-token'], 'down')).toBeNull();
  });

  it('rejects explicit product markets with Up/Down outcomes but missing token ids', () => {
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([]) as never, 'https://example.test');
    const result = adapter.parseMarkets([
      rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T01:00:00.000Z', {
        slug: 'bitcoin-updown-1h-missing-tokens',
        clobTokenIds: [],
      }),
    ], '/tmp/raw.json', '1h');

    expect(result.acceptedMarkets).toHaveLength(0);
    expect(result.rejectedMarkets[0]?.rejectionReason).toBe('token_ids_missing');
  });

  it('rejects a supported market outside the requested duration as unsupported_duration', () => {
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([]) as never, 'https://example.test');
    const result = adapter.parseMarkets([rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T04:00:00.000Z')], '/tmp/raw.json', '1h');
    expect(result.acceptedMarkets).toHaveLength(0);
    expect(result.rejectedMarkets[0]?.rejectionReason).toBe('unsupported_duration');
    expect(result.rejectedMarkets[0]?.detectedMarketDuration).toBe('4h');
  });
});

describe('collector CLI date and duration options', () => {
  const defaults = {
    symbol: 'BTCUSDT',
    priceFidelityMinutes: '1',
    marketDuration: '1h',
    force: false,
    requestDelayMilliseconds: '200',
    maximumConcurrentRequests: '4',
    binanceMarketType: 'spot',
    binanceDataType: 'klines',
    primaryPriceSource: 'chainlink',
    includeBinanceSecondarySignal: 'false',
    allowProxyPrimaryPriceSourceForDebug: 'false',
    writeDebugJson: 'false',
  };

  it('--date converts to inclusive startDate and exclusive endDate + 1 day', () => {
    const options = parseOptions({ ...defaults, date: '2026-05-01' });
    expect(options.startDate).toBe('2026-05-01');
    expect(options.endDate).toBe('2026-05-02');
  });

  it('--date cannot be combined with --start-date or --end-date', () => {
    expect(() => parseOptions({ ...defaults, date: '2026-05-01', startDate: '2026-05-01' })).toThrow('--date cannot be combined');
    expect(() => parseOptions({ ...defaults, date: '2026-05-01', endDate: '2026-05-02' })).toThrow('--date cannot be combined');
  });

  it('defaults marketDuration to 1h and accepts supported durations', () => {
    expect(parseOptions({ ...defaults, date: '2026-05-01' }).marketDuration).toBe('1h');
    expect(parseOptions({ ...defaults, date: '2026-05-01', marketDuration: '4h' }).marketDuration).toBe('4h');
    expect(parseOptions({ ...defaults, date: '2026-05-01', marketDuration: '1d' }).marketDuration).toBe('1d');
    expect(parseOptions({ ...defaults, date: '2026-05-01', marketDuration: 'all' }).marketDuration).toBe('all');
  });

  it('rejects unsupported market duration', () => {
    expect(() => parseOptions({ ...defaults, date: '2026-05-01', marketDuration: '5m' })).toThrow('--market-duration must be one of');
  });
});

describe('output schemas, filenames, and scripts', () => {
  it('include market duration columns in core output schemas and rejected duration column', () => {
    expect(marketsParquetSchema).toHaveProperty('market_duration');
    expect(pricePointsParquetSchema).toHaveProperty('market_duration');
    expect(marketSummaryParquetSchema).toHaveProperty('market_duration');
    expect(strategyTrainingRowsParquetSchema).toHaveProperty('market_duration');
    expect(rejectedMarketsParquetSchema).toHaveProperty('detected_market_duration');
  });

  it('includes requested duration in processed filenames', () => {
    const options = { startDate: '2026-05-01', endDate: '2026-05-02', marketDuration: '1h' as const };
    expect(processedMarketsRelativeFilePath(options)).toBe('processed/markets_1h_2026-05-01_2026-05-02.parquet');
    expect(processedPricePointsRelativeFilePath(options)).toBe('processed/price_points_1h_2026-05-01_2026-05-02.parquet');
    expect(processedMarketSummaryRelativeFilePath(options)).toBe('processed/market_summary_1h_2026-05-01_2026-05-02.parquet');
    expect(processedStrategyTrainingRowsRelativeFilePath({ ...options, marketDuration: 'all' })).toBe('processed/strategy_training_rows_all_2026-05-01_2026-05-02.parquet');
  });

  it('defines short proxy and official collection scripts for all requested durations', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
    for (const scriptName of ['collect:proxy:1h', 'collect:proxy:4h', 'collect:proxy:1d', 'collect:proxy:all', 'collect:official:1h', 'collect:official:4h', 'collect:official:1d', 'collect:official:all']) {
      expect(packageJson.scripts).toHaveProperty(scriptName);
    }
  });
});
