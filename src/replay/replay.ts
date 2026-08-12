import { REDACTED } from "../recording/redaction.js";
import { readRecording } from "../recording/reader.js";
import type { CapturedBody, RecordedExchange } from "../types.js";

export interface ReplayOptions {
  readonly allowRedacted?: boolean;
  readonly concurrency?: number;
  readonly execute?: boolean;
  readonly fetchImplementation?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly iterations?: number;
  readonly ratePerSecond?: number;
  readonly timeoutMs?: number;
  readonly upstream: URL;
}

export interface ReplaySummary {
  readonly attempted: number;
  readonly durationMs: number;
  readonly failed: number;
  readonly mode: "dry-run" | "execute";
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly planned: number;
  readonly skipped: number;
  readonly succeeded: number;
}

interface ReplayItem {
  readonly body: Buffer;
  readonly headers: Headers;
  readonly path: string;
}

class RateLimiter {
  readonly #intervalMs: number;
  #nextSlot = performance.now();
  #queue: Promise<void> = Promise.resolve();

  constructor(ratePerSecond: number | undefined) {
    this.#intervalMs = ratePerSecond === undefined ? 0 : 1_000 / ratePerSecond;
  }

  async wait(): Promise<void> {
    if (this.#intervalMs === 0) {
      return;
    }
    const turn = this.#queue.then(async () => {
      const now = performance.now();
      const delayMs = Math.max(0, this.#nextSlot - now);
      this.#nextSlot = Math.max(now, this.#nextSlot) + this.#intervalMs;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    });
    this.#queue = turn.catch(() => undefined);
    await turn;
  }
}

function containsRedaction(body: CapturedBody): boolean {
  return JSON.stringify(body.value).includes(REDACTED);
}

function pathContainsRedaction(path: string): boolean {
  try {
    return decodeURIComponent(path).includes(REDACTED);
  } catch {
    return path.includes(REDACTED);
  }
}

function replayBody(body: CapturedBody): Buffer | undefined {
  if (body.truncated) {
    return undefined;
  }
  if (body.format === "json") {
    return Buffer.from(JSON.stringify(body.value));
  }
  if (body.format === "text" && typeof body.value === "string") {
    return Buffer.from(body.value);
  }
  return undefined;
}

function replayItem(
  exchange: RecordedExchange,
  options: Pick<ReplayOptions, "allowRedacted" | "headers">
): ReplayItem | undefined {
  const capturedBody = exchange.request.body;
  if (exchange.request.httpMethod !== "POST" || capturedBody === undefined) {
    return undefined;
  }
  if (
    (containsRedaction(capturedBody) || pathContainsRedaction(exchange.request.path)) &&
    options.allowRedacted !== true
  ) {
    return undefined;
  }
  const body = replayBody(capturedBody);
  if (body === undefined) {
    return undefined;
  }
  const headers = new Headers(exchange.request.headers);
  headers.delete("content-length");
  headers.delete("host");
  headers.delete("mcp-session-id");
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return { body, headers, path: exchange.request.path };
}

function targetUrl(upstream: URL, path: string): URL {
  const target = new URL(upstream);
  const recorded = new URL(path, "http://recording.invalid");
  for (const [name, value] of recorded.searchParams) {
    target.searchParams.append(name, value);
  }
  return target;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

async function drainResponse(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain without retaining response payloads in memory.
    }
  } finally {
    reader.releaseLock();
  }
}

export async function replayRecording(
  path: string,
  options: ReplayOptions
): Promise<ReplaySummary> {
  const concurrency = options.concurrency ?? 1;
  const iterations = options.iterations ?? 1;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (concurrency <= 0 || iterations <= 0 || timeoutMs <= 0) {
    throw new Error("Concurrency, iterations, and timeout must be positive");
  }
  if (options.ratePerSecond !== undefined && options.ratePerSecond <= 0) {
    throw new Error("Replay rate must be positive");
  }

  const source: ReplayItem[] = [];
  let recordingEntries = 0;
  for await (const exchange of readRecording(path)) {
    recordingEntries += 1;
    const item = replayItem(exchange, options);
    if (item !== undefined) {
      source.push(item);
    }
  }
  const items = Array.from({ length: iterations }, () => source).flat();
  const skipped = recordingEntries * iterations - items.length;
  if (options.execute !== true) {
    return {
      attempted: 0,
      durationMs: 0,
      failed: 0,
      mode: "dry-run",
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      planned: items.length,
      skipped,
      succeeded: 0
    };
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const limiter = new RateLimiter(options.ratePerSecond);
  const latencies: number[] = [];
  let cursor = 0;
  let failed = 0;
  let succeeded = 0;
  const startedAt = performance.now();
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) {
          continue;
        }
        await limiter.wait();
        const requestStartedAt = performance.now();
        try {
          const response = await fetchImplementation(targetUrl(options.upstream, item.path), {
            body: item.body,
            headers: item.headers,
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs)
          });
          await drainResponse(response);
          if (response.ok) {
            succeeded += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        } finally {
          latencies.push(performance.now() - requestStartedAt);
        }
      }
    }
  );
  await Promise.all(workers);

  return {
    attempted: items.length,
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    failed,
    mode: "execute",
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    planned: items.length,
    skipped,
    succeeded
  };
}
