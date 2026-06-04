import AdmZip from 'adm-zip';
import type { BinancePricePoint } from '../core/domain.js';
import { normalizeTimestampMilliseconds } from '../core/calculations.js';
import type { PublicHttpClient } from './httpClient.js';

export type BinanceMarketType = 'spot' | 'futures';
export type BinanceDataType = 'aggTrades' | 'klines';

export class BinanceArchiveApiAdapter {
  public constructor(
    private readonly httpClient: PublicHttpClient,
    private readonly baseUrl = 'https://data.binance.vision',
  ) {}

  public async downloadDailyPricePoints(parameters: {
    date: string;
    symbol: string;
    marketType: BinanceMarketType;
    dataType: BinanceDataType;
  }): Promise<{ archiveFileName: string; pricePoints: BinancePricePoint[] }> {
    const archiveFileName = buildArchiveFileName(parameters.symbol, parameters.dataType, parameters.date);
    const url = buildArchiveUrl(this.baseUrl, parameters.marketType, parameters.dataType, parameters.symbol, archiveFileName);
    const archiveBuffer = Buffer.from(await this.httpClient.getArrayBuffer(url));
    const zipArchive = new AdmZip(archiveBuffer);
    const firstEntry = zipArchive.getEntries()[0];
    if (firstEntry === undefined) return { archiveFileName, pricePoints: [] };
    const csvContent = zipArchive.readAsText(firstEntry);
    return { archiveFileName, pricePoints: parseBinanceCsv(csvContent, parameters.dataType) };
  }
}

function buildArchiveFileName(symbol: string, dataType: BinanceDataType, date: string): string {
  const intervalSuffix = dataType === 'klines' ? '-1m' : '';
  return `${symbol}-${dataType}${intervalSuffix}-${date}.zip`;
}

function buildArchiveUrl(baseUrl: string, marketType: BinanceMarketType, dataType: BinanceDataType, symbol: string, archiveFileName: string): URL {
  const marketRoot = marketType === 'spot' ? 'spot' : 'futures/um';
  const dataPath = dataType === 'klines' ? `klines/${symbol}/1m` : `${dataType}/${symbol}`;
  return new URL(`/data/${marketRoot}/daily/${dataPath}/${archiveFileName}`, baseUrl);
}

export function parseBinanceCsv(csvContent: string, dataType: BinanceDataType): BinancePricePoint[] {
  return csvContent
    .trim()
    .split('\n')
    .flatMap((line) => {
      const columns = line.split(',');
      if (columns.length < 2 || columns[0]?.toLowerCase() === 'agg_trade_id') return [];
      const timestampColumnIndex = dataType === 'aggTrades' ? 5 : 0;
      const priceColumnIndex = dataType === 'aggTrades' ? 1 : 4;
      const rawTimestamp = Number(columns[timestampColumnIndex]);
      const btcPrice = Number(columns[priceColumnIndex]);
      if (!Number.isFinite(rawTimestamp) || !Number.isFinite(btcPrice)) return [];
      return [{ timestampMilliseconds: normalizeTimestampMilliseconds(rawTimestamp), btcPrice }];
    });
}
