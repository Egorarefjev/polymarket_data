import { formatCliError } from './formatCliError.js';
import { isCliErrorAlreadyReported, runCollectorCli } from './runCollectorCli.js';

runCollectorCli(process.argv).catch((error: unknown) => {
  if (!isCliErrorAlreadyReported(error)) console.error(formatCliError(error));
  process.exitCode = 1;
});
