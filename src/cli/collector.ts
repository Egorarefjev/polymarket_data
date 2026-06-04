import { Command } from 'commander';
import { FileStorage } from '../adapters/fileStorage.js';
import { PublicHttpClient } from '../adapters/httpClient.js';
import { createCollectorLogger } from '../adapters/logger.js';
import { PolymarketGammaApiAdapter } from '../adapters/polymarketGammaApi.js';
import { PolymarketClobApiAdapter } from '../adapters/polymarketClobApi.js';
import { BinanceArchiveApiAdapter, type BinanceDataType, type BinanceMarketType } from '../adapters/binanceArchiveApi.js';
import { LocalParquetWriter } from '../adapters/parquetWriter.js';
import { CollectorUseCases, type CollectorOptions } from '../application/collectorUseCases.js';

const program = new Command();
program.name('polymarket-btc-up-down-collector').description('Public historical data collector for BTC Up/Down 5-minute Polymarket markets');

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption('--start-date <date>')
    .requiredOption('--end-date <date>')
    .option('--symbol <symbol>', 'Binance symbol', 'BTCUSDT')
    .option('--price-fidelity-seconds <seconds>', 'Polymarket price-history fidelity: 1, 5, 10, or 60', '5')
    .option('--force', 'Overwrite existing raw files and rerun completed steps', false)
    .option('--request-delay-milliseconds <milliseconds>', 'Delay between public HTTP requests', '200')
    .option('--maximum-concurrent-requests <count>', 'Maximum concurrent public requests', '4')
    .option('--binance-market-type <type>', 'spot or futures', 'spot')
    .option('--binance-data-type <type>', 'aggTrades or klines', 'aggTrades');
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
  );
}

function parseOptions(rawOptions: Record<string, unknown>): CollectorOptions {
  const priceFidelitySeconds = Number(rawOptions['priceFidelitySeconds']);
  if (![1, 5, 10, 60].includes(priceFidelitySeconds)) throw new Error('--price-fidelity-seconds must be one of 1, 5, 10, 60');
  const binanceMarketType = String(rawOptions['binanceMarketType']) as BinanceMarketType;
  const binanceDataType = String(rawOptions['binanceDataType']) as BinanceDataType;
  if (!['spot', 'futures'].includes(binanceMarketType)) throw new Error('--binance-market-type must be spot or futures');
  if (!['aggTrades', 'klines'].includes(binanceDataType)) throw new Error('--binance-data-type must be aggTrades or klines');
  return {
    startDate: String(rawOptions['startDate']),
    endDate: String(rawOptions['endDate']),
    symbol: String(rawOptions['symbol']),
    priceFidelitySeconds,
    force: Boolean(rawOptions['force']),
    requestDelayMilliseconds: Number(rawOptions['requestDelayMilliseconds']),
    maximumConcurrentRequests: Number(rawOptions['maximumConcurrentRequests']),
    binanceMarketType,
    binanceDataType,
  };
}

function registerCommand(commandName: string, action: (useCases: CollectorUseCases, options: CollectorOptions) => Promise<void>): void {
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
