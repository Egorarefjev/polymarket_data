import { Command } from 'commander';
import { FileStorage } from '../adapters/fileStorage.js';
import { PublicHttpClient } from '../adapters/httpClient.js';
import { createCollectorLogger } from '../adapters/logger.js';
import { PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import { BinanceArchiveApiAdapter, type BinanceDataType, type BinanceMarketType } from '../adapters/binanceArchiveApi.js';
import { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { CollectorUseCases, type CollectorOptions } from '../application/collectorUseCases.js';
import { ChainlinkLocalFilePriceSource } from '../adapters/externalPriceSource.js';

const program = new Command();
program.name('polymarket-btc-up-down-collector').description('Public historical data collector for BTC Up/Down 5-minute Polymarket markets');

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption('--start-date <date>')
    .requiredOption('--end-date <date>')
    .option('--symbol <symbol>', 'Binance symbol', 'BTCUSDT')
    .option('--price-fidelity-minutes <minutes>', 'Polymarket prices-history fidelity in minutes (API minutes, not seconds)', '1')
    .option('--chainlink-input-file <path>', 'Local Chainlink BTC/USD Data Stream historical CSV, JSON, or JSONL input file')
    .option('--allow-proxy-primary-price-source-for-debug <trueOrFalse>', 'Use Binance as non-official primary proxy only for pipeline debugging', 'false')
    .option('--force', 'Overwrite existing raw files and rerun completed steps', false)
    .option('--request-delay-milliseconds <milliseconds>', 'Delay between public HTTP requests', '200')
    .option('--maximum-concurrent-requests <count>', 'Maximum concurrent public requests', '4')
    .option('--binance-market-type <type>', 'spot or futures', 'spot')
    .option('--binance-data-type <type>', 'aggTrades or klines', 'aggTrades')
    .option('--primary-price-source <source>', 'Primary analytical price source: chainlink', 'chainlink')
    .option('--include-binance-secondary-signal <trueOrFalse>', 'Include Binance as optional secondary predictive signal', 'true')
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

function parseOptions(rawOptions: Record<string, unknown>): CollectorOptions {
  const priceFidelityMinutes = Number(rawOptions['priceFidelityMinutes']);
  if (!Number.isFinite(priceFidelityMinutes) || priceFidelityMinutes < 1) throw new Error('--price-fidelity-minutes must be a number greater than or equal to 1');
  const binanceMarketType = String(rawOptions['binanceMarketType']) as BinanceMarketType;
  const binanceDataType = String(rawOptions['binanceDataType']) as BinanceDataType;
  if (!['spot', 'futures'].includes(binanceMarketType)) throw new Error('--binance-market-type must be spot or futures');
  if (!['aggTrades', 'klines'].includes(binanceDataType)) throw new Error('--binance-data-type must be aggTrades or klines');
  if (String(rawOptions['primaryPriceSource']) !== 'chainlink') throw new Error('--primary-price-source must be chainlink');
  const includeBinanceSecondarySignal = String(rawOptions['includeBinanceSecondarySignal']).toLowerCase() !== 'false';
  const allowProxyPrimaryPriceSourceForDebug = String(rawOptions['allowProxyPrimaryPriceSourceForDebug']).toLowerCase() === 'true';
  const writeDebugJson = String(rawOptions['writeDebugJson']).toLowerCase() === 'true';
  const chainlinkInputFile = rawOptions['chainlinkInputFile'] === undefined ? undefined : String(rawOptions['chainlinkInputFile']);
  const options: CollectorOptions = {
    startDate: String(rawOptions['startDate']),
    endDate: String(rawOptions['endDate']),
    symbol: String(rawOptions['symbol']),
    priceFidelityMinutes,
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

await program.parseAsync(process.argv);
