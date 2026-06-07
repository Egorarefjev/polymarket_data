import { readFile } from 'node:fs/promises';
import type { ExternalPricePoint, ExternalPriceSourceName } from '../core/domain.js';
import { normalizeTimestampMilliseconds } from '../core/calculations.js';
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
    // Chainlink Data Streams historical REST reports require authenticated access. Official
    // dataset builds should use ChainlinkLocalFilePriceSource with exported historical reports.
    return [];
  }
}

export class ChainlinkLocalFilePriceSource implements ExternalPriceSource {
  public readonly sourceName = 'chainlink';

  public constructor(private readonly filePath: string) {}

  public async getPricePointsForDateRange(_parameters: ExternalPriceSourceDateRangeParameters): Promise<ExternalPricePoint[]> {
    let fileContent: string;
    try {
      fileContent = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Chainlink input file not found: ${this.filePath}`);
      }
      throw error;
    }
    return parseChainlinkLocalFilePricePoints(fileContent, this.filePath);
  }
}

export function parseChainlinkLocalFilePricePoints(fileContent: string, filePath = '<chainlink-input>'): ExternalPricePoint[] {
  const trimmedContent = fileContent.trim();
  if (trimmedContent.length === 0) return [];

  const rawRows = looksLikeJson(trimmedContent)
    ? parseJsonOrJsonLines(trimmedContent, filePath)
    : parseCsv(trimmedContent, filePath);

  const byTimestamp = new Map<number, ExternalPricePoint>();
  rawRows.forEach((row, index) => {
    const timestamp = pickFirstDefined(row, ['timestamp_milliseconds', 'timestamp', 'timestamp_ms', 'timestampMilliseconds', 'observationsTimestamp']);
    const price = pickFirstDefined(row, ['price', 'benchmarkPrice']);
    const timestampNumber = Number(timestamp);
    const priceNumber = Number(price);
    if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
      throw new Error(`Invalid Chainlink price at row ${index + 1} in ${filePath}: ${String(price)}`);
    }
    byTimestamp.set(normalizeTimestampMilliseconds(timestampNumber), {
      timestampMilliseconds: normalizeTimestampMilliseconds(timestampNumber),
      price: priceNumber,
      sourceName: 'chainlink',
    });
  });

  return [...byTimestamp.values()].sort((left, right) => left.timestampMilliseconds - right.timestampMilliseconds);
}

function looksLikeJson(fileContent: string): boolean {
  const firstCharacter = fileContent.trimStart()[0];
  return firstCharacter === '{' || firstCharacter === '[';
}

function parseJsonOrJsonLines(fileContent: string, filePath: string): Record<string, unknown>[] {
  if (fileContent.trimStart().startsWith('[')) {
    const parsed = JSON.parse(fileContent) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Chainlink JSON input must be an array in ${filePath}`);
    return parsed.map((row) => assertRecord(row, filePath));
  }
  return fileContent
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => assertRecord(JSON.parse(line) as unknown, filePath));
}

function parseCsv(fileContent: string, filePath: string): Record<string, unknown>[] {
  const [headerLine, ...dataLines] = fileContent.split('\n').filter((line) => line.trim().length > 0);
  if (headerLine === undefined) return [];
  const headers = parseCsvLine(headerLine).map((header) => header.trim());
  return dataLines.map((line, index) => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) throw new Error(`Invalid Chainlink CSV row ${index + 2} in ${filePath}`);
    return Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex]?.trim() ?? '']));
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let currentValue = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];
    if (character === '"' && inQuotes && nextCharacter === '"') {
      currentValue += '"';
      index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === ',' && !inQuotes) {
      values.push(currentValue);
      currentValue = '';
    } else {
      currentValue += character;
    }
  }
  values.push(currentValue);
  return values;
}

function assertRecord(row: unknown, filePath: string): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error(`Chainlink input rows must be objects in ${filePath}`);
  }
  return row as Record<string, unknown>;
}

function pickFirstDefined(row: Record<string, unknown>, fieldNames: string[]): unknown {
  for (const fieldName of fieldNames) {
    if (row[fieldName] !== undefined && row[fieldName] !== '') return row[fieldName];
  }
  return undefined;
}

// Reserved for a future direct source mode. Current dataset builds intentionally read
// previously downloaded raw Binance files from FileStorage for reproducibility instead
// of calling this source during buildDataset.
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
