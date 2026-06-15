import { runNpmCommand } from '../helpers/runNpmCommand.js';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { PolymarketGammaApiAdapter } from '../../src/adapters/polymarketGammaApi.js';
import { PolymarketClobApiAdapter } from '../../src/adapters/polymarketClobApi.js';
import { detectMarketDuration, durationSpecificBitcoinUpDownSearchTerms, findTokenIdForOutcome, hasExplicitUpDownOutcomes, isBitcoinUpDownMarket, isRequestedMarketDuration } from '../../src/adapters/polymarketGammaApi.js';
import { processedMarketSummaryRelativeFilePath, processedMarketsRelativeFilePath, processedPricePointsRelativeFilePath, processedStrategyTrainingRowsRelativeFilePath } from '../../src/application/collectorUseCases.js';
import { marketSummaryParquetSchema, marketsParquetSchema, pricePointsParquetSchema, rejectedMarketsParquetSchema, strategyTrainingRowsParquetSchema } from '../../src/application/schemas.js';
import { parseOptions } from '../../src/cli/createCollectorProgram.js';

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
  it('generates duration-specific BTC Up/Down query terms without 15m terms', () => {
    expect(durationSpecificBitcoinUpDownSearchTerms('1h')).toEqual(expect.arrayContaining(['btc updown 1h', 'bitcoin up or down hourly', 'btc-updown-1h']));
    expect(durationSpecificBitcoinUpDownSearchTerms('4h')).toEqual(expect.arrayContaining(['btc updown 4h', 'bitcoin up or down four hour', 'bitcoin-updown-4h']));
    expect(durationSpecificBitcoinUpDownSearchTerms('1d')).toEqual(expect.arrayContaining(['btc updown daily', 'bitcoin up down 1d', 'bitcoin-updown-daily']));
    const allTerms = durationSpecificBitcoinUpDownSearchTerms('all');
    expect(allTerms).toEqual(expect.arrayContaining(['btc updown 1h', 'btc updown 4h', 'btc updown daily']));
    expect(allTerms.some((term) => /15m|15\s*min|fifteen/u.test(term))).toBe(false);
  });

  it('parses public-search, events, and series responses and deduplicates candidates by slug', async () => {
    const market = gammaMarket(7);
    const httpClient = new MockHttpClient([{ markets: [market] }, { events: [{ slug: 'event-7', markets: [market] }] }, { series: [{ slug: 'series-7', events: [{ markets: [market] }] }] }]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h' });
    expect(markets).toEqual([market]);
    expect(adapter.getLastDiscoveryDebug()?.queries.slice(0, 3).map((query) => query.source)).toEqual(['public-search', 'public-search', 'events']);
    expect(adapter.getLastDiscoveryDebug()?.queries.some((query) => query.candidateMarketsExtracted === 1)).toBe(true);
  });
  it('passes server-side BTC Up/Down query and end-date filters to Gamma API', async () => {
    const httpClient = new MockHttpClient([[gammaMarket(1)]]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    await adapter.discoverBitcoinUpDownFiveMinuteMarkets('2026-05-01', '2026-05-02');
    const url = httpClient.urls[0];
    expect(url?.pathname).toBe('/public-search');
    expect(url?.searchParams.get('q')).toBe('btc updown 1h');
    const eventsUrl = httpClient.urls.find((candidateUrl) => candidateUrl.pathname === '/events');
    expect(eventsUrl?.searchParams.get('closed')).toBe('true');
    expect(eventsUrl?.searchParams.get('order')).toBe('endDate');
    expect(eventsUrl?.searchParams.get('ascending')).toBe('true');
    expect(eventsUrl?.searchParams.get('end_date_min')).toBe('2026-05-01T00:00:00.000Z');
    expect(eventsUrl?.searchParams.get('end_date_max')).toBe('2026-05-02T00:00:00.000Z');
  });

  it('does not use broad keyset/date scan by default and filters unrelated search results out of candidates', async () => {
    const snowfallMarket = { slug: 'chicago-first-snowfall', question: 'Will Chicago record the first snowfall?', startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-01T01:00:00.000Z' };
    const btcMarket = gammaMarket(1);
    const httpClient = new MockHttpClient([[snowfallMarket, btcMarket]]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownFiveMinuteMarkets('2026-05-01', '2026-05-02');
    expect(markets).toEqual([btcMarket]);
    expect(httpClient.urls.some((url) => url.pathname === '/public-search')).toBe(true);
    expect(httpClient.urls.some((url) => url.pathname === '/events')).toBe(true);
    expect(httpClient.urls.some((url) => url.pathname === '/series')).toBe(true);
    expect(httpClient.urls.some((url) => url.pathname === '/markets')).toBe(true);
  });





  it('locally rejects discovered candidates outside requested end-date range and with missing end dates', async () => {
    const inside = { ...gammaMarket(10), outcomes: ['Up', 'Down'], clobTokenIds: ['up', 'down'], targetPrice: '100000' };
    const outside = { ...inside, slug: 'bitcoin-up-down-june', endDate: '2026-06-14T12:00:00.000Z' };
    const missingEnd = { ...inside, slug: 'bitcoin-up-down-missing-end', endDate: undefined };
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([[outside, missingEnd, inside]]) as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxTotalRequests: 1 });
    const result = adapter.parseMarkets(markets, '/tmp/raw.json', '1h');
    expect(result.acceptedMarkets.map((market) => market.marketSlug)).toEqual(['bitcoin-up-down-hourly-10']);
    expect(result.rejectedMarkets.map((market) => market.rejectionReason)).toEqual(['outside_requested_date_range', 'end_date_missing']);
  });

  it('hydrates shallow search candidates by slug before validation', async () => {
    const shallow = { slug: 'bitcoin-up-or-down-april-30-2026-7pm-et', question: 'Bitcoin Up or Down - April 30, 7PM ET', startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-01T01:00:00.000Z' };
    const hydrated = { ...shallow, description: 'The starting price of Bitcoin is $100,000.', outcomes: ['Up', 'Down'], outcomePrices: ['1', '0'], clobTokenIds: ['up-token', 'down-token'], conditionId: '0xabc' };
    const httpClient = new MockHttpClient([[shallow], hydrated]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: 'all', discoveryMaxTotalRequests: 1 });
    const result = adapter.parseMarkets(markets, '/tmp/raw.json', 'all');
    expect(result.acceptedMarkets).toHaveLength(1);
    expect(result.acceptedMarkets[0]).toMatchObject({ marketSlug: shallow.slug, conditionId: '0xabc', targetPrice: 100000, upTokenId: 'up-token', downTokenId: 'down-token' });
    const debugCandidate = adapter.getLastDiscoveryDebug()?.queries[0]?.extractedCandidates[0];
    expect(debugCandidate).toMatchObject({ hydrationAttempted: true, hydrationSucceeded: true, hasTargetPriceBeforeHydration: false, hasTargetPriceAfterHydration: true });
  });

  it('prefers rich duplicates over shallow/template candidates and rejects standalone templates', async () => {
    const template = { slug: 'btc-up-or-down-hourly', title: 'BTC Up or Down Hourly', startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-01T01:00:00.000Z' };
    const shallow = { slug: 'bitcoin-up-down-hourly-77', question: 'Bitcoin Up or Down - target price $100,000', startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-01T01:00:00.000Z' };
    const rich = { ...shallow, conditionId: '0xrich', outcomes: ['Up', 'Down'], clobTokenIds: ['up-rich', 'down-rich'] };
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([[template, rich, shallow]]) as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxTotalRequests: 1 });
    const result = adapter.parseMarkets(markets, '/tmp/raw.json', '1h');
    expect(result.acceptedMarkets).toHaveLength(1);
    expect(result.acceptedMarkets[0]).toMatchObject({ conditionId: '0xrich', upTokenId: 'up-rich' });
    expect(result.rejectedMarkets[0]?.rejectionReason).toBe('non_terminal_market_template');
  });

  it('extracts nested real markets from event/template containers and excludes valid markets outside requested dates', async () => {
    const nested = { ...gammaMarket(88), outcomes: ['Up', 'Down'], clobTokenIds: ['up', 'down'], description: 'BTC price at the start of the market: $100,000' };
    const june = { ...nested, slug: 'btc-updown-4h-1781438400', question: 'Bitcoin Up or Down - June 14, 8:00AM-12:00PM ET', startDate: '2026-06-14T12:00:00.000Z', endDate: '2026-06-14T16:00:00.000Z' };
    const response = { series: [{ slug: 'btc-up-or-down-hourly', title: 'BTC Up or Down Hourly', markets: [nested, june] }] };
    const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([response]) as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: 'all', discoveryMaxTotalRequests: 1 });
    const result = adapter.parseMarkets(markets, '/tmp/raw.json', 'all');
    expect(result.acceptedMarkets.map((market) => market.marketSlug)).toEqual(['bitcoin-up-down-hourly-88']);
    expect(result.rejectedMarkets.map((market) => market.rejectionReason)).toContain('outside_requested_date_range');
  });

  it('respects max pages per source/query', async () => {
    const httpClient = new MockHttpClient(Array.from({ length: 20 }, () => []));
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxPagesPerQuery: 1 });
    const counts = new Map<string, number>();
    for (const url of httpClient.urls) {
      const key = `${url.pathname}:${url.searchParams.get('q')}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()].every((count) => count <= 1)).toBe(true);
  });

  it('respects max total requests', async () => {
    const httpClient = new MockHttpClient(Array.from({ length: 20 }, () => []));
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxTotalRequests: 3 });
    expect(httpClient.urls).toHaveLength(3);
    expect(adapter.getLastDiscoveryDebug()?.stopReason).toBe('max_total_requests');
  });



  it('respects max total candidate markets', async () => {
    const httpClient = new MockHttpClient([[gammaMarket(1), gammaMarket(2), gammaMarket(3)]]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxCandidates: 2 });
    expect(markets).toHaveLength(2);
    expect(adapter.getLastDiscoveryDebug()?.stopReason).toBe('max_candidates');
  });

  it('respects per-request timeout and logs failed request context', async () => {
    class HangingHttpClient {
      public urls: URL[] = [];
      public async getJson<T>(url: URL): Promise<T> {
        this.urls.push(url);
        return new Promise<T>(() => undefined);
      }
    }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const adapter = new PolymarketGammaApiAdapter(new HangingHttpClient() as never, 'https://example.test');
      await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxTotalRequests: 1, discoveryRequestTimeoutSeconds: 1 });
      expect(info.mock.calls.some((call) => String(call[0]).includes('source=public-search') && String(call[0]).includes('query="btc updown 1h"') && String(call[0]).includes('url=https://example.test/public-search'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  }, 3_000);

  it('uses prioritized small all-duration query set by default', async () => {
    const httpClient = new MockHttpClient(Array.from({ length: 100 }, () => []));
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: 'all' });
    const queries = new Set(httpClient.urls.map((url) => url.searchParams.get('q')));
    expect([...queries]).toEqual(['btc updown 1h', 'bitcoin up or down hourly', 'btc updown 4h', 'bitcoin up or down 4h', 'btc updown daily', 'bitcoin up or down daily']);
    expect([...queries]).not.toContain('btc-updown-1h');
  });

  it('runs expanded search only when requested and prioritized search finds zero candidates', async () => {
    const defaultHttpClient = new MockHttpClient(Array.from({ length: 100 }, () => []));
    const defaultAdapter = new PolymarketGammaApiAdapter(defaultHttpClient as never, 'https://example.test');
    await defaultAdapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h' });
    expect(defaultHttpClient.urls.some((url) => url.searchParams.get('q') === 'btc-updown-1h')).toBe(false);

    const expandedHttpClient = new MockHttpClient(Array.from({ length: 100 }, () => []));
    const expandedAdapter = new PolymarketGammaApiAdapter(expandedHttpClient as never, 'https://example.test');
    await expandedAdapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryExpandedSearch: true, discoveryMaxTotalRequests: 200 });
    expect(expandedHttpClient.urls.some((url) => url.searchParams.get('q') === 'btc-updown-1h')).toBe(true);
  });

  it('logs discovery progress and stop reason', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const adapter = new PolymarketGammaApiAdapter(new MockHttpClient([[]]) as never, 'https://example.test');
      await adapter.discoverBitcoinUpDownMarkets('2026-05-01', '2026-05-02', { requestedMarketDuration: '1h', discoveryMaxTotalRequests: 1 });
      const messages = info.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('Discovery request: source=public-search query="btc updown 1h" page=1'))).toBe(true);
      expect(messages.some((message) => message.includes('Discovery response: source=public-search query="btc updown 1h" items=0 candidates=0'))).toBe(true);
      expect(messages.some((message) => message.includes('Discovery stopped: reason=max_total_requests'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });


  it('allows broad date scan only when explicitly enabled and flags broad candidates', async () => {
    const emptySearchResponses = Array.from({ length: 16 }, () => []);
    const broadMarket = { slug: 'chicago-first-snowfall', question: 'Will Chicago record the first snowfall?', startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-01T01:00:00.000Z' };
    const httpClient = new MockHttpClient([...emptySearchResponses, { markets: [broadMarket] }]);
    const adapter = new PolymarketGammaApiAdapter(httpClient as never, 'https://example.test');
    const markets = await adapter.discoverBitcoinUpDownFiveMinuteMarkets('2026-05-01', '2026-05-02', { allowBroadGammaDateScan: true });
    expect(httpClient.urls.some((url) => url.pathname === '/markets/keyset')).toBe(true);
    expect(markets[0]).toMatchObject({ slug: 'chicago-first-snowfall', __dataQualityFlags: ['broad_gamma_date_scan_candidate'] });
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
    const result = runNpmCommand(['run', 'collector', '--', 'discover', '--price-fidelity-minutes', '1', '--help']);

    if (result.error) {
      throw result.error;
    }

    expect(result.status).toBe(0);
  });

  it('rejects price fidelity below one minute', () => {
    const result = runNpmCommand(['run', 'collector', '--', 'discover', '--start-date', '2026-05-01', '--end-date', '2026-05-02', '--price-fidelity-minutes', '0']);

    if (result.error) {
      throw result.error;
    }

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('--price-fidelity-minutes must be a number greater than or equal to 1');
  });

  it('rejects removed price-fidelity-seconds alias as an unknown option', () => {
    const result = runNpmCommand(['run', 'collector', '--', 'discover', '--start-date', '2026-05-01', '--end-date', '2026-05-02', '--price-fidelity-seconds', '5']);

    if (result.error) {
      throw result.error;
    }

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
    const fifteenMinute = rawMarket('2026-05-01T00:00:00.000Z', '2026-05-01T00:15:00.000Z', { slug: 'btc-updown-15m-1777592700', question: 'Bitcoin Up or Down - April 30, 7:45PM-8:00PM ET' });
    const unknown = { ...oneHour, slug: 'bitcoin-up-down-unknown', startDate: undefined, endDate: undefined, question: 'Bitcoin Up or Down - target price $100,000' };
    const eth = { ...oneHour, slug: 'eth-up-down-hourly', question: 'Ethereum Up or Down - target price $2,000' };
    const result = adapter.parseMarkets([oneHour, fiveMinute, fifteenMinute, unknown, eth], '/tmp/raw.json', '1h');
    expect(result.acceptedMarkets).toHaveLength(1);
    expect(result.acceptedMarkets[0]?.marketDuration).toBe('1h');
    expect(result.rejectedMarkets.map((market) => market.rejectionReason)).toEqual(['unsupported_duration', 'unsupported_duration', 'unknown_duration', 'not_bitcoin_up_down']);
    expect(result.rejectedMarkets[0]?.detectedMarketDuration).toBe('5m');
    expect(result.rejectedMarkets[1]?.detectedMarketDuration).toBe('15m');
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
    allowBroadGammaDateScan: 'false',
    allowEmptyMarketSet: 'false',
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
