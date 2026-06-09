import { readFile, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { CollectorOptions, CollectorUseCases } from '../../src/application/collectorUseCases.js';
import { createCollectorProgram, type CollectorCliDependencies } from '../../src/cli/createCollectorProgram.js';
import { runCollectorCli } from '../../src/cli/runCollectorCli.js';

function createMemoryLogger(): { lines: string[]; logger: { info: (message: string) => void; error: (message: string) => void } } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  };
}

function createUseCases(overrides: Partial<Record<keyof CollectorUseCases, (options: CollectorOptions) => Promise<void>>> = {}): CollectorUseCases {
  const fallback = async (_options: CollectorOptions): Promise<void> => undefined;
  return {
    discoverMarkets: overrides.discoverMarkets ?? fallback,
    diagnoseDiscovery: overrides.diagnoseDiscovery ?? fallback,
    downloadPolymarketPrices: overrides.downloadPolymarketPrices ?? fallback,
    downloadPolymarketTrades: overrides.downloadPolymarketTrades ?? fallback,
    downloadBinance: overrides.downloadBinance ?? fallback,
    buildDataset: overrides.buildDataset ?? fallback,
    summarizeMarkets: overrides.summarizeMarkets ?? fallback,
    runFullPipeline: overrides.runFullPipeline ?? fallback,
  } as unknown as CollectorUseCases;
}

function createDependencies(overrides: Partial<CollectorCliDependencies> = {}): CollectorCliDependencies {
  const { logger } = createMemoryLogger();
  return {
    createCollectorUseCases: () => createUseCases(),
    ensureBaseDirectories: async () => undefined,
    logger,
    ...overrides,
  };
}

describe('createCollectorProgram', () => {
  it('registers collector commands without parsing automatically', () => {
    const createCollectorUseCases = vi.fn(() => createUseCases());
    const program = createCollectorProgram(createDependencies({ createCollectorUseCases }));
    const commandNames = program.commands.map((command) => command.name());

    expect(commandNames).toContain('discover');
    expect(commandNames).toContain('diagnose-discovery');
    expect(commandNames).toContain('all');
    expect(commandNames).toContain('doctor');
    expect(createCollectorUseCases).not.toHaveBeenCalled();
  });
});

describe('runCollectorCli', () => {
  it('awaits async command actions, creates directories first, and prints lifecycle logs', async () => {
    const { lines, logger } = createMemoryLogger();
    const callOrder: string[] = [];
    const discoverMarkets = vi.fn(async () => {
      callOrder.push('action:start');
      await Promise.resolve();
      callOrder.push('action:end');
    });
    const ensureBaseDirectories = vi.fn(async () => {
      callOrder.push('ensure');
    });

    await runCollectorCli(['node', 'collector', 'discover', '--date', '2026-05-01'], {
      createCollectorUseCases: () => createUseCases({ discoverMarkets }),
      ensureBaseDirectories,
      logger,
    });

    expect(ensureBaseDirectories).toHaveBeenCalledOnce();
    expect(discoverMarkets).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['ensure', 'action:start', 'action:end']);
    expect(lines).toContain('Starting command: discover');
    expect(lines).toContain('Date range: 2026-05-01 to 2026-05-02');
    expect(lines).toContain('Market duration: 1h');
    expect(lines).toContain('Primary price mode: official_chainlink');
    expect(lines).toContain('Output duration key: 1h');
    expect(lines).toContain('Finished command: discover');
  });

  it('propagates errors and prints failed command with message', async () => {
    const { lines, logger } = createMemoryLogger();
    const processExitSpy = vi.spyOn(process, 'exit');
    const error = new Error('boom');

    await expect(runCollectorCli(['node', 'collector', 'discover', '--date', '2026-05-01'], {
      createCollectorUseCases: () => createUseCases({ discoverMarkets: async () => { throw error; } }),
      ensureBaseDirectories: async () => undefined,
      logger,
    })).rejects.toThrow('boom');

    expect(lines).toContain('Failed command: discover');
    expect(lines).toContain('Error: boom');
    expect(processExitSpy).not.toHaveBeenCalled();
    processExitSpy.mockRestore();
  });
});

describe('collector CLI commands', () => {
  it('discover calls discoverMarkets exactly once', async () => {
    const discoverMarkets = vi.fn(async () => undefined);
    await runCollectorCli(['node', 'collector', 'discover', '--date', '2026-05-01'], createDependencies({ createCollectorUseCases: () => createUseCases({ discoverMarkets }) }));
    expect(discoverMarkets).toHaveBeenCalledOnce();
  });

  it('diagnose-discovery calls diagnoseDiscovery exactly once', async () => {
    const diagnoseDiscovery = vi.fn(async () => undefined);
    await runCollectorCli(['node', 'collector', 'diagnose-discovery', '--date', '2026-05-01'], createDependencies({ createCollectorUseCases: () => createUseCases({ diagnoseDiscovery }) }));
    expect(diagnoseDiscovery).toHaveBeenCalledOnce();
  });

  it('all calls runFullPipeline exactly once', async () => {
    const runFullPipeline = vi.fn(async () => undefined);
    await runCollectorCli(['node', 'collector', 'all', '--date', '2026-05-01'], createDependencies({ createCollectorUseCases: () => createUseCases({ runFullPipeline }) }));
    expect(runFullPipeline).toHaveBeenCalledOnce();
  });

  it('doctor creates directories and does not construct external use cases', async () => {
    const { lines, logger } = createMemoryLogger();
    const createCollectorUseCases = vi.fn(() => createUseCases());
    const ensureBaseDirectories = vi.fn(async () => undefined);

    await runCollectorCli(['node', 'collector', 'doctor'], { createCollectorUseCases, ensureBaseDirectories, logger });

    expect(ensureBaseDirectories).toHaveBeenCalledOnce();
    expect(createCollectorUseCases).not.toHaveBeenCalled();
    expect(lines).toContain('Starting command: doctor');
    expect(lines.some((line) => line.startsWith('Node version: '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Platform: '))).toBe(true);
    expect(lines).toContain('Data directories: ok');
    expect(lines).toContain('CLI execution: ok');
    expect(lines).toContain('Finished command: doctor');
  });
});

describe('collector package scripts', () => {
  it('points collector and preset scripts at the side-effect entrypoint', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['collector']).toBe('tsx src/cli/collector.ts');
    expect(packageJson.scripts).toHaveProperty('collect:proxy:all');
    expect(packageJson.scripts).toHaveProperty('collect:official:all');
  });

  it('doctor smoke command runs through npm script without import.meta.url guard', async () => {
    await rm('data', { recursive: true, force: true });
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('npm', ['run', 'collector', '--', 'doctor'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Starting command: doctor');
    expect(result.stdout).toContain('Finished command: doctor');
  });
});
