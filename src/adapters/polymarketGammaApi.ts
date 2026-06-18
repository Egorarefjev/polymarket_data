import type { DetectedMarketDuration, MarketDuration, NormalizedMarket, RejectedMarket, RequestedMarketDuration } from '../core/domain.js';
import { determineMarketWinner, extractTargetPrice, parseOutcomePrices, parseOutcomes } from '../core/parsing.js';
import { normalizeTimestampMilliseconds } from '../core/calculations.js';
import { validateMarketForAnalysis } from '../core/validation.js';
import { MarketParsingError } from '../application/errors.js';
import { PublicHttpClient } from './httpClient.js';

export interface GammaDiscoveryResult {
  rawMarkets: Record<string, unknown>[];
  acceptedMarkets: NormalizedMarket[];
  rejectedMarkets: RejectedMarket[];
}

export interface GammaDiscoveryOptions {
  allowBroadGammaDateScan?: boolean;
  requestedMarketDuration?: RequestedMarketDuration;
  discoveryTimeoutSeconds?: number;
  discoveryMaxPagesPerQuery?: number;
  discoveryMaxTotalRequests?: number;
  discoveryMaxCandidates?: number;
  discoveryRequestTimeoutSeconds?: number;
  discoveryExpandedSearch?: boolean;
}

export interface GammaDiscoveryDebugQuery {
  source: GammaDiscoverySource;
  queryTerm: string;
  url: string;
  rawItemsFetched: number;
  candidateMarketsExtracted: number;
  locallyMatchedMarkets: number;
  acceptedMarketsFromThisQuery: number;
  rejectedMarketsFromThisQuery: number;
  extractedCandidates: { conditionId?: string | null; marketSlug: string | null; question: string | null; detectedMarketDuration?: DetectedMarketDuration | null; endDate?: string | null; isWithinRequestedDateRange?: boolean; hasOutcomes?: boolean; hasClobTokenIds?: boolean; hasTargetPriceBeforeHydration?: boolean; hydrationAttempted?: boolean; hydrationSucceeded?: boolean; hasTargetPriceAfterHydration?: boolean; rejectionReason?: string | null }[];
  error?: string;
}

export interface GammaDiscoveryDebug {
  startDate: string;
  endDate: string;
  requestedMarketDuration: RequestedMarketDuration;
  discoveryMaxTotalRequests: number;
  rawResponsesFetched: number;
  candidateMarketsFetched: number;
  deduplicatedCandidateMarkets: number;
  locallyMatchedMarkets: number;
  acceptedMarkets: number;
  rejectedMarkets: number;
  acceptedByDuration: Record<MarketDuration, number>;
  rejectedByReason: Record<string, number>;
  outsideRequestedDateRange: number;
  hydrationAttempted: number;
  hydrationSucceeded: number;
  targetPriceMissingAfterHydration: number;
  stopReason: GammaDiscoveryStopReason;
  searchedExactTitleTermsCount: number;
  searchedExactTitleTermsByDuration: Record<MarketDuration, number>;
  searchedGenericTermsCount: number;
  queries: GammaDiscoveryDebugQuery[];
}

interface GammaDiscoveryPageResult {
  markets: Record<string, unknown>[];
  pagesFetched: number;
  rawMarketsFetched: number;
  earliestFetchedEndDate: string | null;
  latestFetchedEndDate: string | null;
}

interface GammaHttpClient {
  getJson<T>(url: URL, options?: { timeoutMilliseconds?: number; maximumRetries?: number }): Promise<T>;
}

type GammaDiscoverySource = 'public-search' | 'events' | 'series' | 'markets';
type GammaDiscoveryStopReason = 'max_total_requests' | 'max_candidates' | 'timeout' | 'completed';

const GAMMA_SEARCH_PARAMETER_NAMES = ['q'] as const;
const MARKET_SEARCH_PARAMETER_NAMES = ['q'] as const;
const SUPPORTED_MARKET_DURATIONS: MarketDuration[] = ['1h', '4h', '1d'];
const EMPTY_ACCEPTED_BY_DURATION: Record<MarketDuration, number> = { '1h': 0, '4h': 0, '1d': 0 };
const EMPTY_REJECTED_BY_REASON: Record<string, number> = {
  unsupported_duration: 0,
  unknown_duration: 0,
  not_explicit_up_down_product: 0,
  non_up_down_outcomes: 0,
  target_price_missing: 0,
  token_ids_missing: 0,
  outside_requested_date_range: 0,
  end_date_missing: 0,
  non_terminal_market_template: 0,
};


const DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 120;
const DEFAULT_DISCOVERY_MAX_PAGES_PER_QUERY = 6;
const DEFAULT_DISCOVERY_MAX_TOTAL_REQUESTS = 1000;
const DEFAULT_DISCOVERY_MAX_CANDIDATES = 2_000;
const DEFAULT_DISCOVERY_REQUEST_TIMEOUT_SECONDS = 10;

const PRIORITIZED_DURATION_SEARCH_TERMS: Record<MarketDuration, readonly string[]> = {
  '1h': ['btc updown 1h', 'bitcoin up or down hourly'],
  '4h': ['btc updown 4h', 'bitcoin up or down 4h'],
  '1d': ['btc updown daily', 'bitcoin up or down daily'],
};

const DURATION_SEARCH_TERMS: Record<MarketDuration, readonly string[]> = {
  '1h': ['btc updown 1h', 'bitcoin updown 1h', 'btc up down 1 hour', 'bitcoin up or down hourly', 'bitcoin up down hourly', 'btc up/down hourly', 'bitcoin up or down 1h', 'btc-updown-1h', 'bitcoin-updown-1h'],
  '4h': ['btc updown 4h', 'bitcoin updown 4h', 'btc up down 4 hour', 'bitcoin up or down 4 hour', 'bitcoin up down 4h', 'btc up/down 4h', 'bitcoin up or down four hour', 'btc-updown-4h', 'bitcoin-updown-4h'],
  '1d': ['btc updown daily', 'bitcoin updown daily', 'btc up down daily', 'bitcoin up or down daily', 'bitcoin up down 1d', 'btc up/down daily', 'bitcoin up or down day', 'btc-updown-1d', 'bitcoin-updown-1d', 'btc-updown-daily', 'bitcoin-updown-daily'],
};

export function durationSpecificBitcoinUpDownSearchTerms(requestedDuration: RequestedMarketDuration, expandedSearch = true): string[] {
  const durations = requestedDuration === 'all' ? SUPPORTED_MARKET_DURATIONS : [requestedDuration];
  const termSource = expandedSearch ? DURATION_SEARCH_TERMS : PRIORITIZED_DURATION_SEARCH_TERMS;
  return [...new Set(durations.flatMap((duration) => termSource[duration]))];
}

export function buildDateBasedBitcoinUpDownSearchTerms(startDate: string, endDate: string, requestedDuration: RequestedMarketDuration): string[] {
  return buildExactBitcoinUpDownTitleSearchTerms(startDate, endDate, requestedDuration);
}

export function buildExactBitcoinUpDownTitleSearchTerms(startDate: string, endDate: string, requestedDuration: RequestedMarketDuration): string[] {
  return buildExactBitcoinUpDownTitleSearchTermGroups(startDate, endDate, requestedDuration).flatMap((group) => group.terms);
}

function buildExactBitcoinUpDownTitleSearchTermGroups(startDate: string, endDate: string, requestedDuration: RequestedMarketDuration): { duration: MarketDuration; terms: string[] }[] {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const groups: Record<MarketDuration, Set<string>> = { '1h': new Set<string>(), '4h': new Set<string>(), '1d': new Set<string>() };
  if (requestedDuration === 'all' || requestedDuration === '1h') {
    for (let endTimestamp = start; endTimestamp < end; endTimestamp += 60 * 60_000) {
      const endEt = formatEtMarketTime(endTimestamp);
      groups['1h'].add(`Bitcoin Up or Down - ${endEt.monthDay}, ${endEt.hour} ET`);
    }
  }
  if (requestedDuration === 'all' || requestedDuration === '4h') {
    for (let endTimestamp = start; endTimestamp < end; endTimestamp += 4 * 60 * 60_000) {
      const startEt = formatEtMarketTime(endTimestamp - 4 * 60 * 60_000);
      const endEt = formatEtMarketTime(endTimestamp);
      groups['4h'].add(`Bitcoin Up or Down - ${startEt.monthDay}, ${startEt.hourWithMinutes}-${endEt.hourWithMinutes} ET`);
      groups['4h'].add(`Bitcoin Up or Down - ${startEt.monthDay}, ${startEt.hour}-${endEt.hour} ET`);
    }
  }
  const durationOrder: MarketDuration[] = requestedDuration === 'all' ? ['1h', '4h', '1d'] : [requestedDuration];
  return durationOrder.map((duration) => ({ duration, terms: [...groups[duration]] })).filter((group) => group.terms.length > 0);
}

function interleaveExactTitleTermGroups(groups: { duration: MarketDuration; terms: string[] }[]): string[] {
  const terms: string[] = [];
  const maxTerms = Math.max(0, ...groups.map((group) => group.terms.length));
  for (let index = 0; index < maxTerms; index += 1) {
    for (const group of groups) {
      const term = group.terms[index];
      if (term !== undefined) terms.push(term);
    }
  }
  return terms;
}

function countSearchedExactTitleTermsByDuration(queries: GammaDiscoveryDebugQuery[], exactTitleTermsByDuration: Map<string, MarketDuration>): Record<MarketDuration, number> {
  const searchedTermsByDuration: Record<MarketDuration, Set<string>> = { '1h': new Set<string>(), '4h': new Set<string>(), '1d': new Set<string>() };
  for (const query of queries) {
    const duration = exactTitleTermsByDuration.get(query.queryTerm);
    if (duration !== undefined) searchedTermsByDuration[duration].add(query.queryTerm);
  }
  return { '1h': searchedTermsByDuration['1h'].size, '4h': searchedTermsByDuration['4h'].size, '1d': searchedTermsByDuration['1d'].size };
}

function formatEtMarketTime(timestampMilliseconds: number): { monthDay: string; hour: string; hourWithMinutes: string } {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: 'numeric', hour12: true });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestampMilliseconds)).map((part) => [part.type, part.value]));
  const hour = `${parts['hour']}${String(parts['dayPeriod']).toUpperCase()}`;
  return { monthDay: `${parts['month']} ${parts['day']}`, hour, hourWithMinutes: `${parts['hour']}:00${String(parts['dayPeriod']).toUpperCase()}` };
}

function normalizeDiscoveryOptions(options: GammaDiscoveryOptions): Required<Pick<GammaDiscoveryOptions, 'discoveryTimeoutSeconds' | 'discoveryMaxPagesPerQuery' | 'discoveryMaxTotalRequests' | 'discoveryMaxCandidates' | 'discoveryRequestTimeoutSeconds' | 'discoveryExpandedSearch'>> {
  return {
    discoveryTimeoutSeconds: options.discoveryTimeoutSeconds ?? DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
    discoveryMaxPagesPerQuery: options.discoveryMaxPagesPerQuery ?? DEFAULT_DISCOVERY_MAX_PAGES_PER_QUERY,
    discoveryMaxTotalRequests: options.discoveryMaxTotalRequests ?? DEFAULT_DISCOVERY_MAX_TOTAL_REQUESTS,
    discoveryMaxCandidates: options.discoveryMaxCandidates ?? DEFAULT_DISCOVERY_MAX_CANDIDATES,
    discoveryRequestTimeoutSeconds: options.discoveryRequestTimeoutSeconds ?? DEFAULT_DISCOVERY_REQUEST_TIMEOUT_SECONDS,
    discoveryExpandedSearch: options.discoveryExpandedSearch ?? false,
  };
}

function validatePositiveDiscoveryInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) throw new Error(`${name} must be a positive integer`);
}


export class PolymarketGammaApiAdapter {
  private lastDiscoveryDebug: GammaDiscoveryDebug | null = null;

  public constructor(
    private readonly httpClient: GammaHttpClient,
    private readonly baseUrl = 'https://gamma-api.polymarket.com',
  ) {}

  public getLastDiscoveryDebug(): GammaDiscoveryDebug | null {
    return this.lastDiscoveryDebug;
  }

  public attachParseResultsToLastDiscoveryDebug(discoveryResult: GammaDiscoveryResult): GammaDiscoveryDebug | null {
    if (this.lastDiscoveryDebug === null) return null;
    const acceptedByKey = new Map(discoveryResult.acceptedMarkets.map((market) => [normalizedDeduplicationKey(market.conditionId, market.marketSlug, market.question), market]));
    const acceptedSlugs = new Set(discoveryResult.acceptedMarkets.map((market) => market.marketSlug));
    const auditRejectedMarkets = discoveryResult.rejectedMarkets.filter((market) => market.marketSlug === null || !acceptedSlugs.has(market.marketSlug));
    const rejectedByKey = new Map(auditRejectedMarkets.map((market) => [normalizedDeduplicationKey(market.conditionId, market.marketSlug, market.question), market]));
    const acceptedByDuration = { ...EMPTY_ACCEPTED_BY_DURATION };
    const rejectedByReason = { ...EMPTY_REJECTED_BY_REASON };
    for (const market of discoveryResult.acceptedMarkets) acceptedByDuration[market.marketDuration] += 1;
    for (const market of auditRejectedMarkets) rejectedByReason[market.rejectionReason] = (rejectedByReason[market.rejectionReason] ?? 0) + 1;
    const queries = this.lastDiscoveryDebug.queries.map((query) => {
      let acceptedMarketsFromThisQuery = 0;
      let rejectedMarketsFromThisQuery = 0;
      const extractedCandidates = query.extractedCandidates.map((candidate) => {
        const key = normalizedDeduplicationKey(candidate.conditionId ?? null, candidate.marketSlug, candidate.question);
        const accepted = acceptedByKey.get(key);
        const rejected = rejectedByKey.get(key);
        if (accepted !== undefined) acceptedMarketsFromThisQuery += 1;
        if (rejected !== undefined) rejectedMarketsFromThisQuery += 1;
        return { ...candidate, detectedMarketDuration: accepted?.marketDuration ?? rejected?.detectedMarketDuration ?? candidate.detectedMarketDuration ?? null, rejectionReason: rejected?.rejectionReason ?? candidate.rejectionReason ?? null };
      });
      return { ...query, acceptedMarketsFromThisQuery, rejectedMarketsFromThisQuery, extractedCandidates };
    });
    this.lastDiscoveryDebug = { ...this.lastDiscoveryDebug, acceptedMarkets: discoveryResult.acceptedMarkets.length, rejectedMarkets: auditRejectedMarkets.length, acceptedByDuration, rejectedByReason, outsideRequestedDateRange: rejectedByReason['outside_requested_date_range'] ?? 0, hydrationAttempted: queries.flatMap((query) => query.extractedCandidates).filter((candidate) => candidate.hydrationAttempted === true).length, hydrationSucceeded: queries.flatMap((query) => query.extractedCandidates).filter((candidate) => candidate.hydrationSucceeded === true).length, targetPriceMissingAfterHydration: rejectedByReason['target_price_missing'] ?? 0, queries };
    return this.lastDiscoveryDebug;
  }

  public async discoverBitcoinUpDownMarkets(startDate: string, endDate: string, options: GammaDiscoveryOptions = {}): Promise<Record<string, unknown>[]> {
    const requestedMarketDuration = options.requestedMarketDuration ?? '1h';
    const discoveryLimits = normalizeDiscoveryOptions(options);
    validatePositiveDiscoveryInteger('--discovery-timeout-seconds', discoveryLimits.discoveryTimeoutSeconds);
    validatePositiveDiscoveryInteger('--discovery-max-pages-per-query', discoveryLimits.discoveryMaxPagesPerQuery);
    validatePositiveDiscoveryInteger('--discovery-max-total-requests', discoveryLimits.discoveryMaxTotalRequests);
    validatePositiveDiscoveryInteger('--discovery-max-candidates', discoveryLimits.discoveryMaxCandidates);
    validatePositiveDiscoveryInteger('--gamma-request-timeout-seconds', discoveryLimits.discoveryRequestTimeoutSeconds);
    const startedAtMilliseconds = Date.now();
    let searchDiscovery = await this.discoverWithDurationSpecificQueries(startDate, endDate, requestedMarketDuration, discoveryLimits, startedAtMilliseconds, false);
    if (searchDiscovery.markets.length === 0 && discoveryLimits.discoveryExpandedSearch) {
      searchDiscovery = await this.discoverWithDurationSpecificQueries(startDate, endDate, requestedMarketDuration, discoveryLimits, startedAtMilliseconds, true);
    }
    let discovery: GammaDiscoveryPageResult & { debug: GammaDiscoveryDebug } = searchDiscovery;
    if (searchDiscovery.markets.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ dataQualityFlag: 'gamma_search_returned_zero_candidates', startDate, endDate, requestedMarketDuration }));
      if (options.allowBroadGammaDateScan === true) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ dataQualityFlag: 'broad_gamma_date_scan_enabled', startDate, endDate }));
        const broadDiscovery = (await this.tryDiscoverWithKeysetPagination(startDate, endDate)) ?? (await this.discoverWithOffsetPagination(startDate, endDate));
        discovery = { ...searchDiscovery, ...broadDiscovery, markets: broadDiscovery.markets.map((market) => ({ ...market, __dataQualityFlags: ['broad_gamma_date_scan_candidate'] })) };
      }
    }
    if (!doesFetchedRangeCoverRequestedRange(discovery.earliestFetchedEndDate, discovery.latestFetchedEndDate, startDate, endDate) && discovery.rawMarketsFetched > 0) {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({ dataQualityFlag: 'gamma_discovery_fetched_range_does_not_cover_requested_range', requestedStartDate: `${startDate}T00:00:00.000Z`, requestedEndDate: `${endDate}T00:00:00.000Z`, earliestFetchedEndDate: discovery.earliestFetchedEndDate, latestFetchedEndDate: discovery.latestFetchedEndDate }));
    }
    const locallyMatchedMarkets = discovery.markets.filter(isBitcoinUpDownMarket).length;
    this.lastDiscoveryDebug = { ...searchDiscovery.debug, candidateMarketsFetched: searchDiscovery.rawMarketsFetched, deduplicatedCandidateMarkets: discovery.markets.length, locallyMatchedMarkets };
    // eslint-disable-next-line no-console
    console.info(`Discovery stopped: reason=${this.lastDiscoveryDebug.stopReason}`);
    // eslint-disable-next-line no-console
    console.info(JSON.stringify({ discoveryMaxTotalRequests: this.lastDiscoveryDebug.discoveryMaxTotalRequests, pagesFetched: discovery.pagesFetched, rawResponsesFetched: this.lastDiscoveryDebug.rawResponsesFetched, rawMarketsFetched: discovery.rawMarketsFetched, candidateMarketsFetched: discovery.rawMarketsFetched, deduplicatedCandidateMarkets: discovery.markets.length, locallyMatchedMarkets, matchingMarketsFound: locallyMatchedMarkets, acceptedByDuration: this.lastDiscoveryDebug.acceptedByDuration, rejectedByReason: this.lastDiscoveryDebug.rejectedByReason, stopReason: this.lastDiscoveryDebug.stopReason, earliestFetchedEndDate: discovery.earliestFetchedEndDate, latestFetchedEndDate: discovery.latestFetchedEndDate, searchedExactTitleTermsByDuration: this.lastDiscoveryDebug.searchedExactTitleTermsByDuration, searchedGenericTermsCount: this.lastDiscoveryDebug.searchedGenericTermsCount }));
    return discovery.markets;
  }

  private async discoverWithDurationSpecificQueries(
    startDate: string,
    endDate: string,
    requestedMarketDuration: RequestedMarketDuration,
    limits: Required<Pick<GammaDiscoveryOptions, 'discoveryTimeoutSeconds' | 'discoveryMaxPagesPerQuery' | 'discoveryMaxTotalRequests' | 'discoveryMaxCandidates' | 'discoveryRequestTimeoutSeconds' | 'discoveryExpandedSearch'>>,
    startedAtMilliseconds: number,
    expandedSearch: boolean,
  ): Promise<GammaDiscoveryPageResult & { debug: GammaDiscoveryDebug }> {
    const deduplicatedCandidates = new Map<string, Record<string, unknown>>();
    let pagesFetched = 0;
    let rawMarketsFetched = 0;
    let rawResponsesFetched = 0;
    let earliestFetchedEndTimestamp: number | null = null;
    let latestFetchedEndTimestamp: number | null = null;
    let stopReason: GammaDiscoveryStopReason = 'completed';
    let successfulResponses = 0;
    let failedResponses = 0;
    const queries: GammaDiscoveryDebugQuery[] = [];
    const deadlineMilliseconds = startedAtMilliseconds + limits.discoveryTimeoutSeconds * 1000;
    const stopIfNeeded = (): boolean => {
      if (rawResponsesFetched >= limits.discoveryMaxTotalRequests) stopReason = 'max_total_requests';
      else if (deduplicatedCandidates.size >= limits.discoveryMaxCandidates) stopReason = 'max_candidates';
      else if (Date.now() >= deadlineMilliseconds) stopReason = 'timeout';
      else return false;
      return true;
    };
    const exactTitleTermGroups = buildExactBitcoinUpDownTitleSearchTermGroups(startDate, endDate, requestedMarketDuration);
    const exactTitleTermsByDuration = new Map(exactTitleTermGroups.flatMap((group) => group.terms.map((term) => [term, group.duration] as const)));
    const exactTitleTerms = interleaveExactTitleTermGroups(exactTitleTermGroups);
    const genericTerms = durationSpecificBitcoinUpDownSearchTerms(requestedMarketDuration, expandedSearch);
    for (const { searchTerm, maxPagesPerQuery } of [...exactTitleTerms.map((searchTerm) => ({ searchTerm, maxPagesPerQuery: 1 })), ...genericTerms.map((searchTerm) => ({ searchTerm, maxPagesPerQuery: limits.discoveryMaxPagesPerQuery }))]) {
      const sources: readonly GammaDiscoverySource[] = ['public-search', 'events', 'series', 'markets'];
      for (const source of sources) {
        for (const url of this.discoveryUrls(source, searchTerm, startDate, endDate, maxPagesPerQuery)) {
          if (stopIfNeeded()) break;
          const page = Number(url.searchParams.get('page') ?? '1');
          // eslint-disable-next-line no-console
          console.info(`Discovery request: source=${source} query="${searchTerm}" page=${page}`);
          try {
            const remainingMilliseconds = Math.max(1, deadlineMilliseconds - Date.now());
            const requestTimeoutMilliseconds = Math.min(limits.discoveryRequestTimeoutSeconds * 1000, remainingMilliseconds);
            const rawResponse = await this.getJsonWithTimeout<unknown>(url, requestTimeoutMilliseconds);
            rawResponsesFetched += 1;
            successfulResponses += 1;
            pagesFetched += 1;
            const rawItems = topLevelItems(rawResponse);
            const rawCandidates = extractCandidateMarkets(rawResponse).filter(isBitcoinUpDownMarket);
            const candidates = await Promise.all(rawCandidates.map((candidate) => this.prepareDiscoveredCandidate(candidate, startDate, endDate, limits.discoveryRequestTimeoutSeconds * 1000)));
            rawMarketsFetched += candidates.length;
            for (const rawMarket of candidates) {
              if (deduplicatedCandidates.size >= limits.discoveryMaxCandidates) break;
              const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
              if (endTimestamp !== null) {
                earliestFetchedEndTimestamp = earliestFetchedEndTimestamp === null ? endTimestamp : Math.min(earliestFetchedEndTimestamp, endTimestamp);
                latestFetchedEndTimestamp = latestFetchedEndTimestamp === null ? endTimestamp : Math.max(latestFetchedEndTimestamp, endTimestamp);
              }
              setPreferredDeduplicatedCandidate(deduplicatedCandidates, rawMarket);
            }
            // eslint-disable-next-line no-console
            console.info(`Discovery response: source=${source} query="${searchTerm}" items=${rawItems.length} candidates=${deduplicatedCandidates.size}`);
            queries.push(buildDebugQuery(source, searchTerm, url, rawItems.length, candidates));
          } catch (error) {
            rawResponsesFetched += 1;
            failedResponses += 1;
            // eslint-disable-next-line no-console
            console.info(`Discovery response: source=${source} query="${searchTerm}" items=0 candidates=${deduplicatedCandidates.size} error=${(error as Error).message} url=${url.toString()}`);
            queries.push({ source, queryTerm: searchTerm, url: url.toString(), rawItemsFetched: 0, candidateMarketsExtracted: 0, locallyMatchedMarkets: 0, acceptedMarketsFromThisQuery: 0, rejectedMarketsFromThisQuery: 0, extractedCandidates: [], error: (error as Error).message });
          }
        }
        if (stopIfNeeded()) break;
      }
      if (stopIfNeeded()) break;
    }
    if (successfulResponses === 0 && failedResponses > 0 && stopReason === 'completed') throw new Error('All Gamma discovery sources failed');
    return {
      markets: [...deduplicatedCandidates.values()],
      pagesFetched,
      rawMarketsFetched,
      earliestFetchedEndDate: earliestFetchedEndTimestamp === null ? null : new Date(earliestFetchedEndTimestamp).toISOString(),
      latestFetchedEndDate: latestFetchedEndTimestamp === null ? null : new Date(latestFetchedEndTimestamp).toISOString(),
      debug: { startDate, endDate, requestedMarketDuration, discoveryMaxTotalRequests: limits.discoveryMaxTotalRequests, rawResponsesFetched, candidateMarketsFetched: rawMarketsFetched, deduplicatedCandidateMarkets: deduplicatedCandidates.size, locallyMatchedMarkets: [...deduplicatedCandidates.values()].filter(isBitcoinUpDownMarket).length, acceptedMarkets: 0, rejectedMarkets: 0, acceptedByDuration: { ...EMPTY_ACCEPTED_BY_DURATION }, rejectedByReason: { ...EMPTY_REJECTED_BY_REASON }, outsideRequestedDateRange: 0, hydrationAttempted: 0, hydrationSucceeded: 0, targetPriceMissingAfterHydration: 0, stopReason, searchedExactTitleTermsCount: new Set(queries.filter((query) => exactTitleTerms.includes(query.queryTerm)).map((query) => query.queryTerm)).size, searchedExactTitleTermsByDuration: countSearchedExactTitleTermsByDuration(queries, exactTitleTermsByDuration), searchedGenericTermsCount: new Set(queries.filter((query) => genericTerms.includes(query.queryTerm)).map((query) => query.queryTerm)).size, queries },
    };
  }


  private async prepareDiscoveredCandidate(rawMarket: Record<string, unknown>, startDate: string, endDate: string, timeoutMilliseconds: number): Promise<Record<string, unknown>> {
    let candidate = { ...rawMarket };
    const endTimestamp = extractTime(candidate, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
    const requestedStart = Date.parse(`${startDate}T00:00:00.000Z`);
    const requestedEnd = Date.parse(`${endDate}T00:00:00.000Z`);
    candidate['__isWithinRequestedDateRange'] = endTimestamp !== null && endTimestamp >= requestedStart && endTimestamp < requestedEnd;
    if (endTimestamp === null) candidate['__discoveryRejectionReason'] = 'end_date_missing';
    else if (!(candidate['__isWithinRequestedDateRange'] as boolean)) candidate['__discoveryRejectionReason'] = 'outside_requested_date_range';

    candidate['__hasTargetPriceBeforeHydration'] = candidateHasTargetPrice(candidate);
    const detectedDuration = detectMarketDuration(candidate);
    if (detectedDuration === '5m' || detectedDuration === '15m') candidate['__discoveryRejectionReason'] = 'unsupported_duration';
    const needsHydration = detectedDuration !== '5m' && detectedDuration !== '15m' && isBitcoinUpDownMarket(candidate) && (hasStringField(candidate, 'slug') || hasStringField(candidate, 'conditionId') || hasStringField(candidate, 'condition_id')) && (!candidateHasTargetPrice(candidate) || !candidateHasOutcomes(candidate) || extractClobTokenIds(candidate).length === 0);
    candidate['__hydrationAttempted'] = needsHydration;
    candidate['__hydrationSucceeded'] = false;
    if (needsHydration) {
      const hydrated = await this.hydrateMarket(candidate, timeoutMilliseconds);
      if (hydrated !== null) {
        const discoveryMetadata = Object.fromEntries(Object.entries(candidate).filter(([key]) => key.startsWith('__')));
        candidate = { ...mergeHydratedMarket(candidate, hydrated), ...discoveryMetadata };
        candidate['__hydrationAttempted'] = true;
        candidate['__hydrationSucceeded'] = true;
      }
    }
    candidate['__hasTargetPriceAfterHydration'] = candidateHasTargetPrice(candidate);
    return withNonEnumerableDiscoveryMetadata(candidate);
  }

  private async hydrateMarket(candidate: Record<string, unknown>, timeoutMilliseconds: number): Promise<Record<string, unknown> | null> {
    const conditionId = stringField(candidate, 'conditionId') ?? stringField(candidate, 'condition_id');
    const slug = stringField(candidate, 'slug') ?? stringField(candidate, 'marketSlug');
    const urls: URL[] = [];
    if (conditionId !== null) { const url = new URL('/markets', this.baseUrl); url.searchParams.set('condition_id', conditionId); urls.push(url); }
    if (slug !== null) { urls.push(new URL(`/markets/${encodeURIComponent(slug)}`, this.baseUrl)); const url = new URL('/markets', this.baseUrl); url.searchParams.set('slug', slug); urls.push(url); }
    for (const url of urls) {
      try {
        const response = await this.getJsonWithTimeout<unknown>(url, timeoutMilliseconds);
        const markets = extractCandidateMarkets(response).filter(isBitcoinUpDownMarket);
        const match = markets.find((market) => (conditionId !== null && (stringField(market, 'conditionId') ?? stringField(market, 'condition_id')) === conditionId) || (slug !== null && (stringField(market, 'slug') ?? stringField(market, 'marketSlug')) === slug)) ?? markets[0];
        if (match !== undefined) return match;
      } catch { /* try next hydration route */ }
    }
    return null;
  }

  private async getJsonWithTimeout<T>(url: URL, timeoutMilliseconds: number): Promise<T> {
    if (this.httpClient instanceof PublicHttpClient) return this.httpClient.getJson<T>(url, { timeoutMilliseconds, maximumRetries: 0 });
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.httpClient.getJson<T>(url, { timeoutMilliseconds, maximumRetries: 0 }),
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Gamma request timed out after ${timeoutMilliseconds}ms`)), timeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private discoveryUrls(source: GammaDiscoverySource, searchTerm: string, startDate: string, endDate: string, maxPagesPerQuery: number): URL[] {
    const endpoint = source === 'public-search' ? '/public-search' : source === 'events' ? '/events' : source === 'series' ? '/series' : '/markets';
    const parameterNames = source === 'markets' ? MARKET_SEARCH_PARAMETER_NAMES : GAMMA_SEARCH_PARAMETER_NAMES;
    return parameterNames.flatMap((parameterName) => {
      return Array.from({ length: maxPagesPerQuery }, (_, pageIndex) => {
        const page = pageIndex + 1;
        const url = new URL(endpoint, this.baseUrl);
        url.searchParams.set(parameterName, searchTerm);
        url.searchParams.set('page', String(page));
        if (source === 'events' || source === 'markets') setGammaDateFilterSearchParams(url, startDate, endDate);
        if (source === 'markets') {
          const limit = 250;
          url.searchParams.set('limit', String(limit));
          url.searchParams.set('offset', String(pageIndex * limit));
        }
        return url;
      });
    });
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
          const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
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
        const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
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
        const discoveryRejectionReason = typeof rawMarket['__discoveryRejectionReason'] === 'string' ? rawMarket['__discoveryRejectionReason'] : null;
        if (discoveryRejectionReason === 'end_date_missing' || discoveryRejectionReason === 'outside_requested_date_range') {
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, discoveryRejectionReason, detectedMarketDuration, [discoveryRejectionReason]));
          continue;
        }
        if (isNonTerminalMarketTemplate(rawMarket)) {
          rejectedMarkets.push(buildRejectedRawMarket(rawMarket, rawMarketFilePath, 'non_terminal_market_template', detectedMarketDuration, ['non_terminal_market_template']));
          continue;
        }
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
        if (!isSupportedMarketDuration(detectedMarketDuration) || !isRequestedMarketDuration(detectedMarketDuration, requestedMarketDuration)) {
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
  const marketStartTimestampMilliseconds = extractTime(rawMarket, ['eventStartTime', 'startTime', 'gameStartTime', 'startDate', 'startDateIso', 'createdAt']) ?? 0;
  const marketEndTimestampMilliseconds = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']) ?? 0;
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
      priceToBeat: rawMarket['priceToBeat'],
      eventMetadataPriceToBeat: findFirstNestedFieldValue(rawMarket['eventMetadata'], 'priceToBeat'),
      nestedEventMetadataPriceToBeat: findFirstNestedFieldValue(rawMarket['event'], 'priceToBeat') ?? findFirstNestedFieldValue(rawMarket['events'], 'priceToBeat') ?? findFirstNestedFieldValue(rawMarket, 'priceToBeat'),
      question,
      title: rawMarket['title'],
      description: rawMarket['description'],
      rules: rawMarket['rules'],
      resolutionSource: rawMarket['resolutionSource'],
      groupItemTitle: rawMarket['groupItemTitle'],
      eventTitle: nestedStringField(rawMarket['event'], 'title'),
      eventDescription: nestedStringField(rawMarket['event'], 'description'),
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

export function detectMarketDuration(rawMarket: Record<string, unknown>): DetectedMarketDuration | null {
  const timestampDuration = detectMarketDurationFromTimestamps(rawMarket);
  if (timestampDuration !== null) return timestampDuration;

  const searchableText = buildSearchableMarketText(rawMarket);
  if (/\b(15m|15\s*m|15-min|15\s*min|15\s*minute|fifteen\s*minute)\b/u.test(searchableText)) return '15m';
  if (/\b(5m|5\s*m|5-min|5\s*min|5\s*minute|five\s*minute)\b/u.test(searchableText)) return '5m';
  if (/\b(1h|1\s*h|one\s*hour|hourly|hour-long|1-hour|1\s*hour)\b/u.test(searchableText)) return '1h';
  if (/\b(4h|4\s*h|four\s*hour|four-hour|4-hour|4\s*hour)\b/u.test(searchableText)) return '4h';
  if (/\b(1d|1\s*d|daily|day-long|1-day|1\s*day|24h|24\s*h|24-hour|24\s*hour)\b/u.test(searchableText)) return '1d';
  return null;
}

export function isRequestedMarketDuration(detectedDuration: MarketDuration | null, requestedDuration: RequestedMarketDuration): boolean {
  return detectedDuration !== null && (requestedDuration === 'all' || detectedDuration === requestedDuration);
}

function isSupportedMarketDuration(detectedDuration: DetectedMarketDuration): detectedDuration is MarketDuration {
  return detectedDuration === '1h' || detectedDuration === '4h' || detectedDuration === '1d';
}

function hasUnsupportedDurationSignal(rawMarket: Record<string, unknown>): boolean {
  if (detectUnsupportedDurationFromTimestamps(rawMarket)) return true;
  return /\b(15m|15\s*m|15-min|15\s*min|15\s*minute|fifteen\s*minute|5m|5\s*m|5-min|5\s*min|5\s*minute|five\s*minute)\b/u.test(buildSearchableMarketText(rawMarket));
}

function detectMarketDurationFromTimestamps(rawMarket: Record<string, unknown>): DetectedMarketDuration | null {
  const startTimestamp = extractTime(rawMarket, ['eventStartTime', 'startTime', 'gameStartTime', 'startDate', 'startDateIso']);
  const endTimestamp = extractTime(rawMarket, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']);
  if (startTimestamp === null || endTimestamp === null) return null;
  const durationMilliseconds = endTimestamp - startTimestamp;
  const toleranceMilliseconds = 5 * 60_000;
  if (Math.abs(durationMilliseconds - 15 * 60_000) <= toleranceMilliseconds) return '15m';
  if (Math.abs(durationMilliseconds - 5 * 60_000) <= toleranceMilliseconds) return '5m';
  if (Math.abs(durationMilliseconds - 60 * 60_000) <= toleranceMilliseconds) return '1h';
  if (Math.abs(durationMilliseconds - 4 * 60 * 60_000) <= toleranceMilliseconds) return '4h';
  if (Math.abs(durationMilliseconds - 24 * 60 * 60_000) <= toleranceMilliseconds) return '1d';
  return null;
}

function detectUnsupportedDurationFromTimestamps(rawMarket: Record<string, unknown>): boolean {
  const startTimestamp = extractTime(rawMarket, ['eventStartTime', 'startTime', 'gameStartTime', 'startDate', 'startDateIso']);
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

function buildRejectedRawMarket(rawMarket: Record<string, unknown>, rawMarketFilePath: string, rejectionReason: string, detectedMarketDuration: DetectedMarketDuration | null, dataQualityFlags: string[]): RejectedMarket {
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
  const tokenIds = extractClobTokenIds(rawMarket);
  if (tokenIds.length > 0) return `tokens:${tokenIds.join('|')}`;
  return `question:${String(rawMarket['question'] ?? rawMarket['title'] ?? JSON.stringify(rawMarket))}`;
}



function withNonEnumerableDiscoveryMetadata(candidate: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(candidate)) {
    if (key.startsWith('__')) Object.defineProperty(candidate, key, { value, enumerable: false, writable: true, configurable: true });
  }
  return candidate;
}

function setPreferredDeduplicatedCandidate(deduplicated: Map<string, Record<string, unknown>>, candidate: Record<string, unknown>): void {
  const key = deduplicationKey(candidate);
  const existing = deduplicated.get(key);
  if (existing === undefined || candidateQualityScore(candidate) >= candidateQualityScore(existing)) deduplicated.set(key, candidate);
}

function candidateQualityScore(candidate: Record<string, unknown>): number {
  return (hasStringField(candidate, 'conditionId') || hasStringField(candidate, 'condition_id') ? 32 : 0)
    + (candidateHasOutcomes(candidate) ? 16 : 0)
    + (extractClobTokenIds(candidate).length > 0 ? 8 : 0)
    + (candidateHasTargetPrice(candidate) ? 4 : 0)
    + (extractTime(candidate, ['eventStartTime', 'startTime', 'gameStartTime', 'startDate', 'startDateIso']) !== null ? 2 : 0)
    + (extractTime(candidate, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime']) !== null ? 2 : 0)
    + (candidate['__hydrationSucceeded'] === true ? 1 : 0)
    - (isNonTerminalMarketTemplate(candidate) ? 64 : 0);
}

function mergeHydratedMarket(candidate: Record<string, unknown>, hydrated: Record<string, unknown>): Record<string, unknown> {
  return { ...candidate, ...Object.fromEntries(Object.entries(hydrated).filter(([, value]) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0))) };
}

function candidateHasOutcomes(candidate: Record<string, unknown>): boolean {
  try { return parseOutcomes(candidate['outcomes'] ?? candidate['shortOutcomes'] ?? []).length > 0; } catch { return false; }
}

export function candidateHasTargetPrice(candidate: Record<string, unknown>): boolean {
  return extractTargetPrice({ targetPrice: candidate['targetPrice'], target: candidate['target'], startPrice: candidate['startPrice'], initialPrice: candidate['initialPrice'], gameStartPrice: candidate['gameStartPrice'], priceToBeat: candidate['priceToBeat'], eventMetadataPriceToBeat: findFirstNestedFieldValue(candidate['eventMetadata'], 'priceToBeat'), nestedEventMetadataPriceToBeat: findFirstNestedFieldValue(candidate['event'], 'priceToBeat') ?? findFirstNestedFieldValue(candidate['events'], 'priceToBeat') ?? findFirstNestedFieldValue(candidate, 'priceToBeat'), question: candidate['question'], title: candidate['title'], description: candidate['description'], rules: candidate['rules'], resolutionSource: candidate['resolutionSource'], groupItemTitle: candidate['groupItemTitle'], eventTitle: nestedStringField(candidate['event'], 'title'), eventDescription: nestedStringField(candidate['event'], 'description') }) !== null;
}

function hasStringField(record: Record<string, unknown>, fieldName: string): boolean {
  return typeof record[fieldName] === 'string' && record[fieldName].length > 0;
}

function isNonTerminalMarketTemplate(rawMarket: Record<string, unknown>): boolean {
  if (hasStringField(rawMarket, 'conditionId') || hasStringField(rawMarket, 'condition_id') || candidateHasOutcomes(rawMarket) || extractClobTokenIds(rawMarket).length > 0) return false;
  const text = buildSearchableMarketText(rawMarket);
  return /\b(?:btc|bitcoin)\s+up\s*(?:or\s*)?\/?down\s+(?:hourly|4h|daily)\b/u.test(text);
}


function findFirstNestedFieldValue(rawValue: unknown, fieldName: string, depth = 0): string | number | null {
  if (depth > 6) return null;
  if (Array.isArray(rawValue)) {
    for (const entry of rawValue) {
      const value = findFirstNestedFieldValue(entry, fieldName, depth + 1);
      if (value !== null) return value;
    }
    return null;
  }
  if (!isRecord(rawValue)) return null;
  const directValue = rawValue[fieldName];
  if (typeof directValue === 'number' || typeof directValue === 'string') return directValue;
  for (const value of Object.values(rawValue)) {
    const nestedValue = findFirstNestedFieldValue(value, fieldName, depth + 1);
    if (nestedValue !== null) return nestedValue;
  }
  return null;
}

function nestedStringField(value: unknown, fieldName: string): string | undefined {
  if (isRecord(value) && typeof value[fieldName] === 'string') return value[fieldName];
  if (Array.isArray(value)) return value.map((entry) => nestedStringField(entry, fieldName)).find((entry): entry is string => typeof entry === 'string');
  return undefined;
}

function buildDebugQuery(source: GammaDiscoverySource, queryTerm: string, url: URL, rawItemsFetched: number, candidates: Record<string, unknown>[]): GammaDiscoveryDebugQuery {
  return {
    source,
    queryTerm,
    url: url.toString(),
    rawItemsFetched,
    candidateMarketsExtracted: candidates.length,
    locallyMatchedMarkets: candidates.filter(isBitcoinUpDownMarket).length,
    acceptedMarketsFromThisQuery: 0,
    rejectedMarketsFromThisQuery: 0,
    extractedCandidates: candidates.map((candidate) => ({
      conditionId: typeof candidate['conditionId'] === 'string' ? candidate['conditionId'] : typeof candidate['condition_id'] === 'string' ? candidate['condition_id'] : null,
      marketSlug: typeof candidate['slug'] === 'string' ? candidate['slug'] : typeof candidate['marketSlug'] === 'string' ? candidate['marketSlug'] : null,
      question: typeof candidate['question'] === 'string' ? candidate['question'] : typeof candidate['title'] === 'string' ? candidate['title'] : null,
      detectedMarketDuration: detectMarketDuration(candidate),
      endDate: timestampToIso(extractTime(candidate, ['endDate', 'endDateIso', 'closedTime', 'gameEndTime', 'eventEndTime', 'endTime'])),
      isWithinRequestedDateRange: candidate['__isWithinRequestedDateRange'] === true,
      hasOutcomes: candidateHasOutcomes(candidate),
      hasClobTokenIds: extractClobTokenIds(candidate).length > 0,
      hasTargetPriceBeforeHydration: candidate['__hasTargetPriceBeforeHydration'] === true,
      hydrationAttempted: candidate['__hydrationAttempted'] === true,
      hydrationSucceeded: candidate['__hydrationSucceeded'] === true,
      hasTargetPriceAfterHydration: candidate['__hasTargetPriceAfterHydration'] === true,
      rejectionReason: typeof candidate['__discoveryRejectionReason'] === 'string' ? candidate['__discoveryRejectionReason'] : null,
    })),
  };
}

function timestampToIso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function topLevelItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const fieldName of ['markets', 'events', 'items', 'results', 'data', 'series']) {
    const fieldValue = value[fieldName];
    if (Array.isArray(fieldValue)) return fieldValue;
  }
  return [value];
}

function extractCandidateMarkets(value: unknown): Record<string, unknown>[] {
  return deduplicateRawMarkets(extractCandidateMarketsInner(value, 0));
}

function extractCandidateMarketsInner(value: unknown, depth: number): Record<string, unknown>[] {
  if (depth > 6) return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractCandidateMarketsInner(item, depth + 1));
  if (!isRecord(value)) return [];
  const direct = looksLikeMarket(value) ? [value] : [];
  const nested = ['markets', 'market', 'events', 'event', 'items', 'results', 'data', 'series'].flatMap((fieldName) => {
    const nestedCandidates = extractCandidateMarketsInner(value[fieldName], depth + 1);
    return fieldName === 'markets' ? nestedCandidates.map((candidate) => enrichNestedMarketWithParentContext(candidate, value)) : nestedCandidates;
  });
  return [...direct, ...nested];
}

function enrichNestedMarketWithParentContext(nestedMarket: Record<string, unknown>, parent: Record<string, unknown>): Record<string, unknown> {
  return {
    ...nestedMarket,
    eventMetadata: nestedMarket['eventMetadata'] ?? parent['eventMetadata'],
    parentEventMetadata: parent['eventMetadata'],
    eventTitle: parent['title'],
    eventDescription: parent['description'],
    eventStartTime: nestedMarket['eventStartTime'] ?? parent['startTime'] ?? parent['eventStartTime'],
    eventEndTime: nestedMarket['eventEndTime'] ?? parent['endDate'] ?? parent['endTime'],
  };
}

function looksLikeMarket(record: Record<string, unknown>): boolean {
  return (typeof record['question'] === 'string' || typeof record['title'] === 'string') && (typeof record['slug'] === 'string' || typeof record['marketSlug'] === 'string' || typeof record['conditionId'] === 'string' || typeof record['condition_id'] === 'string');
}

function deduplicateRawMarkets(markets: Record<string, unknown>[]): Record<string, unknown>[] {
  const deduplicated = new Map<string, Record<string, unknown>>();
  for (const market of markets) deduplicated.set(deduplicationKey(market), market);
  return [...deduplicated.values()];
}

function normalizedDeduplicationKey(conditionId: string | null, marketSlug: string | null, question: string | null): string {
  if (conditionId !== null && conditionId.length > 0) return `condition:${conditionId}`;
  if (marketSlug !== null && marketSlug.length > 0) return `slug:${marketSlug}`;
  return `question:${String(question ?? '')}`;
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

export function extractClobTokenIds(rawMarket: Record<string, unknown>): string[] {
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

export function extractTime(rawMarket: Record<string, unknown>, fieldNames: string[]): number | null {
  return extractTimeFromValue(rawMarket, fieldNames, 0);
}

export function extractTimeFromValue(value: unknown, fieldNames: string[], depth: number): number | null {
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
