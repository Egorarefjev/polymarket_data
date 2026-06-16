import type { PriceHistoryPoint } from '../core/domain.js';
import { normalizeTimestampMilliseconds } from '../core/calculations.js';
import type { PublicHttpClient } from './httpClient.js';

export class PolymarketClobApiAdapter {
  public constructor(
    private readonly httpClient: PublicHttpClient,
    private readonly baseUrl = 'https://clob.polymarket.com',
  ) {}

  public async downloadPricesHistory(parameters: {
    tokenId: string;
    startTimestampMilliseconds: number;
    endTimestampMilliseconds: number;
    fidelityMinutes: number;
  }): Promise<PriceHistoryPoint[]> {
    const url = new URL('/prices-history', this.baseUrl);
    url.searchParams.set('market', parameters.tokenId);
    url.searchParams.set('startTs', String(Math.floor(parameters.startTimestampMilliseconds / 1_000)));
    url.searchParams.set('endTs', String(Math.floor(parameters.endTimestampMilliseconds / 1_000)));
    url.searchParams.set('fidelity', String(parameters.fidelityMinutes));
    const rawResponse = await this.httpClient.getJson<unknown>(url);
    const rawHistory = extractRawHistoryArray(rawResponse);
    return rawHistory.flatMap((rawPoint) => {
      if (!isRecord(rawPoint)) return [];
      const rawTimestamp = rawPoint['t'] ?? rawPoint['timestamp'] ?? rawPoint['time'];
      const rawPrice = rawPoint['p'] ?? rawPoint['price'];
      const timestampValue = Number(rawTimestamp);
      const price = Number(rawPrice);
      if (!Number.isFinite(timestampValue) || !Number.isFinite(price)) return [];
      return [{ timestampMilliseconds: normalizeTimestampMilliseconds(timestampValue), price }];
    });
  }


}

function extractRawHistoryArray(rawResponse: unknown): unknown[] {
  if (Array.isArray(rawResponse)) return rawResponse;
  if (isRecord(rawResponse)) {
    const history = rawResponse['history'] ?? rawResponse['pricesHistory'] ?? rawResponse['data'];
    if (Array.isArray(history)) return history;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
