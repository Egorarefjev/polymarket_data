declare module 'parquetjs-lite' {
  export class ParquetSchema {
    constructor(schemaDefinition: Record<string, { type: string; optional?: boolean; repeated?: boolean }>);
  }
  export class ParquetWriter {
    static openFile(schema: ParquetSchema, filePath: string): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }
}
