import { describe, expect, it } from 'vitest';
import { buildDateBasedBitcoinUpDownSearchTerms, PolymarketGammaApiAdapter } from '../../src/adapters/polymarketGammaApi.js';
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
    const terms = buildDateBasedBitcoinUpDownSearchTerms('2026-05-02', '2026-05-03', 'all');
    expect(terms).toContain('Bitcoin Up or Down - May 1, 8PM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 1, 9PM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 2, 12AM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 2, 7PM ET');
    expect(terms).toContain('Bitcoin Up or Down - May 2');
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
});
