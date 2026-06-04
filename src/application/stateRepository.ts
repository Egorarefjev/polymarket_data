import type { FileStorage } from '../adapters/fileStorage.js';

export interface PipelineState {
  completedSteps: string[];
  updatedAtTimestampMilliseconds: number;
}

export class StateRepository {
  public constructor(private readonly fileStorage: FileStorage) {}

  public async markStepCompleted(stateKey: string, stepName: string): Promise<void> {
    const state = await this.readState(stateKey);
    await this.fileStorage.writeJson(
      `state/${stateKey}.json`,
      { completedSteps: [...new Set([...state.completedSteps, stepName])], updatedAtTimestampMilliseconds: Date.now() },
      true,
    );
  }

  public async isStepCompleted(stateKey: string, stepName: string): Promise<boolean> {
    return (await this.readState(stateKey)).completedSteps.includes(stepName);
  }

  private async readState(stateKey: string): Promise<PipelineState> {
    const relativeFilePath = `state/${stateKey}.json`;
    if (!(await this.fileStorage.exists(relativeFilePath))) {
      return { completedSteps: [], updatedAtTimestampMilliseconds: Date.now() };
    }
    return this.fileStorage.readJson<PipelineState>(relativeFilePath);
  }
}
