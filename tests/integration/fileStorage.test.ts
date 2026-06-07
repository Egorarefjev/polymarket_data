import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileStorage } from '../../src/adapters/fileStorage.js';

describe('FileStorage', () => {
  it('writes and reads raw JSON without overwriting unless forced', async () => {
    const temporaryDirectoryPath = await mkdtemp(join(tmpdir(), 'polymarket-storage-'));
    try {
      const fileStorage = new FileStorage(temporaryDirectoryPath);
      await fileStorage.writeJson('raw/gamma/example.json', { value: 1 }, false);
      const skipped = await fileStorage.writeJson('raw/gamma/example.json', { value: 2 }, false);
      expect(skipped).toBe(false);
      expect(await fileStorage.readJson<{ value: number }>('raw/gamma/example.json')).toEqual({ value: 1 });
      await fileStorage.writeJson('raw/gamma/example.json', { value: 3 }, true);
      expect(await fileStorage.readJson<{ value: number }>('raw/gamma/example.json')).toEqual({ value: 3 });
    } finally {
      await rm(temporaryDirectoryPath, { recursive: true, force: true });
    }
  });

  it('deleteIfExists returns false and does not throw when file is absent', async () => {
    const temporaryDirectoryPath = await mkdtemp(join(tmpdir(), 'polymarket-storage-'));
    try {
      const fileStorage = new FileStorage(temporaryDirectoryPath);
      await expect(fileStorage.deleteIfExists('processed/missing.debug.json')).resolves.toBe(false);
      await expect(fileStorage.deleteIfExists('processed/missing.debug.json')).resolves.toBe(false);
    } finally {
      await rm(temporaryDirectoryPath, { recursive: true, force: true });
    }
  });

  it('deleteIfExists deletes an existing file and returns true', async () => {
    const temporaryDirectoryPath = await mkdtemp(join(tmpdir(), 'polymarket-storage-'));
    try {
      const fileStorage = new FileStorage(temporaryDirectoryPath);
      await fileStorage.writeJson('processed/existing.debug.json', { stale: true }, true);
      expect(await fileStorage.deleteIfExists('processed/existing.debug.json')).toBe(true);
      expect(await fileStorage.exists('processed/existing.debug.json')).toBe(false);
      expect(await fileStorage.deleteIfExists('processed/existing.debug.json')).toBe(false);
    } finally {
      await rm(temporaryDirectoryPath, { recursive: true, force: true });
    }
  });
});
