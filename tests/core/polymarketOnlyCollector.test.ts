import { describe, expect, it } from 'vitest';
import { buildNormalizedPricePointsForMarketWithSkipCount } from '../../src/core/alignment.js';
import { buildStrategyTrainingRows } from '../../src/application/collectorUseCases.js';
import { parseOptions } from '../../src/cli/createCollectorProgram.js';
import type { NormalizedMarket, PriceHistoryPoint } from '../../src/core/domain.js';
import packageJson from '../../package.json' with { type: 'json' };

function market(): NormalizedMarket {
  return { marketSlug: 'bitcoin-up-or-down-april-30-2026-7pm-et', conditionId: 'condition', question: 'Bitcoin Up or Down - April 30, 7PM ET', marketDuration: '1h', marketStartTimestampMilliseconds: Date.parse('2026-04-30T23:00:00.000Z'), marketEndTimestampMilliseconds: Date.parse('2026-05-01T00:00:00.000Z'), upTokenId: 'up', downTokenId: 'down', targetPrice: 76237.07, winner: 'up', isResolved: true, isClosed: true, rawOutcomes: '["Up","Down"]', rawOutcomePrices: '["1","0"]', dataQualityFlags: [] };
}
function history(count: number, base: number): PriceHistoryPoint[] { return Array.from({ length: count }, (_, index) => ({ timestampMilliseconds: Date.parse('2026-04-30T23:00:00.000Z') + index * 60_000, price: base + index / 1_000 })); }

describe('Polymarket-only collector regression', () => {
  it('builds all Polymarket price points without external primary prices', () => {
    const result = buildNormalizedPricePointsForMarketWithSkipCount({ market: market(), upPriceHistory: history(103, 0.4), downPriceHistory: history(103, 0.6), requestedFidelityMinutes: 1 });
    expect(result.pricePoints).toHaveLength(103);
    expect(buildStrategyTrainingRows(result.pricePoints).length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('skippedRowsMissingPrimaryPriceBeforeTimestamp');
    expect(result.skippedRowsMissingPolymarketPrice).toBe(0);
  });

  it('does not expose Binance/proxy scripts or Binance CLI flags', () => {
    expect(Object.keys(packageJson.scripts).some((name) => name.startsWith('collect:proxy'))).toBe(false);
    expect(packageJson.scripts).toHaveProperty('collect:pm:all');
    const options = parseOptions({ date: '2026-05-01', priceFidelityMinutes: '1', marketDuration: 'all', force: true, requestDelayMilliseconds: '0', maximumConcurrentRequests: '1', writeDebugJson: 'false', allowBroadGammaDateScan: 'false', allowEmptyMarketSet: 'false', discoveryExpandedSearch: 'false' });
    expect(options.marketDuration).toBe('all');
    expect(options).not.toHaveProperty('allowProxyPrimaryPriceSourceForDebug');
    expect(options).not.toHaveProperty('includeBinanceSecondarySignal');
  });

  it('defaults discovery request budget to 1000 and accepts custom caps', () => {
    const baseOptions = { date: '2026-05-01', priceFidelityMinutes: '1', requestDelayMilliseconds: '0', maximumConcurrentRequests: '1', marketDuration: 'all' };
    const defaults = parseOptions(baseOptions);
    expect(defaults.discoveryMaxTotalRequests).toBe(1000);
    expect(parseOptions({ ...baseOptions, discoveryMaxTotalRequests: '300' }).discoveryMaxTotalRequests).toBe(300);
    expect(parseOptions({ ...baseOptions, discoveryMaxTotalRequests: '1000' }).discoveryMaxTotalRequests).toBe(1000);
    expect(parseOptions({ ...baseOptions, discoveryMaxTotalRequests: '2000' }).discoveryMaxTotalRequests).toBe(2000);
  });
});
