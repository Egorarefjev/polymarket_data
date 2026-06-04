import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class FileStorage {
  public constructor(private readonly dataDirectoryPath = 'data') {}

  public getDataDirectoryPath(): string {
    return this.dataDirectoryPath;
  }

  public async ensureDataDirectories(): Promise<void> {
    for (const directoryPath of [
      'raw/gamma',
      'raw/polymarket-prices',
      'raw/polymarket-trades',
      'raw/binance',
      'processed',
      'rejected',
      'state',
      'logs',
    ]) {
      await mkdir(this.resolve(directoryPath), { recursive: true });
    }
  }

  public resolve(relativeFilePath: string): string {
    return join(this.dataDirectoryPath, relativeFilePath);
  }

  public async exists(relativeFilePath: string): Promise<boolean> {
    try {
      await access(this.resolve(relativeFilePath));
      return true;
    } catch {
      return false;
    }
  }

  public async writeJson(relativeFilePath: string, value: unknown, force: boolean): Promise<boolean> {
    const absoluteFilePath = this.resolve(relativeFilePath);
    if (!force && (await this.exists(relativeFilePath))) return false;
    await mkdir(dirname(absoluteFilePath), { recursive: true });
    await writeFile(absoluteFilePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return true;
  }

  public async writeJsonLines(relativeFilePath: string, values: unknown[], force: boolean): Promise<boolean> {
    const absoluteFilePath = this.resolve(relativeFilePath);
    if (!force && (await this.exists(relativeFilePath))) return false;
    await mkdir(dirname(absoluteFilePath), { recursive: true });
    await writeFile(absoluteFilePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
    return true;
  }

  public async readJson<T>(relativeFilePath: string): Promise<T> {
    return JSON.parse(await readFile(this.resolve(relativeFilePath), 'utf8')) as T;
  }

  public async readJsonLines<T>(relativeFilePath: string): Promise<T[]> {
    const fileContent = await readFile(this.resolve(relativeFilePath), 'utf8');
    return fileContent
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  }
}
