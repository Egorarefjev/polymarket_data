import { Command } from 'commander';
import type { BinanceDataType, BinanceMarketType } from '../adapters/binanceArchiveApi.js';
import type { CollectorOptions, CollectorUseCases } from '../application/collectorUseCases.js';
import type { RequestedMarketDuration } from '../core/domain.js';
import { formatCliError } from './formatCliError.js';

export interface CollectorCliLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface CollectorCliDependencies {
  createCollectorUseCases: (options: CollectorOptions) => CollectorUseCases;
  ensureBaseDirectories: () => Promise<void>;
  logger?: CollectorCliLogger;
}

const defaultCliLogger: CollectorCliLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

export function createCollectorProgram(dependencies: CollectorCliDependencies): Command {
  const logger = dependencies.logger ?? defaultCliLogger;
  const program = new Command();
  program
    .name('polymarket-btc-up-down-collector')
    .description('Public historical data collector for BTC Up/Down 1h/4h/1d Polymarket markets')
    .exitOverride();

  const runCommandAction = async (commandName: string, rawOptions: unknown, action: (options: CollectorOptions) => Promise<void>): Promise<void> => {
    let options: CollectorOptions | undefined;
    try {
      options = parseOptions(asRawOptionsRecord(rawOptions));
      await dependencies.ensureBaseDirectories();
      logCommandStart(logger, commandName, options);
      await action(options);
      logger.info(`Finished command: ${commandName}`);
    } catch (error) {
      logger.error(`Failed command: ${commandName}`);
      logger.error(formatCliError(error));
      throw error;
    }
  };

  registerUseCaseCommand(program, dependencies, runCommandAction, 'discover', (useCases, options) => useCases.discoverMarkets(options));
  registerUseCaseCommand(program, dependencies, runCommandAction, 'download-polymarket-prices', (useCases, options) => useCases.downloadPolymarketPrices(options));
  registerUseCaseCommand(program, dependencies, runCommandAction, 'download-polymarket-trades', (useCases, options) => useCases.downloadPolymarketTrades(options));
  registerUseCaseCommand(program, dependencies, runCommandAction, 'download-binance', (useCases, options) => useCases.downloadBinance(options));
  registerUseCaseCommand(program, dependencies, runCommandAction, 'build-dataset', (useCases, options) => useCases.buildDataset(options));
  registerUseCaseCommand(program, dependencies, runCommandAction, 'summarize', (useCases, options) => useCases.summarizeMarkets(options));
  registerUseCaseCommand(program, dependencies, runCommandAction, 'all', (useCases, options) => useCases.runFullPipeline(options));

  program.command('doctor').description('Run a local collector CLI smoke test without external API requests').action(async () => {
    await runDoctorAction(dependencies, logger);
  });

  return program;
}

export function parseOptions(rawOptions: Record<string, unknown>): CollectorOptions {
  const { startDate, endDate } = parseDateRangeOptions(rawOptions);
  const priceFidelityMinutes = Number(rawOptions['priceFidelityMinutes']);
  if (!Number.isFinite(priceFidelityMinutes) || priceFidelityMinutes < 1) throw new Error('--price-fidelity-minutes must be a number greater than or equal to 1');
  const requestDelayMilliseconds = Number(rawOptions['requestDelayMilliseconds']);
  if (!Number.isFinite(requestDelayMilliseconds) || requestDelayMilliseconds < 0) throw new Error('--request-delay-milliseconds must be a number greater than or equal to 0');
  const maximumConcurrentRequests = Number(rawOptions['maximumConcurrentRequests']);
  if (!Number.isFinite(maximumConcurrentRequests) || maximumConcurrentRequests < 1) throw new Error('--maximum-concurrent-requests must be a number greater than or equal to 1');
  const binanceMarketType = String(rawOptions['binanceMarketType']) as BinanceMarketType;
  const binanceDataType = String(rawOptions['binanceDataType']) as BinanceDataType;
  if (!['spot', 'futures'].includes(binanceMarketType)) throw new Error('--binance-market-type must be spot or futures');
  if (!['aggTrades', 'klines'].includes(binanceDataType)) throw new Error('--binance-data-type must be aggTrades or klines');
  if (String(rawOptions['primaryPriceSource']) !== 'chainlink') throw new Error('--primary-price-source must be chainlink');
  const marketDuration = String(rawOptions['marketDuration']) as RequestedMarketDuration;
  if (!['1h', '4h', '1d', 'all'].includes(marketDuration)) throw new Error('--market-duration must be one of: 1h, 4h, 1d, all');
  const includeBinanceSecondarySignal = String(rawOptions['includeBinanceSecondarySignal']).toLowerCase() !== 'false';
  const allowProxyPrimaryPriceSourceForDebug = String(rawOptions['allowProxyPrimaryPriceSourceForDebug']).toLowerCase() === 'true';
  const writeDebugJson = String(rawOptions['writeDebugJson']).toLowerCase() === 'true';
  const allowBroadGammaDateScan = String(rawOptions['allowBroadGammaDateScan']).toLowerCase() === 'true';
  const allowEmptyMarketSet = String(rawOptions['allowEmptyMarketSet']).toLowerCase() === 'true';
  const chainlinkInputFile = rawOptions['chainlinkInputFile'] === undefined ? undefined : String(rawOptions['chainlinkInputFile']);
  const options: CollectorOptions = {
    startDate,
    endDate,
    symbol: String(rawOptions['symbol']),
    priceFidelityMinutes,
    marketDuration,
    force: Boolean(rawOptions['force']),
    requestDelayMilliseconds,
    maximumConcurrentRequests,
    binanceMarketType,
    binanceDataType,
    primaryPriceSource: 'chainlink',
    includeBinanceSecondarySignal,
    allowProxyPrimaryPriceSourceForDebug,
    writeDebugJson,
    allowBroadGammaDateScan,
    allowEmptyMarketSet,
  };
  if (chainlinkInputFile !== undefined) options.chainlinkInputFile = chainlinkInputFile;
  return options;
}

function registerUseCaseCommand(
  program: Command,
  dependencies: CollectorCliDependencies,
  runCommandAction: (commandName: string, rawOptions: unknown, action: (options: CollectorOptions) => Promise<void>) => Promise<void>,
  commandName: string,
  action: (useCases: CollectorUseCases, options: CollectorOptions) => Promise<unknown>,
): void {
  addSharedOptions(program.command(commandName)).action(async (rawOptions: unknown) => {
    await runCommandAction(commandName, rawOptions, async (options) => {
      await action(dependencies.createCollectorUseCases(options), options);
    });
  });
}

function addSharedOptions(command: Command): Command {
  return command
    .option('--date <date>', 'Single UTC day shorthand; sets start date to date and exclusive end date to date + 1 day')
    .option('--start-date <date>', 'UTC start date, inclusive')
    .option('--end-date <date>', 'UTC end date, exclusive')
    .option('--symbol <symbol>', 'Binance symbol', 'BTCUSDT')
    .option('--price-fidelity-minutes <minutes>', 'Polymarket prices-history fidelity in minutes (API minutes, not seconds)', '1')
    .option('--market-duration <duration>', 'Market duration to collect: 1h, 4h, 1d, or all', '1h')
    .option('--chainlink-input-file <path>', 'Local Chainlink BTC/USD Data Stream historical CSV, JSON, or JSONL input file')
    .option('--allow-proxy-primary-price-source-for-debug <trueOrFalse>', 'Use Binance as non-official primary proxy only for pipeline debugging', 'false')
    .option('--force', 'Overwrite existing raw files and rerun completed steps', false)
    .option('--request-delay-milliseconds <milliseconds>', 'Delay between public HTTP requests', '200')
    .option('--maximum-concurrent-requests <count>', 'Maximum concurrent public requests', '4')
    .option('--binance-market-type <type>', 'spot or futures', 'spot')
    .option('--binance-data-type <type>', 'aggTrades or klines', 'klines')
    .option('--primary-price-source <source>', 'Primary analytical price source: chainlink', 'chainlink')
    .option('--include-binance-secondary-signal <trueOrFalse>', 'Include Binance as optional secondary predictive signal', 'false')
    .option('--write-debug-json <trueOrFalse>', 'Write large debug JSON mirrors for small sample runs only', 'false')
    .option('--allow-broad-gamma-date-scan <trueOrFalse>', 'Debug only: allow broad Gamma date scan fallback when query discovery returns zero candidates', 'false')
    .option('--allow-empty-market-set <trueOrFalse>', 'Debug only: continue all pipeline when discovery accepts zero markets', 'false');
}

async function runDoctorAction(dependencies: CollectorCliDependencies, logger: CollectorCliLogger): Promise<void> {
  const commandName = 'doctor';
  try {
    await dependencies.ensureBaseDirectories();
    logger.info(`Starting command: ${commandName}`);
    logger.info(`Node version: ${process.version}`);
    logger.info(`Platform: ${process.platform}`);
    logger.info('Data directories: ok');
    parseOptions(defaultDoctorOptions());
    logger.info('Options parse: ok');
    logger.info('CLI execution: ok');
    logger.info(`Finished command: ${commandName}`);
  } catch (error) {
    logger.error(`Failed command: ${commandName}`);
    logger.error(formatCliError(error));
    throw error;
  }
}

function logCommandStart(logger: CollectorCliLogger, commandName: string, options: CollectorOptions): void {
  logger.info(`Starting command: ${commandName}`);
  logger.info(`Date range: ${options.startDate} to ${options.endDate}`);
  logger.info(`Market duration: ${options.marketDuration}`);
  logger.info(`Primary price mode: ${primaryPriceMode(options)}`);
  logger.info(`Output duration key: ${options.marketDuration}`);
}

function primaryPriceMode(options: CollectorOptions): 'official_chainlink' | 'binance_proxy_debug' | 'not_applicable' {
  if (options.allowProxyPrimaryPriceSourceForDebug) return 'binance_proxy_debug';
  if (options.primaryPriceSource === 'chainlink') return 'official_chainlink';
  return 'not_applicable';
}

function parseDateRangeOptions(rawOptions: Record<string, unknown>): { startDate: string; endDate: string } {
  const date = rawOptions['date'] === undefined ? undefined : String(rawOptions['date']);
  const startDate = rawOptions['startDate'] === undefined ? undefined : String(rawOptions['startDate']);
  const endDate = rawOptions['endDate'] === undefined ? undefined : String(rawOptions['endDate']);
  if (date !== undefined && (startDate !== undefined || endDate !== undefined)) throw new Error('--date cannot be combined with --start-date or --end-date');
  if (date !== undefined) return { startDate: date, endDate: addOneUtcDay(date) };
  if (startDate === undefined || endDate === undefined) throw new Error('Either --date or both --start-date and --end-date are required');
  return { startDate, endDate };
}

function addOneUtcDay(date: string): string {
  const timestampMilliseconds = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(timestampMilliseconds)) throw new Error('--date must be YYYY-MM-DD');
  return new Date(timestampMilliseconds + 86_400_000).toISOString().slice(0, 10);
}

function defaultDoctorOptions(): Record<string, unknown> {
  return {
    date: '2026-01-01',
    symbol: 'BTCUSDT',
    priceFidelityMinutes: '1',
    marketDuration: '1h',
    force: false,
    requestDelayMilliseconds: '200',
    maximumConcurrentRequests: '4',
    binanceMarketType: 'spot',
    binanceDataType: 'klines',
    primaryPriceSource: 'chainlink',
    includeBinanceSecondarySignal: 'false',
    allowProxyPrimaryPriceSourceForDebug: 'false',
    writeDebugJson: 'false',
    allowBroadGammaDateScan: 'false',
    allowEmptyMarketSet: 'false',
  };
}

function asRawOptionsRecord(rawOptions: unknown): Record<string, unknown> {
  if (rawOptions === null || typeof rawOptions !== 'object') return {};
  return rawOptions as Record<string, unknown>;
}
