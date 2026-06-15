import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function getNpmExecutable(): string {
  // On Windows, npm is exposed as npm.cmd, so tests must not spawn plain "npm".
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runNpmCommand(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(getNpmExecutable(), args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
  });
}
