import { describe, expect, it } from "vitest";
import {
  buildDateBasedBitcoinUpDownSearchTerms,
  buildDiscoverySearchPlan,
  PolymarketGammaApiAdapter,
} from "../../src/adapters/polymarketGammaApi.js";
import {
  buildDiscoveryAudit,
  buildExpectedHourlyWindows,
} from "../../src/application/collectorUseCases.js";

const baseMarket = {
  question: "Bitcoin Up or Down - May 1, 9PM ET",
  slug: "bitcoin-up-or-down-may-1-9pm-et",
  conditionId: "condition-1",
  startDate: "2026-05-02T00:00:00.000Z",
  endDate: "2026-05-02T01:00:00.000Z",
  outcomes: ["Up", "Down"],
  outcomePrices: ["1", "0"],
  clobTokenIds: ["up-token", "down-token"],
  targetPrice: 100,
  closed: true,
  resolved: true,
};

describe("discovery completeness audit", () => {
  it("date range 2026-05-02 UTC generates relevant ET hourly search windows", () => {
    const terms = buildDateBasedBitcoinUpDownSearchTerms(
      "2026-05-02",
      "2026-05-03",
      "all",
    );
    expect(terms).toContain("Bitcoin Up or Down - May 1, 8PM ET");
    expect(terms).toContain("Bitcoin Up or Down - May 1, 9PM ET");
    expect(terms).toContain("Bitcoin Up or Down - May 2, 12AM ET");
    expect(terms).toContain("Bitcoin Up or Down - May 2, 7PM ET");
    expect(terms).toContain("Bitcoin Up or Down - May 2");
  });

  it("orders date-based search terms before generic duration terms", () => {
    const plan = buildDiscoverySearchPlan(
      "2026-05-02",
      "2026-05-03",
      "all",
      false,
    );
    const firstGenericIndex = plan.findIndex(
      (entry) => entry.kind === "generic",
    );
    const lastDateIndex = plan
      .map((entry) => entry.kind)
      .lastIndexOf("date-based");
    expect(firstGenericIndex).toBeGreaterThan(0);
    expect(lastDateIndex).toBeLessThan(firstGenericIndex);
    expect(plan[0]?.searchTerm).toMatch(/^Bitcoin Up or Down -/u);
  });

  it("date-based exact search uses fewer pages and narrower sources than generic search", () => {
    const plan = buildDiscoverySearchPlan(
      "2026-05-02",
      "2026-05-03",
      "all",
      false,
    );
    const dateBased = plan.find((entry) => entry.kind === "date-based");
    const generic = plan.find((entry) => entry.kind === "generic");
    expect(dateBased?.maxPagesPerQuery).toBe(1);
    expect(generic?.maxPagesPerQuery).toBeGreaterThan(
      dateBased?.maxPagesPerQuery ?? 0,
    );
    expect(dateBased?.sources).toEqual(["public-search", "markets"]);
    expect(generic?.sources).toContain("series");
  });

  it("obvious 5m and 15m candidates are rejected without hydration when metadata is enough", async () => {
    let hydrationRequests = 0;
    const fiveMinute = {
      ...baseMarket,
      question: "Bitcoin Up or Down - May 1, 9:00PM-9:05PM ET",
      slug: "bitcoin-up-or-down-5m",
      conditionId: "condition-5m",
      startDate: "2026-05-02T01:00:00.000Z",
      endDate: "2026-05-02T01:05:00.000Z",
      outcomes: [],
      clobTokenIds: [],
      targetPrice: undefined,
    };
    const fifteenMinute = {
      ...baseMarket,
      question: "Bitcoin Up or Down - May 1, 9:00PM-9:15PM ET",
      slug: "bitcoin-up-or-down-15m",
      conditionId: "condition-15m",
      startDate: "2026-05-02T01:00:00.000Z",
      endDate: "2026-05-02T01:15:00.000Z",
      outcomes: [],
      clobTokenIds: [],
      targetPrice: undefined,
    };
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>(url: URL) {
        if (
          url.pathname.startsWith("/markets/") ||
          url.searchParams.has("slug") ||
          url.searchParams.has("condition_id")
        )
          hydrationRequests += 1;
        return [fiveMinute, fifteenMinute] as T;
      },
    });
    const markets = await adapter.discoverBitcoinUpDownMarkets(
      "2026-05-02",
      "2026-05-03",
      {
        requestedMarketDuration: "all",
        discoveryMaxTotalRequests: 1,
        discoveryMaxPagesPerQuery: 1,
      },
    );
    const result = adapter.parseMarkets(markets, "raw.json", "all");
    expect(hydrationRequests).toBe(0);
    expect(
      result.rejectedMarkets.map((market) => market.rejectionReason),
    ).toEqual(["unsupported_duration", "unsupported_duration"]);
    expect(adapter.getLastDiscoveryDebug()?.hydrationAttempted).toBe(0);
  });

  it("audit insideDateRangeMarkets dedupes by slug and accepted version wins", () => {
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>() {
        return [] as T;
      },
    });
    const acceptedResult = adapter.parseMarkets(
      [baseMarket],
      "raw.json",
      "all",
    );
    const rejected = {
      ...baseMarket,
      conditionId: undefined,
      slug: baseMarket.slug,
      outcomes: ["Yes", "No"],
      condition_id: undefined,
    };
    const rejectedResult = adapter.parseMarkets([rejected], "raw.json", "all");
    const audit = buildDiscoveryAudit(
      { startDate: "2026-05-02", endDate: "2026-05-03", marketDuration: "all" },
      [baseMarket, rejected],
      {
        acceptedMarkets: acceptedResult.acceptedMarkets,
        rejectedMarkets: rejectedResult.rejectedMarkets,
      },
    );
    const inside = audit.insideDateRangeMarkets as Record<string, unknown>[];
    expect(inside).toHaveLength(1);
    expect(inside[0]?.marketSlug).toBe(baseMarket.slug);
    expect(inside[0]?.rejectionReason).toBeNull();
  });

  it("stopReason timeout is included in discovery audit", () => {
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>() {
        return [] as T;
      },
    });
    const result = adapter.parseMarkets([], "raw.json", "all");
    const audit = buildDiscoveryAudit(
      { startDate: "2026-05-02", endDate: "2026-05-03", marketDuration: "all" },
      [],
      result,
      {
        candidateMarketsFetched: 0,
        deduplicatedCandidateMarkets: 0,
        rejectedByReason: {},
        acceptedByDuration: {},
        stopReason: "timeout",
        searchedDateBasedTermsCount: 3,
        searchedGenericTermsCount: 0,
        stoppedBeforeDateBasedSearchCompleted: true,
        stoppedBeforeGenericSearchCompleted: false,
      },
    );
    expect(audit.stopReason).toBe("timeout");
    expect(audit.stoppedBeforeDateBasedSearchCompleted).toBe(true);
  });

  it("accepted 1h market with endDate inside range is counted and audit contains inside summaries", () => {
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>() {
        return [] as T;
      },
    });
    const result = adapter.parseMarkets([baseMarket], "raw.json", "all");
    const audit = buildDiscoveryAudit(
      { startDate: "2026-05-02", endDate: "2026-05-03", marketDuration: "all" },
      [baseMarket],
      result,
    );
    expect(result.acceptedMarkets).toHaveLength(1);
    expect((audit.acceptedByDuration as Record<string, number>)["1h"]).toBe(1);
    expect(
      (audit.insideDateRangeByDuration as Record<string, number>)["1h"],
    ).toBe(1);
    expect(audit.insideDateRangeMarkets as unknown[]).toHaveLength(1);
  });

  it("outside date candidates are not counted as missing accepted hourly windows", () => {
    const outside = {
      ...baseMarket,
      conditionId: "condition-outside",
      slug: "outside",
      endDate: "2026-05-01T01:00:00.000Z",
    };
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>() {
        return [] as T;
      },
    });
    const result = adapter.parseMarkets([outside], "raw.json", "all");
    const audit = buildDiscoveryAudit(
      { startDate: "2026-05-02", endDate: "2026-05-03", marketDuration: "all" },
      [outside],
      result,
    );
    expect(audit.candidatesInsideRequestedDateRange).toBe(0);
    expect(audit.missingHourlyWindows as unknown[]).toEqual(
      buildExpectedHourlyWindows("2026-05-02", "2026-05-03"),
    );
  });

  it("duplicate market from multiple queries is deduped by conditionId", async () => {
    const adapter = new PolymarketGammaApiAdapter({
      async getJson<T>() {
        return [
          { ...baseMarket },
          {
            ...baseMarket,
            question: "Bitcoin Up or Down - May 1, 9PM ET duplicate",
          },
        ] as T;
      },
    });
    const markets = await adapter.discoverBitcoinUpDownMarkets(
      "2026-05-02",
      "2026-05-03",
      {
        requestedMarketDuration: "all",
        discoveryMaxTotalRequests: 1,
        discoveryMaxPagesPerQuery: 1,
      },
    );
    expect(markets).toHaveLength(1);
  });
});
