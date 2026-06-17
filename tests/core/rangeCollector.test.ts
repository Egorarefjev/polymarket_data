import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorage } from "../../src/adapters/fileStorage.js";
import {
  CollectorUseCases,
  acceptedMarketsRelativeFilePath,
  collectionSummaryRelativeFilePath,
  rejectedMarketsRelativeFilePath,
  type CollectionDaySummary,
  type CollectorOptions,
} from "../../src/application/collectorUseCases.js";
import type {
  NormalizedMarket,
  RejectedMarket,
} from "../../src/core/domain.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function options(): CollectorOptions {
  return {
    startDate: "2026-05-01",
    endDate: "2026-05-04",
    priceFidelityMinutes: 1,
    marketDuration: "all",
    force: true,
    requestDelayMilliseconds: 0,
    maximumConcurrentRequests: 1,
    writeDebugJson: false,
    allowBroadGammaDateScan: false,
    allowEmptyMarketSet: false,
    discoveryTimeoutSeconds: 1,
    discoveryMaxPagesPerQuery: 1,
    discoveryMaxTotalRequests: 1,
    discoveryMaxCandidates: 1,
    discoveryRequestTimeoutSeconds: 1,
    discoveryExpandedSearch: false,
  };
}

function accepted(date: string): NormalizedMarket {
  return {
    marketSlug: `market-${date}`,
    conditionId: "condition",
    question: "Bitcoin Up or Down",
    marketDuration: "1h",
    marketStartTimestampMilliseconds: Date.parse(`${date}T00:00:00.000Z`),
    marketEndTimestampMilliseconds: Date.parse(`${date}T01:00:00.000Z`),
    upTokenId: "up",
    downTokenId: "down",
    targetPrice: 1,
    winner: "up",
    isResolved: true,
    isClosed: true,
    rawOutcomes: '["Up","Down"]',
    rawOutcomePrices: '["1","0"]',
    dataQualityFlags: [],
  };
}

async function createUseCases(): Promise<{
  storage: FileStorage;
  useCases: CollectorUseCases;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pm-range-"));
  tempDirs.push(directory);
  const storage = new FileStorage(directory);
  const useCases = new CollectorUseCases(
    storage,
    { writeRows: async () => undefined } as never,
    {} as never,
    {} as never,
    { info: () => undefined, error: () => undefined } as never,
  );
  return { storage, useCases };
}

async function writeDayFiles(
  storage: FileStorage,
  dayOptions: CollectorOptions,
  acceptedMarkets: NormalizedMarket[],
  rejectedMarkets: RejectedMarket[] = [],
): Promise<void> {
  await storage.writeJsonLines(
    acceptedMarketsRelativeFilePath(dayOptions),
    acceptedMarkets,
    true,
  );
  await storage.writeJsonLines(
    rejectedMarketsRelativeFilePath(dayOptions),
    rejectedMarkets,
    true,
  );
}

describe("range collector", () => {
  it("range calls daily pipeline once per day", async () => {
    const { storage, useCases } = await createUseCases();
    const calledDates: string[] = [];
    useCases.runFullPipeline = async (
      dayOptions,
    ): Promise<CollectionDaySummary> => {
      calledDates.push(dayOptions.startDate);
      await writeDayFiles(storage, dayOptions, [
        accepted(dayOptions.startDate),
      ]);
      return {
        date: dayOptions.startDate,
        acceptedMarkets: 1,
        rejectedMarkets: 0,
        pricePointsBuilt: 2,
        strategyTrainingRowsBuilt: 2,
        marketSummaryRowsBuilt: 1,
        status: "succeeded",
      };
    };

    await useCases.runRangePipeline(options());

    expect(calledDates).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
  });

  it("zero-market day does not fail range", async () => {
    const { storage, useCases } = await createUseCases();
    useCases.runFullPipeline = async (
      dayOptions,
    ): Promise<CollectionDaySummary> => {
      await writeDayFiles(storage, dayOptions, []);
      return {
        date: dayOptions.startDate,
        acceptedMarkets: 0,
        rejectedMarkets: 0,
        pricePointsBuilt: 0,
        strategyTrainingRowsBuilt: 0,
        marketSummaryRowsBuilt: 0,
        status: "succeeded",
      };
    };

    const summary = await useCases.runRangePipeline({
      ...options(),
      endDate: "2026-05-02",
    });

    expect(summary.daysSucceeded).toBe(1);
    expect(summary.daysWithZeroAcceptedMarkets).toEqual(["2026-05-01"]);
    expect(summary.daysWithErrors).toEqual([]);
  });

  it("failed day is recorded in summary and range continues", async () => {
    const { storage, useCases } = await createUseCases();
    const calledDates: string[] = [];
    useCases.runFullPipeline = async (
      dayOptions,
    ): Promise<CollectionDaySummary> => {
      calledDates.push(dayOptions.startDate);
      if (dayOptions.startDate === "2026-05-02")
        throw new Error("Gamma unavailable");
      await writeDayFiles(storage, dayOptions, [
        accepted(dayOptions.startDate),
      ]);
      return {
        date: dayOptions.startDate,
        acceptedMarkets: 1,
        rejectedMarkets: 0,
        pricePointsBuilt: 3,
        strategyTrainingRowsBuilt: 3,
        marketSummaryRowsBuilt: 1,
        status: "succeeded",
      };
    };

    const summary = await useCases.runRangePipeline(options());
    const writtenSummary = await storage.readJson<unknown>(
      collectionSummaryRelativeFilePath(options()),
    );

    expect(calledDates).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
    expect(summary.daysWithErrors).toEqual(["2026-05-02"]);
    expect(
      summary.perDay.find((day) => day.date === "2026-05-02"),
    ).toMatchObject({ status: "failed", errorMessage: "Gamma unavailable" });
    expect(writtenSummary).toMatchObject({
      daysProcessed: 3,
      daysSucceeded: 2,
      totalAcceptedMarkets: 2,
      totalPricePointsBuilt: 6,
    });
  });
});
