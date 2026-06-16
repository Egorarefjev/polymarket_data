import { FileStorage, ensureBaseDataDirectories } from '../adapters/fileStorage.js';
import { PublicHttpClient } from '../adapters/httpClient.js';
import { createCollectorLogger } from '../adapters/logger.js';
import { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import { PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import { CollectorUseCases, type CollectorOptions } from '../application/collectorUseCases.js';
import { createCollectorProgram, type CollectorCliDependencies } from './createCollectorProgram.js';
import { formatCliError } from './formatCliError.js';

const reportedCliErrors = new WeakSet<object>();

export async function runCollectorCli(argv: string[], dependencies: Partial<CollectorCliDependencies> = {}): Promise<void> {
  const logger = dependencies.logger ?? {
    info: (message: string) => console.log(message),
    error: (message: string) => console.error(message),
  };
  const resolvedDependencies: CollectorCliDependencies = {
    createCollectorUseCases: dependencies.createCollectorUseCases ?? createDefaultCollectorUseCases,
    ensureBaseDirectories: dependencies.ensureBaseDirectories ?? (() => ensureBaseDataDirectories('data')),
    logger,
  };

  try {
    const program = createCollectorProgram(resolvedDependencies);
    await program.parseAsync(argv, { from: 'node' });
  } catch (error) {
    if (isSuccessfulCommanderTermination(error)) return;
    if (!isErrorAlreadyReported(error)) {
      logger.error(formatCliError(error));
      markErrorAsReported(error);
    }
    throw error;
  }
}

export function isCliErrorAlreadyReported(error: unknown): boolean {
  return isErrorAlreadyReported(error);
}

export function markCliErrorAsReported(error: unknown): void {
  markErrorAsReported(error);
}

function isSuccessfulCommanderTermination(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const maybeCommanderError = error as { code?: unknown; exitCode?: unknown };
  return maybeCommanderError.code === 'commander.helpDisplayed' && maybeCommanderError.exitCode === 0;
}

function createDefaultCollectorUseCases(options: CollectorOptions): CollectorUseCases {
  const fileStorage = new FileStorage('data');
  const httpClient = new PublicHttpClient({ requestDelayMilliseconds: options.requestDelayMilliseconds, maximumRetries: 4 });
  const logger = createCollectorLogger();
  return new CollectorUseCases(
    fileStorage,
    new LocalParquetWriter(),
    new PolymarketGammaApiAdapter(httpClient),
    new PolymarketClobApiAdapter(httpClient),
    logger,
  );
}

function isErrorAlreadyReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reportedCliErrors.has(error);
}

function markErrorAsReported(error: unknown): void {
  if (typeof error === 'object' && error !== null) reportedCliErrors.add(error);
}
