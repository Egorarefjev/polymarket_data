import type { NormalizedMarket, RejectedMarket } from '../core/domain.js';
import { determineMarketWinner, extractTargetPrice, parseOutcomePrices, parseOutcomes } from '../core/parsing.js';
import { normalizeTimestampMilliseconds } from '../core/calculations.js';
import { validateMarketForAnalysis } from '../core/validation.js';
import { MarketParsingError } from '../application/errors.js';
import type { PublicHttpClient } from './httpClient.js';

export interface GammaDiscoveryResult {
  rawMarkets: Record<string, unknown>[];
  acceptedMarkets: NormalizedMarket[];
  rejectedMarkets: RejectedMarket[];
}

export class PolymarketGammaApiAdapter {
  public constructor(
    private readonly httpClient: PublicHttpClient,
    private readonly baseUrl = 'https://gamma-api.polymarket.com',
  ) {}

  public async discoverBitcoinUpDownFiveMinuteMarkets(startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    const discovery = (await this.tryDiscoverWithKeysetPagination(startDate, endDate)) ?? (await this.discoverWithOffsetPagination(startDate, endDate));
    if (!doesFetchedRangeCoverRequestedRange(discovery.earliestFetchedEndDate, discovery.latestFetchedEndDate, startDate, endDate)) {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        dataQualityFlag: 'gamma_discovery_fetched_range_does_not_cover_requested_range',
        requestedStartDate: `${startDate}T00:00:00.000Z`,
        requestedEndDate: `${endDate}T00:00:00.000Z`,
        earliestFetchedEndDate: discovery.earliestFetchedEndDate,
        latestFetchedEndDate: discovery.latestFetchedEndDate,
      }));
    }
    // eslint-disable-next-line no-console
    console.info(JSON.stringify({
      pagesFetched: discovery.pagesFetched,
      rawMarketsFetched: discovery.rawMarketsFetched,
      matchingMarketsFound: discovery.markets.length,
      earliestFetchedEndDate: discovery.earliestFetchedEndDate,
      latestFetchedEndDate: discovery.latestFetchedEndDate,
    }));
    return discovery.markets;
  }


  private async tryDiscoverWithKeysetPagination(startDate: string, endDate: string): Promise<{ markets: Record<string, unknown>[]; pagesFetched: number; rawMarketsFetched: number; earliestFetchedEndDate: string | null; latestFetchedEndDate: string | null } | null> {
    const allRawMarkets: Record<string, unknown>[] = [];
    const limit = 500;
    let afterCursor: string | null = null;
    let pagesFetched = 0;
    let rawMarketsFetched = 0;
    let earliestFetchedEndTimestamp: number | null = null;
    let latestFetchedEndTimestamp: number | null = null;
    try {
      while (true) {
        const url = new URL('/markets/keyset', this.baseUrl);
        url.searchParams.set('limit', String(limit));
        if (afterCursor !== null) url.searchParams.set('after_cursor', afterCursor);
        setGammaDateFilterSearchParams(url, startDate, endDate);
        const rawPage = await this.httpClient.getJson<unknown>(url);
        if (!isRecord(rawPage)) return null;
        const rawMarkets = extractKeysetMarkets(rawPage);
        if (rawMarkets === null) return null;
        pagesFetched += 1;
        rawMarketsFetched += rawMarkets.length;
        for (const rawMarket of rawMarkets) {
          const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime']);
          if (endTimestamp !== null) {
            earliestFetchedEndTimestamp = earliestFetchedEndTimestamp === null ? endTimestamp : Math.min(earliestFetchedEndTimestamp, endTimestamp);
            latestFetchedEndTimestamp = latestFetchedEndTimestamp === null ? endTimestamp : Math.max(latestFetchedEndTimestamp, endTimestamp);
          }
        }
        allRawMarkets.push(...rawMarkets.filter(isBitcoinUpDownFiveMinuteMarket));
        const nextCursor = typeof rawPage['next_cursor'] === 'string' ? rawPage['next_cursor'] : typeof rawPage['nextCursor'] === 'string' ? rawPage['nextCursor'] : null;
        if (rawMarkets.length === 0 || rawMarkets.length < limit || nextCursor === null) break;
        afterCursor = nextCursor;
      }
      return {
        markets: allRawMarkets,
        pagesFetched,
        rawMarketsFetched,
        earliestFetchedEndDate: earliestFetchedEndTimestamp === null ? null : new Date(earliestFetchedEndTimestamp).toISOString(),
        latestFetchedEndDate: latestFetchedEndTimestamp === null ? null : new Date(latestFetchedEndTimestamp).toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async discoverWithOffsetPagination(startDate: string, endDate: string): Promise<{ markets: Record<string, unknown>[]; pagesFetched: number; rawMarketsFetched: number; earliestFetchedEndDate: string | null; latestFetchedEndDate: string | null }> {
    const allRawMarkets: Record<string, unknown>[] = [];
    let offset = 0;
    const limit = 500;
    let pagesFetched = 0;
    let rawMarketsFetched = 0;
    let earliestFetchedEndTimestamp: number | null = null;
    let latestFetchedEndTimestamp: number | null = null;
    while (true) {
      const url = new URL('/markets', this.baseUrl);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      setGammaDateFilterSearchParams(url, startDate, endDate);
      const rawPage = await this.httpClient.getJson<unknown>(url);
      const rawMarkets = Array.isArray(rawPage) ? rawPage.filter(isRecord) : [];
      pagesFetched += 1;
      rawMarketsFetched += rawMarkets.length;
      for (const rawMarket of rawMarkets) {
        const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime']);
        if (endTimestamp !== null) {
          earliestFetchedEndTimestamp = earliestFetchedEndTimestamp === null ? endTimestamp : Math.min(earliestFetchedEndTimestamp, endTimestamp);
          latestFetchedEndTimestamp = latestFetchedEndTimestamp === null ? endTimestamp : Math.max(latestFetchedEndTimestamp, endTimestamp);
        }
      }
      allRawMarkets.push(...rawMarkets.filter(isBitcoinUpDownFiveMinuteMarket));
      if (rawMarkets.length === 0 || rawMarkets.length < limit) break;
      offset += limit;
    }
    return {
      markets: allRawMarkets,
      pagesFetched,
      rawMarketsFetched,
      earliestFetchedEndDate: earliestFetchedEndTimestamp === null ? null : new Date(earliestFetchedEndTimestamp).toISOString(),
      latestFetchedEndDate: latestFetchedEndTimestamp === null ? null : new Date(latestFetchedEndTimestamp).toISOString(),
    };
  }

  public parseMarkets(rawMarkets: Record<string, unknown>[], rawMarketFilePath: string): GammaDiscoveryResult {
    const acceptedMarkets: NormalizedMarket[] = [];
    const rejectedMarkets: RejectedMarket[] = [];

    for (const rawMarket of rawMarkets) {
      try {
        const normalizedMarket = normalizeGammaMarket(rawMarket);
        const validationResult = validateMarketForAnalysis(normalizedMarket);
        if (validationResult.accepted) {
          acceptedMarkets.push({ ...normalizedMarket, dataQualityFlags: validationResult.dataQualityFlags });
        } else {
          rejectedMarkets.push({
            marketSlug: normalizedMarket.marketSlug,
            conditionId: normalizedMarket.conditionId,
            question: normalizedMarket.question,
            rejectionReason: validationResult.rejectionReason ?? 'unknown_rejection_reason',
            rawMarketFilePath,
            dataQualityFlags: validationResult.dataQualityFlags,
          });
        }
      } catch (error) {
        rejectedMarkets.push({
          marketSlug: typeof rawMarket['slug'] === 'string' ? rawMarket['slug'] : null,
          conditionId: typeof rawMarket['conditionId'] === 'string' ? rawMarket['conditionId'] : null,
          question: typeof rawMarket['question'] === 'string' ? rawMarket['question'] : null,
          rejectionReason: 'market_parsing_error',
          rawMarketFilePath,
          dataQualityFlags: [`market_parsing_error:${(error as Error).message}`],
        });
      }
    }

    return { rawMarkets, acceptedMarkets, rejectedMarkets };
  }
}

function normalizeGammaMarket(rawMarket: Record<string, unknown>): NormalizedMarket {
  const rawOutcomes = rawMarket['outcomes'] ?? rawMarket['shortOutcomes'] ?? [];
  const rawOutcomePrices = rawMarket['outcomePrices'] ?? [];
  const outcomes = parseOutcomes(rawOutcomes);
  const outcomePrices = parseOutcomePrices(rawOutcomePrices);
  const tokenIds = extractClobTokenIds(rawMarket);
  const upTokenId = findTokenIdForOutcome(outcomes, tokenIds, 'up');
  const downTokenId = findTokenIdForOutcome(outcomes, tokenIds, 'down');
  const marketStartTimestampMilliseconds = extractTime(rawMarket, ['startDate', 'startDateIso', 'gameStartTime', 'createdAt']) ?? 0;
  const marketEndTimestampMilliseconds = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime']) ?? 0;
  const question = stringField(rawMarket, 'question') ?? stringField(rawMarket, 'title') ?? '';

  if (question.length === 0) throw new MarketParsingError('question_missing');

  return {
    marketSlug: stringField(rawMarket, 'slug') ?? stringField(rawMarket, 'marketSlug') ?? question.toLowerCase().replaceAll(/\s+/gu, '-'),
    conditionId: stringField(rawMarket, 'conditionId') ?? stringField(rawMarket, 'condition_id'),
    question,
    marketStartTimestampMilliseconds,
    marketEndTimestampMilliseconds,
    upTokenId,
    downTokenId,
    targetPrice: extractTargetPrice({
      targetPrice: rawMarket['targetPrice'],
      target: rawMarket['target'],
      startPrice: rawMarket['startPrice'],
      initialPrice: rawMarket['initialPrice'],
      gameStartPrice: rawMarket['gameStartPrice'],
      question,
      title: rawMarket['title'],
      description: rawMarket['description'],
      rules: rawMarket['rules'],
    }),
    winner: determineMarketWinner(rawMarket, outcomes, outcomePrices),
    isResolved: booleanField(rawMarket, 'resolved') ?? booleanField(rawMarket, 'isResolved') ?? booleanField(rawMarket, 'closed') ?? false,
    isClosed: booleanField(rawMarket, 'closed') ?? false,
    rawOutcomes: JSON.stringify(rawOutcomes),
    rawOutcomePrices: JSON.stringify(rawOutcomePrices),
    dataQualityFlags: [],
  };
}

function isBitcoinUpDownFiveMinuteMarket(rawMarket: Record<string, unknown>): boolean {
  const searchableText = [rawMarket['slug'], rawMarket['question'], rawMarket['title'], rawMarket['description']]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return (
    /\b(bitcoin|btc)\b/u.test(searchableText) &&
    /(up|down)/u.test(searchableText) &&
    /(5m|5-min|5 min|5 minute|five minute)/u.test(searchableText)
  );
}

function setGammaDateFilterSearchParams(url: URL, startDate: string, endDate: string): void {
  url.searchParams.set('closed', 'true');
  url.searchParams.set('order', 'endDate');
  url.searchParams.set('ascending', 'true');
  url.searchParams.set('end_date_min', `${startDate}T00:00:00.000Z`);
  url.searchParams.set('end_date_max', `${endDate}T00:00:00.000Z`);
}

function doesFetchedRangeCoverRequestedRange(earliestFetchedEndDate: string | null, latestFetchedEndDate: string | null, startDate: string, endDate: string): boolean {
  if (earliestFetchedEndDate === null || latestFetchedEndDate === null) return false;
  const requestedStartTimestamp = Date.parse(`${startDate}T00:00:00.000Z`);
  const requestedEndTimestamp = Date.parse(`${endDate}T00:00:00.000Z`);
  return Date.parse(earliestFetchedEndDate) <= requestedStartTimestamp && Date.parse(latestFetchedEndDate) >= requestedEndTimestamp - 1;
}

function extractKeysetMarkets(rawPage: Record<string, unknown>): Record<string, unknown>[] | null {
  const rawMarkets = rawPage['markets'] ?? rawPage['data'];
  return Array.isArray(rawMarkets) ? rawMarkets.filter(isRecord) : null;
}

function extractClobTokenIds(rawMarket: Record<string, unknown>): string[] {
  const rawTokenIds = rawMarket['clobTokenIds'] ?? rawMarket['clobTokenIDs'] ?? rawMarket['tokenIds'];
  if (typeof rawTokenIds === 'string') {
    try {
      const parsedTokenIds = JSON.parse(rawTokenIds) as unknown;
      return Array.isArray(parsedTokenIds) ? parsedTokenIds.map(String) : [];
    } catch {
      return rawTokenIds.split(',').map((tokenId) => tokenId.trim()).filter(Boolean);
    }
  }
  if (Array.isArray(rawTokenIds)) return rawTokenIds.map(String);
  return [];
}

function findTokenIdForOutcome(outcomes: string[], tokenIds: string[], desiredOutcome: 'up' | 'down'): string | null {
  const outcomeIndex = outcomes.findIndex((outcome) => outcome.toLowerCase().includes(desiredOutcome));
  const fallbackIndex = desiredOutcome === 'up' ? 0 : 1;
  return tokenIds[outcomeIndex >= 0 ? outcomeIndex : fallbackIndex] ?? null;
}

function extractTime(rawMarket: Record<string, unknown>, fieldNames: string[]): number | null {
  for (const fieldName of fieldNames) {
    const rawValue = rawMarket[fieldName];
    if (typeof rawValue === 'number') return normalizeTimestampMilliseconds(rawValue);
    if (typeof rawValue === 'string') {
      const numericValue = Number(rawValue);
      if (Number.isFinite(numericValue)) return normalizeTimestampMilliseconds(numericValue);
      const parsedDate = Date.parse(rawValue);
      if (Number.isFinite(parsedDate)) return parsedDate;
    }
  }
  return null;
}

function stringField(record: Record<string, unknown>, fieldName: string): string | null {
  return typeof record[fieldName] === 'string' ? record[fieldName] : null;
}

function booleanField(record: Record<string, unknown>, fieldName: string): boolean | null {
  return typeof record[fieldName] === 'boolean' ? record[fieldName] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
