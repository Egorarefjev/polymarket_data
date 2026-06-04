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
});
