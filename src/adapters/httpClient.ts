export interface HttpClientOptions {
  requestDelayMilliseconds: number;
  maximumRetries: number;
}

export class PublicHttpClient {
  public constructor(private readonly options: HttpClientOptions) {}

  public async getJson<T>(url: URL): Promise<T> {
    return this.request<T>(url, { method: 'GET' });
  }

  public async postJson<T>(url: URL, body: unknown): Promise<T> {
    return this.request<T>(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  public async getArrayBuffer(url: URL): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>(url, { method: 'GET' }, true);
  }

  private async request<T>(url: URL, requestInit: RequestInit, returnArrayBuffer = false): Promise<T> {
    let lastError: Error | null = null;
    for (let attemptNumber = 0; attemptNumber <= this.options.maximumRetries; attemptNumber += 1) {
      if (this.options.requestDelayMilliseconds > 0) await delay(this.options.requestDelayMilliseconds);
      try {
        const response = await fetch(url, requestInit);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.toString()}`);
        return (returnArrayBuffer ? await response.arrayBuffer() : await response.json()) as T;
      } catch (error) {
        lastError = error as Error;
        const backoffMilliseconds = Math.min(30_000, 500 * 2 ** attemptNumber);
        await delay(backoffMilliseconds);
      }
    }
    throw lastError ?? new Error(`Request failed for ${url.toString()}`);
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
