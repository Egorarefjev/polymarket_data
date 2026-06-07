import { Command } from 'commander';
import { FileStorage } from '../adapters/fileStorage.js';
import { PublicHttpClient } from '../adapters/httpClient.js';
import { createCollectorLogger } from '../adapters/logger.js';
import { PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import { BinanceArchiveApiAdapter, type BinanceDataType, type BinanceMarketType } from '../adapters/binanceArchiveApi.js';
import { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { CollectorUseCases, type CollectorOptions } from '../application/collectorUseCases.js';
import type { RequestedMarketDuration } from '../core/domain.js';
import { ChainlinkLocalFilePriceSource } from '../adapters/externalPriceSource.js';

const program = new Command();
program.name('polymarket-btc-up-down-collector').description('Public historical data collector for BTC Up/Down 1h/4h/1d Polymarket markets');

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
    .option('--write-debug-json <trueOrFalse>', 'Write large debug JSON mirrors for small sample runs only', 'false');
}

function buildUseCases(options: CollectorOptions): CollectorUseCases {
  const fileStorage = new FileStorage('data');
  const httpClient = new PublicHttpClient({ requestDelayMilliseconds: options.requestDelayMilliseconds, maximumRetries: 4 });
  const logger = createCollectorLogger();
  return new CollectorUseCases(
    fileStorage,
    new LocalParquetWriter(),
    new PolymarketGammaApiAdapter(httpClient),
    new PolymarketClobApiAdapter(httpClient),
    new BinanceArchiveApiAdapter(httpClient),
    logger,
    options.chainlinkInputFile === undefined ? undefined : new ChainlinkLocalFilePriceSource(options.chainlinkInputFile),
  );
}

export function parseOptions(rawOptions: Record<string, unknown>): CollectorOptions {
  const { startDate, endDate } = parseDateRangeOptions(rawOptions);
  const priceFidelityMinutes = Number(rawOptions['priceFidelityMinutes']);
  if (!Number.isFinite(priceFidelityMinutes) || priceFidelityMinutes < 1) throw new Error('--price-fidelity-minutes must be a number greater than or equal to 1');
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
  const chainlinkInputFile = rawOptions['chainlinkInputFile'] === undefined ? undefined : String(rawOptions['chainlinkInputFile']);
  const options: CollectorOptions = {
    startDate,
    endDate,
    symbol: String(rawOptions['symbol']),
    priceFidelityMinutes,
    marketDuration,
    force: Boolean(rawOptions['force']),
    requestDelayMilliseconds: Number(rawOptions['requestDelayMilliseconds']),
    maximumConcurrentRequests: Number(rawOptions['maximumConcurrentRequests']),
    binanceMarketType,
    binanceDataType,
    primaryPriceSource: 'chainlink',
    includeBinanceSecondarySignal,
    allowProxyPrimaryPriceSourceForDebug,
    writeDebugJson,
  };
  if (chainlinkInputFile !== undefined) options.chainlinkInputFile = chainlinkInputFile;
  return options;
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

function registerCommand(commandName: string, action: (useCases: CollectorUseCases, options: CollectorOptions) => Promise<unknown>): void {
  addSharedOptions(program.command(commandName)).action(async (rawOptions: Record<string, unknown>) => {
    const options = parseOptions(rawOptions);
    await action(buildUseCases(options), options);
  });
}

registerCommand('discover', (useCases, options) => useCases.discoverMarkets(options));
registerCommand('download-polymarket-prices', (useCases, options) => useCases.downloadPolymarketPrices(options));
registerCommand('download-polymarket-trades', (useCases, options) => useCases.downloadPolymarketTrades(options));
registerCommand('download-binance', (useCases, options) => useCases.downloadBinance(options));
registerCommand('build-dataset', (useCases, options) => useCases.buildDataset(options));
registerCommand('summarize', (useCases, options) => useCases.summarizeMarkets(options));
registerCommand('all', (useCases, options) => useCases.runFullPipeline(options));

if (import.meta.url === `file://${process.argv[1]}`) {
  await program.parseAsync(process.argv);
}
