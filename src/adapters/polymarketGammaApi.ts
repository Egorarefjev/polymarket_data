import type { MarketDuration, NormalizedMarket, RejectedMarket, RequestedMarketDuration } from '../core/domain.js';
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

export interface GammaDiscoveryOptions {
  allowBroadGammaDateScan?: boolean;
}

interface GammaDiscoveryPageResult {
  markets: Record<string, unknown>[];
  pagesFetched: number;
  rawMarketsFetched: number;
  earliestFetchedEndDate: string | null;
  latestFetchedEndDate: string | null;
}

const BTC_UP_DOWN_SEARCH_TERMS = ['bitcoin up down', 'btc up down', 'bitcoin up or down', 'btc updown', 'bitcoin updown'] as const;
const GAMMA_SEARCH_PARAMETER_NAMES = ['query', 'q', 'search', 'slug'] as const;

export class PolymarketGammaApiAdapter {
  public constructor(
    private readonly httpClient: PublicHttpClient,
    private readonly baseUrl = 'https://gamma-api.polymarket.com',
  ) {}

  public async discoverBitcoinUpDownMarkets(startDate: string, endDate: string, options: GammaDiscoveryOptions = {}): Promise<Record<string, unknown>[]> {
    const searchDiscovery = await this.discoverWithSearchQueries(startDate, endDate);
    let discovery = searchDiscovery;
    if (searchDiscovery.markets.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ dataQualityFlag: 'gamma_search_returned_zero_candidates', startDate, endDate }));
      if (options.allowBroadGammaDateScan === true) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ dataQualityFlag: 'broad_gamma_date_scan_enabled', startDate, endDate }));
        const broadDiscovery = (await this.tryDiscoverWithKeysetPagination(startDate, endDate)) ?? (await this.discoverWithOffsetPagination(startDate, endDate));
        discovery = { ...broadDiscovery, markets: broadDiscovery.markets.map((market) => ({ ...market, __dataQualityFlags: ['broad_gamma_date_scan_candidate'] })) };
      }
    }
    if (!doesFetchedRangeCoverRequestedRange(discovery.earliestFetchedEndDate, discovery.latestFetchedEndDate, startDate, endDate) && discovery.rawMarketsFetched > 0) {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        dataQualityFlag: 'gamma_discovery_fetched_range_does_not_cover_requested_range',
        requestedStartDate: `${startDate}T00:00:00.000Z`,
        requestedEndDate: `${endDate}T00:00:00.000Z`,
        earliestFetchedEndDate: discovery.earliestFetchedEndDate,
        latestFetchedEndDate: discovery.latestFetchedEndDate,
      }));
    }
    const locallyMatchedMarkets = discovery.markets.filter(isBitcoinUpDownMarket).length;
    // eslint-disable-next-line no-console
    console.info(JSON.stringify({
      pagesFetched: discovery.pagesFetched,
      rawMarketsFetched: discovery.rawMarketsFetched,
      candidateMarketsFetched: discovery.markets.length,
      locallyMatchedMarkets,
      matchingMarketsFound: locallyMatchedMarkets,
      earliestFetchedEndDate: discovery.earliestFetchedEndDate,
      latestFetchedEndDate: discovery.latestFetchedEndDate,
    }));
    return discovery.markets;
  }

  private async discoverWithSearchQueries(startDate: string, endDate: string): Promise<GammaDiscoveryPageResult> {
    const deduplicatedCandidates = new Map<string, Record<string, unknown>>();
    let pagesFetched = 0;
    let rawMarketsFetched = 0;
    let earliestFetchedEndTimestamp: number | null = null;
    let latestFetchedEndTimestamp: number | null = null;
    for (const searchTerm of BTC_UP_DOWN_SEARCH_TERMS) {
      for (const searchParameterName of GAMMA_SEARCH_PARAMETER_NAMES) {
        try {
          const discovery = await this.discoverWithOffsetPagination(startDate, endDate, { searchParameterName, searchTerm, candidateOnly: true });
          pagesFetched += discovery.pagesFetched;
          rawMarketsFetched += discovery.rawMarketsFetched;
          earliestFetchedEndTimestamp = minNullableTimestamp(earliestFetchedEndTimestamp, discovery.earliestFetchedEndDate);
          latestFetchedEndTimestamp = maxNullableTimestamp(latestFetchedEndTimestamp, discovery.latestFetchedEndDate);
          for (const market of discovery.markets) deduplicatedCandidates.set(deduplicationKey(market), market);
        } catch {
          // Keep trying other Gamma search parameter names because API support has varied over time.
        }
      }
    }
    return {
      markets: [...deduplicatedCandidates.values()],
      pagesFetched,
      rawMarketsFetched,
      earliestFetchedEndDate: earliestFetchedEndTimestamp === null ? null : new Date(earliestFetchedEndTimestamp).toISOString(),
      latestFetchedEndDate: latestFetchedEndTimestamp === null ? null : new Date(latestFetchedEndTimestamp).toISOString(),
    };
  }

  private async tryDiscoverWithKeysetPagination(startDate: string, endDate: string): Promise<GammaDiscoveryPageResult | null> {
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
        allRawMarkets.push(...rawMarkets);
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

  private async discoverWithOffsetPagination(startDate: string, endDate: string, searchOptions?: { searchParameterName: string; searchTerm: string; candidateOnly: boolean }): Promise<GammaDiscoveryPageResult> {
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
      if (searchOptions !== undefined) url.searchParams.set(searchOptions.searchParameterName, searchOptions.searchTerm);
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
      allRawMarkets.push(...(searchOptions?.candidateOnly === true ? rawMarkets.filter(isBitcoinUpDownMarket) : rawMarkets));
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

  public async discoverBitcoinUpDownFiveMinuteMarkets(startDate: string, endDate: string, options: GammaDiscoveryOptions = {}): Promise<Record<string, unknown>[]> {
    return this.discoverBitcoinUpDownMarkets(startDate, endDate, options);
  }

  public parseMarkets(rawMarkets: Record<string, unknown>[], rawMarketFilePath: string, requestedMarketDuration: RequestedMarketDuration = '1h'): GammaDiscoveryResult {
    const acceptedMarkets: NormalizedMarket[] = [];
    const rejectedMarkets: RejectedMarket[] = [];

    for (const rawMarket of rawMarkets) {
      const detectedMarketDuration = detectMarketDuration(rawMarket);
      try {
        if (!hasBitcoinOrBtcPhrase(rawMarket)) {
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, 'not_bitcoin_up_down', detectedMarketDuration, ['not_bitcoin_up_down']));
          continue;
        }
        if (!hasExplicitUpDownProductPhrase(rawMarket)) {
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, 'not_explicit_up_down_product', detectedMarketDuration, ['not_explicit_up_down_product']));
          continue;
        }
        if (detectedMarketDuration === null) {
          const rejectionReason = hasUnsupportedDurationSignal(rawMarket) ? 'unsupported_duration' : 'unknown_duration';
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, rejectionReason, null, [rejectionReason]));
          continue;
        }
        if (!isRequestedMarketDuration(detectedMarketDuration, requestedMarketDuration)) {
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, 'unsupported_duration', detectedMarketDuration, ['unsupported_duration']));
          continue;
        }

        const outcomes = parseOutcomes(rawMarket['outcomes'] ?? rawMarket['shortOutcomes'] ?? []);
        if (!hasExplicitUpDownOutcomes(outcomes)) {
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, 'non_up_down_outcomes', detectedMarketDuration, ['non_up_down_outcomes']));
          continue;
        }

        const normalizedMarket = normalizeGammaMarket(rawMarket, detectedMarketDuration);
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
            detectedMarketDuration,
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
          detectedMarketDuration,
        });
      }
    }

    return { rawMarkets, acceptedMarkets, rejectedMarkets };
  }
}

function normalizeGammaMarket(rawMarket: Record<string, unknown>, marketDuration: MarketDuration): NormalizedMarket {
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
    marketDuration,
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

export function isBitcoinUpDownMarket(rawMarket: Record<string, unknown>): boolean {
  return hasBitcoinOrBtcPhrase(rawMarket) && hasExplicitUpDownProductPhrase(rawMarket);
}

export function hasBitcoinOrBtcPhrase(rawMarket: Record<string, unknown>): boolean {
  return /\b(bitcoin|btc)\b/u.test(buildSearchableMarketText(rawMarket));
}

export function hasExplicitUpDownProductPhrase(rawMarket: Record<string, unknown>): boolean {
  return /\bup\s*(?:(?:-|\s)+or(?:-|\s)+|\/|-|\s+)?down\b/u.test(buildExplicitUpDownProductPhraseSearchableText(rawMarket));
}

export function hasExplicitUpDownOutcomes(outcomes: string[]): boolean {
  return outcomes.some((outcome) => isExplicitOutcome(outcome, 'up')) && outcomes.some((outcome) => isExplicitOutcome(outcome, 'down'));
}

export function detectMarketDuration(rawMarket: Record<string, unknown>): MarketDuration | null {
  const timestampDuration = detectMarketDurationFromTimestamps(rawMarket);
  if (timestampDuration !== null) return timestampDuration;

  const searchableText = buildSearchableMarketText(rawMarket);
  if (/\b(1h|1\s*h|one\s*hour|hourly|hour-long|1-hour|1\s*hour)\b/u.test(searchableText)) return '1h';
  if (/\b(4h|4\s*h|four\s*hour|four-hour|4-hour|4\s*hour)\b/u.test(searchableText)) return '4h';
  if (/\b(1d|1\s*d|daily|day-long|1-day|1\s*day|24h|24\s*h|24-hour|24\s*hour)\b/u.test(searchableText)) return '1d';
  return null;
}

export function isRequestedMarketDuration(detectedDuration: MarketDuration | null, requestedDuration: RequestedMarketDuration): boolean {
  return detectedDuration !== null && (requestedDuration === 'all' || detectedDuration === requestedDuration);
}

function hasUnsupportedDurationSignal(rawMarket: Record<string, unknown>): boolean {
  if (detectUnsupportedDurationFromTimestamps(rawMarket)) return true;
  return /\b(5m|5\s*m|5-min|5\s*min|5\s*minute|five\s*minute)\b/u.test(buildSearchableMarketText(rawMarket));
}

function detectMarketDurationFromTimestamps(rawMarket: Record<string, unknown>): MarketDuration | null {
  const startTimestamp = extractTime(rawMarket, ['startDate', 'startDateIso', 'gameStartTime', 'eventStartTime', 'startTime']);
  const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
  if (startTimestamp === null || endTimestamp === null) return null;
  const durationMilliseconds = endTimestamp - startTimestamp;
  const toleranceMilliseconds = 5 * 60_000;
  if (Math.abs(durationMilliseconds - 60 * 60_000) <= toleranceMilliseconds) return '1h';
  if (Math.abs(durationMilliseconds - 4 * 60 * 60_000) <= toleranceMilliseconds) return '4h';
  if (Math.abs(durationMilliseconds - 24 * 60 * 60_000) <= toleranceMilliseconds) return '1d';
  return null;
}

function detectUnsupportedDurationFromTimestamps(rawMarket: Record<string, unknown>): boolean {
  const startTimestamp = extractTime(rawMarket, ['startDate', 'startDateIso', 'gameStartTime', 'eventStartTime', 'startTime']);
  const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
  if (startTimestamp === null || endTimestamp === null) return false;
  const durationMilliseconds = endTimestamp - startTimestamp;
  const toleranceMilliseconds = 5 * 60_000;
  return durationMilliseconds > 0 && ![60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000].some((supportedDuration) => Math.abs(durationMilliseconds - supportedDuration) <= toleranceMilliseconds);
}

function buildSearchableMarketText(rawMarket: Record<string, unknown>): string {
  const directText = [rawMarket['slug'], rawMarket['marketSlug'], rawMarket['question'], rawMarket['title'], rawMarket['description'], rawMarket['rules']]
    .filter((value): value is string => typeof value === 'string');
  const eventText = extractNestedText(rawMarket['event']).concat(extractNestedText(rawMarket['events']));
  return [...directText, ...eventText].join(' ').toLowerCase();
}

function buildExplicitUpDownProductPhraseSearchableText(rawMarket: Record<string, unknown>): string {
  const directText = [rawMarket['slug'], rawMarket['marketSlug'], rawMarket['question'], rawMarket['title'], rawMarket['description'], rawMarket['rules']]
    .filter((value): value is string => typeof value === 'string');
  const eventText = extractEventProductText(rawMarket['event']).concat(extractEventProductText(rawMarket['events']));
  return [...directText, ...eventText].join(' ').toLowerCase();
}

function extractEventProductText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(extractEventProductText);
  if (!isRecord(value)) return [];
  return ['slug', 'title', 'description'].flatMap((fieldName) => extractNestedText(value[fieldName]));
}

function extractNestedText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(extractNestedText);
  if (!isRecord(value)) return [];
  return ['slug', 'title', 'question', 'description', 'name'].flatMap((fieldName) => extractNestedText(value[fieldName]));
}

function buildRejectedRawMarket(rawMarket: Record<string, unknown>, rawMarketFilePath: string, rejectionReason: string, detectedMarketDuration: MarketDuration | null, dataQualityFlags: string[]): RejectedMarket {
  const existingFlags = Array.isArray(rawMarket['__dataQualityFlags']) ? rawMarket['__dataQualityFlags'].map(String) : [];
  return {
    marketSlug: typeof rawMarket['slug'] === 'string' ? rawMarket['slug'] : null,
    conditionId: typeof rawMarket['conditionId'] === 'string' ? rawMarket['conditionId'] : typeof rawMarket['condition_id'] === 'string' ? rawMarket['condition_id'] : null,
    question: typeof rawMarket['question'] === 'string' ? rawMarket['question'] : typeof rawMarket['title'] === 'string' ? rawMarket['title'] : null,
    rejectionReason,
    rawMarketFilePath,
    dataQualityFlags: [...existingFlags, ...dataQualityFlags],
    detectedMarketDuration,
  };
}

function deduplicationKey(rawMarket: Record<string, unknown>): string {
  const conditionId = typeof rawMarket['conditionId'] === 'string' ? rawMarket['conditionId'] : typeof rawMarket['condition_id'] === 'string' ? rawMarket['condition_id'] : null;
  if (conditionId !== null && conditionId.length > 0) return `condition:${conditionId}`;
  const slug = typeof rawMarket['slug'] === 'string' ? rawMarket['slug'] : typeof rawMarket['marketSlug'] === 'string' ? rawMarket['marketSlug'] : null;
  if (slug !== null && slug.length > 0) return `slug:${slug}`;
  return `question:${String(rawMarket['question'] ?? rawMarket['title'] ?? JSON.stringify(rawMarket))}`;
}

function minNullableTimestamp(currentTimestamp: number | null, isoTimestamp: string | null): number | null {
  if (isoTimestamp === null) return currentTimestamp;
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return currentTimestamp;
  return currentTimestamp === null ? timestamp : Math.min(currentTimestamp, timestamp);
}

function maxNullableTimestamp(currentTimestamp: number | null, isoTimestamp: string | null): number | null {
  if (isoTimestamp === null) return currentTimestamp;
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return currentTimestamp;
  return currentTimestamp === null ? timestamp : Math.max(currentTimestamp, timestamp);
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

export function findTokenIdForOutcome(outcomes: string[], tokenIds: string[], desiredOutcome: 'up' | 'down'): string | null {
  const outcomeIndex = outcomes.findIndex((outcome) => isExplicitOutcome(outcome, desiredOutcome));
  return outcomeIndex >= 0 ? tokenIds[outcomeIndex] ?? null : null;
}

function isExplicitOutcome(outcome: string, desiredOutcome: 'up' | 'down'): boolean {
  const normalizedOutcome = outcome.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
  return normalizedOutcome === desiredOutcome || normalizedOutcome === `bitcoin ${desiredOutcome}` || normalizedOutcome === `btc ${desiredOutcome}`;
}

function extractTime(rawMarket: Record<string, unknown>, fieldNames: string[]): number | null {
  return extractTimeFromValue(rawMarket, fieldNames, 0);
}

function extractTimeFromValue(value: unknown, fieldNames: string[], depth: number): number | null {
  if (depth > 2 || !isRecord(value)) return null;
  for (const fieldName of fieldNames) {
    const timestamp = parseTimestampValue(value[fieldName]);
    if (timestamp !== null) return timestamp;
  }
  for (const nestedFieldName of ['event', 'events', 'metadata']) {
    const nestedValue = value[nestedFieldName];
    if (Array.isArray(nestedValue)) {
      for (const entry of nestedValue) {
        const nestedTimestamp = extractTimeFromValue(entry, fieldNames, depth + 1);
        if (nestedTimestamp !== null) return nestedTimestamp;
      }
    } else {
      const nestedTimestamp = extractTimeFromValue(nestedValue, fieldNames, depth + 1);
      if (nestedTimestamp !== null) return nestedTimestamp;
    }
  }
  return null;
}

function parseTimestampValue(rawValue: unknown): number | null {
  if (typeof rawValue === 'number') return normalizeTimestampMilliseconds(rawValue);
  if (typeof rawValue === 'string') {
    const numericValue = Number(rawValue);
    if (Number.isFinite(numericValue)) return normalizeTimestampMilliseconds(numericValue);
    const parsedDate = Date.parse(rawValue);
    if (Number.isFinite(parsedDate)) return parsedDate;
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
