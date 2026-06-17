#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const VALID_DURATIONS = new Set(['all', '1h', '4h', '1d']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function usage() {
  console.error(`Usage: npm run collect:pm:range -- --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--market-duration all|1h|4h|1d] [--force]`);
}

function parseArgs(argv) {
  const options = {
    marketDuration: 'all',
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--start-date') {
      options.startDate = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--end-date') {
      options.endDate = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--market-duration') {
      options.marketDuration = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseDate(value, name) {
  if (!value || !DATE_PATTERN.test(value)) {
    throw new Error(`${name} must be in YYYY-MM-DD format`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid calendar date`);
  }

  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function nextDay(date) {
  return new Date(date.getTime() + MS_PER_DAY);
}

function runDailyCollector(date, marketDuration, force) {
  const args = ['run', `collect:pm:${marketDuration}`, '--', '--date', date];
  if (force) {
    args.push('--force');
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npmCommand, args, { stdio: 'inherit' });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));

    if (!VALID_DURATIONS.has(options.marketDuration)) {
      throw new Error('--market-duration must be one of: all, 1h, 4h, 1d');
    }

    const startDate = parseDate(options.startDate, '--start-date');
    const endDate = parseDate(options.endDate, '--end-date');

    if (startDate >= endDate) {
      throw new Error('--start-date must be before --end-date');
    }

    let attempted = 0;
    let succeeded = 0;
    const failures = [];

    for (let cursor = startDate; cursor < endDate; cursor = nextDay(cursor)) {
      const date = formatDate(cursor);
      attempted += 1;
      console.log(`=== Collecting ${date} ===`);

      const result = runDailyCollector(date, options.marketDuration, options.force);
      const exitCode = result.status ?? 1;

      if (result.error || exitCode !== 0) {
        failures.push({ date, exitCode, error: result.error });
        continue;
      }

      succeeded += 1;
    }

    console.log('\n=== Range collection summary ===');
    console.log(`days attempted: ${attempted}`);
    console.log(`succeeded: ${succeeded}`);
    console.log(`failed: ${failures.length}`);
    console.log(`failed dates: ${failures.length > 0 ? failures.map((failure) => `${failure.date} (${failure.exitCode})`).join(', ') : 'none'}`);

    if (failures.length > 0) {
      console.error('\nFailures:');
      for (const failure of failures) {
        const detail = failure.error ? `, error: ${failure.error.message}` : '';
        console.error(`- ${failure.date}: exit code ${failure.exitCode}${detail}`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 1;
  }
}

main();
