import type { ExternalPricePoint, ExternalPriceSourceName } from '../core/domain.js';
import type { BinanceArchiveApiAdapter, BinanceDataType, BinanceMarketType } from './binanceArchiveApi.js';
import type { PublicHttpClient } from './httpClient.js';

export interface ExternalPriceSourceDateRangeParameters {
  startDate: string;
  endDate: string;
  symbol?: string;
  binanceMarketType?: BinanceMarketType;
  binanceDataType?: BinanceDataType;
}

export interface ExternalPriceSource {
  sourceName: ExternalPriceSourceName;
  getPricePointsForDateRange(parameters: ExternalPriceSourceDateRangeParameters): Promise<ExternalPricePoint[]>;
}

export class ChainlinkBtcUsdDataStreamPriceSource implements ExternalPriceSource {
  public readonly sourceName = 'chainlink';

  public constructor(
    private readonly _httpClient: PublicHttpClient,
    private readonly _baseUrl = 'https://data-streams.chain.link',
  ) {}

  public async getPricePointsForDateRange(_parameters: ExternalPriceSourceDateRangeParameters): Promise<ExternalPricePoint[]> {
    // Chainlink Data Streams historical access is provider-gated. The collector keeps Chainlink
    // as the primary analytical port so official-distance calculations cannot accidentally fall
    // back to Binance. When no Chainlink history is supplied by a future implementation, rows are
    // skipped and chainlink_data_unavailable is logged/flagged by the dataset builder.
    return [];
  }
}

export class BinanceBtcUsdtPriceSource implements ExternalPriceSource {
  public readonly sourceName = 'binance';

  public constructor(private readonly binanceArchiveApiAdapter: BinanceArchiveApiAdapter) {}

  public async getPricePointsForDateRange(parameters: ExternalPriceSourceDateRangeParameters): Promise<ExternalPricePoint[]> {
    const pricePoints: ExternalPricePoint[] = [];
    for (const date of enumerateDates(parameters.startDate, parameters.endDate)) {
      const archiveResult = await this.binanceArchiveApiAdapter.downloadDailyPricePoints({
        date,
        symbol: parameters.symbol ?? 'BTCUSDT',
        marketType: parameters.binanceMarketType ?? 'spot',
        dataType: parameters.binanceDataType ?? 'aggTrades',
      });
      pricePoints.push(...archiveResult.pricePoints.map((pricePoint) => ({
        timestampMilliseconds: pricePoint.timestampMilliseconds,
        price: pricePoint.btcPrice,
        sourceName: this.sourceName,
      })));
    }
    return pricePoints;
  }
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let timestampMilliseconds = Date.parse(`${startDate}T00:00:00.000Z`); timestampMilliseconds < Date.parse(`${endDate}T00:00:00.000Z`); timestampMilliseconds += 86_400_000) {
    dates.push(new Date(timestampMilliseconds).toISOString().slice(0, 10));
  }
  return dates;
}
