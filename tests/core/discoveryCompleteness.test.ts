import { describe, expect, it } from 'vitest';
import { buildExactBitcoinUpDownTitleSearchTerms, PolymarketGammaApiAdapter } from '../../src/adapters/polymarketGammaApi.js';
import { buildDiscoveryAudit, buildExpectedHourlyWindows } from '../../src/application/collectorUseCases.js';

const baseMarket = {
  question: 'Bitcoin Up or Down - May 1, 9PM ET',
  slug: 'bitcoin-up-or-down-may-1-9pm-et',
  conditionId: 'condition-1',
  startDate: '2026-05-02T00:00:00.000Z',
  endDate: '2026-05-02T01:00:00.000Z',
  outcomes: ['Up', 'Down'],
  outcomePrices: ['1', '0'],
  clobTokenIds: ['up-token', 'down-token'],
  targetPrice: 100,
  closed: true,
  resolved: true,
};

describe('discovery completeness audit', () => {
  it('date range 2026-05-02 UTC generates relevant ET hourly search windows', () => {
    const terms = buildExactBitcoinUpDownTitleSearchTerms('2026-05-02', '2026-05-03', 'all');
    expect(terms).toContain('Bitcoin Up or Down - May 1, 8PM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 1, 9PM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 2, 12AM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 2, 7PM ET');
  });

  it('date range 2026-05-02 UTC generates relevant ET 4h search windows', () => {
    const terms = buildExactBitcoinUpDownTitleSearchTerms('2026-05-02', '2026-05-03', 'all');
    expect(terms).toContain('Bitcoin Up or Down - May 1, 8PM-12AM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 2, 12AM-4AM ET');
  });

  it('searches exact title terms before generic terms', async () => {
    const requestedQueries: string[] = [];
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>(url: URL) {
        requestedQueries.push(String(url.searchParams.get('q')));
        return [] as T;
      },
    });
    await adapter.discoverBitcoinUpDownMarkets('2026-05-02', '2026-05-03', { requestedMarketDuration: 'all', discoveryMaxTotalRequests: 200, discoveryMaxPagesPerQuery: 1 });
    expect(requestedQueries[0]).toBe('Bitcoin Up or Down - May 1, 8PM ET');
    expect(requestedQueries.indexOf('btc updown 1h')).toBeGreaterThan(requestedQueries.lastIndexOf('Bitcoin Up or Down - May 2, 4PM-8PM ET'));
  });

  it('accepted 1h market with endDate inside range is counted and audit contains inside summaries', () => {
    const adapter = new PolymarketGammaApiAdapter({ async getJson<T>() { return [] as T; } });
    const result = adapter.parseMarkets([baseMarket], 'raw.json', 'all');
    const audit = buildDiscoveryAudit({ startDate: '2026-05-02', endDate: '2026-05-03', marketDuration: 'all' }, [baseMarket], result);
    expect(result.acceptedMarkets).toHaveLength(1);
    expect((audit.acceptedByDuration as Record<string, number>)['1h']).toBe(1);
    expect((audit.insideDateRangeByDuration as Record<string, number>)['1h']).toBe(1);
    expect((audit.insideDateRangeMarkets as unknown[])).toHaveLength(1);
  });

  it('outside date candidates are not counted as missing accepted hourly windows', () => {
    const outside = { ...baseMarket, conditionId: 'condition-outside', slug: 'outside', endDate: '2026-05-01T01:00:00.000Z' };
    const adapter = new PolymarketGammaApiAdapter({ async getJson<T>() { return [] as T; } });
    const result = adapter.parseMarkets([outside], 'raw.json', 'all');
    const audit = buildDiscoveryAudit({ startDate: '2026-05-02', endDate: '2026-05-03', marketDuration: 'all' }, [outside], result);
    expect(audit.candidatesInsideRequestedDateRange).toBe(0);
    expect((audit.missingHourlyWindows as unknown[])).toEqual(buildExpectedHourlyWindows('2026-05-02', '2026-05-03'));
  });

  it('duplicate market from multiple queries is deduped by conditionId', async () => {
    const adapter = new PolymarketGammaApiAdapter({ async getJson<T>() { return [{ ...baseMarket }, { ...baseMarket, question: 'Bitcoin Up or Down - May 1, 9PM ET duplicate' }] as T; } });
    const markets = await adapter.discoverBitcoinUpDownMarkets('2026-05-02', '2026-05-03', { requestedMarketDuration: 'all', discoveryMaxTotalRequests: 1, discoveryMaxPagesPerQuery: 1 });
    expect(markets).toHaveLength(1);
  });

  it('audit keeps accepted version when same slug is both accepted and rejected', () => {
    const accepted = { ...baseMarket, conditionId: 'accepted-condition' };
    const rejected = { ...baseMarket, conditionId: 'rejected-condition', outcomes: ['Yes', 'No'] };
    const adapter = new PolymarketGammaApiAdapter({ async getJson<T>() { return [] as T; } });
    const result = adapter.parseMarkets([accepted, rejected], 'raw.json', 'all');
    const audit = buildDiscoveryAudit({ startDate: '2026-05-02', endDate: '2026-05-03', marketDuration: 'all' }, [accepted, rejected], result);
    const matchingSummaries = (audit.insideDateRangeMarkets as Record<string, unknown>[]).filter((market) => market['marketSlug'] === baseMarket.slug);
    expect(matchingSummaries).toHaveLength(1);
    expect(matchingSummaries[0]?.['rejectionReason']).toBeNull();
  });
});
