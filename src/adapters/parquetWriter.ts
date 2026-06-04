import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ParquetSchema, ParquetWriter } from 'parquetjs-lite';

export type ParquetColumnType = 'UTF8' | 'DOUBLE' | 'INT64' | 'BOOLEAN';
export type ParquetSchemaDefinition = Record<string, { type: ParquetColumnType; optional?: boolean }>;

export class LocalParquetWriter {
  public async writeRows(filePath: string, schemaDefinition: ParquetSchemaDefinition, rows: Array<Record<string, unknown>>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const parquetSchema = new ParquetSchema(schemaDefinition);
    const parquetWriter = await ParquetWriter.openFile(parquetSchema, filePath);
    try {
      for (const row of rows) {
        await parquetWriter.appendRow(row);
      }
    } finally {
      await parquetWriter.close();
    }
  }
}

export function serializeDataQualityFlags(dataQualityFlags: string[]): string {
  return JSON.stringify([...new Set(dataQualityFlags)].sort());
}
