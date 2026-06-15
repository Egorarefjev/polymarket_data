export interface HttpClientOptions {
  requestDelayMilliseconds: number;
  maximumRetries: number;
}

export class PublicHttpClient {
  public constructor(private readonly options: HttpClientOptions) {}

  public async getJson<T>(url: URL, options: { timeoutMilliseconds?: number; maximumRetries?: number } = {}): Promise<T> {
    return this.request<T>(url, { method: 'GET' }, false, options.timeoutMilliseconds, options.maximumRetries);
  }

  public async postJson<T>(url: URL, body: unknown): Promise<T> {
    return this.request<T>(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  public async getArrayBuffer(url: URL): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>(url, { method: 'GET' }, true);
  }

  private async request<T>(url: URL, requestInit: RequestInit, returnArrayBuffer = false, timeoutMilliseconds?: number, maximumRetries = this.options.maximumRetries): Promise<T> {
    let lastError: Error | null = null;
    for (let attemptNumber = 0; attemptNumber <= maximumRetries; attemptNumber += 1) {
      if (this.options.requestDelayMilliseconds > 0) await delay(this.options.requestDelayMilliseconds);
      try {
        const controller = timeoutMilliseconds === undefined ? undefined : new AbortController();
        const timeout = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMilliseconds);
        try {
          const response = await fetch(url, controller === undefined ? requestInit : { ...requestInit, signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.toString()}`);
          return (returnArrayBuffer ? await response.arrayBuffer() : await response.json()) as T;
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } catch (error) {
        if (timeoutMilliseconds !== undefined && error instanceof Error && error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMilliseconds}ms for ${url.toString()}`);
        lastError = error as Error;
        if (attemptNumber < maximumRetries) {
          const backoffMilliseconds = Math.min(30_000, 500 * 2 ** attemptNumber);
          await delay(backoffMilliseconds);
        }
      }
    }
    throw lastError ?? new Error(`Request failed for ${url.toString()}`);
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
