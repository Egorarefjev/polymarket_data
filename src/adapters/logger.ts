import pino from 'pino';

export type CollectorLogger = ReturnType<typeof pino>;

export function createCollectorLogger(): CollectorLogger {
  return pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
}
