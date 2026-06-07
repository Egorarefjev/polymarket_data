import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PolymarketGammaApiAdapter } from '../../src/adapters/polymarketGammaApi.js';
import { PolymarketClobApiAdapter } from '../../src/adapters/polymarketClobApi.js';

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
    slug: `bitcoin-up-down-5m-${id}`,
    question: `Bitcoin Up or Down 5 Minute ${id}`,
    endDate: '2026-05-01T00:05:00.000Z',
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
