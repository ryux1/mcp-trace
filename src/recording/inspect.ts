import type { RecordedExchange } from "../types.js";
import { readRecording } from "./reader.js";

interface MethodSummary {
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly requests: number;
}

export interface RecordingSummary {
  readonly bytesFromClient: number;
  readonly bytesFromServer: number;
  readonly exchanges: number;
  readonly firstStartedAt?: string;
  readonly lastCompletedAt?: string;
  readonly methods: Readonly<Record<string, MethodSummary>>;
  readonly schemaVersion: 1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class RecordingSummaryBuilder {
  readonly #durations = new Map<string, number[]>();
  readonly #errors = new Map<string, number>();
  #bytesFromClient = 0;
  #bytesFromServer = 0;
  #exchanges = 0;
  #firstStartedAt?: string;
  #lastCompletedAt?: string;

  add(exchange: RecordedExchange): void {
    const method = exchange.request.metadata.method;
    const methodDurations = this.#durations.get(method) ?? [];
    methodDurations.push(exchange.durationMs);
    this.#durations.set(method, methodDurations);
    if (exchange.error !== undefined || exchange.response.status >= 400) {
      this.#errors.set(method, (this.#errors.get(method) ?? 0) + 1);
    }
    this.#bytesFromClient += exchange.request.bytes;
    this.#bytesFromServer += exchange.response.bytes;
    this.#exchanges += 1;
    this.#firstStartedAt ??= exchange.startedAt;
    this.#lastCompletedAt = exchange.completedAt;
  }

  build(): RecordingSummary {
    const methods = Object.fromEntries(
      [...this.#durations.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([method, values]) => {
          const sorted = [...values].sort((left, right) => left - right);
          return [
            method,
            {
              errors: this.#errors.get(method) ?? 0,
              p50Ms: percentile(sorted, 0.5),
              p95Ms: percentile(sorted, 0.95),
              p99Ms: percentile(sorted, 0.99),
              requests: sorted.length
            }
          ];
        })
    );

    return {
      bytesFromClient: this.#bytesFromClient,
      bytesFromServer: this.#bytesFromServer,
      exchanges: this.#exchanges,
      ...(this.#firstStartedAt === undefined ? {} : { firstStartedAt: this.#firstStartedAt }),
      ...(this.#lastCompletedAt === undefined ? {} : { lastCompletedAt: this.#lastCompletedAt }),
      methods,
      schemaVersion: 1
    };
  }
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1);
  return Number((sortedValues[index] ?? 0).toFixed(3));
}

export function summarizeExchanges(exchanges: readonly RecordedExchange[]): RecordingSummary {
  const builder = new RecordingSummaryBuilder();
  for (const exchange of exchanges) {
    builder.add(exchange);
  }
  return builder.build();
}

export async function inspectRecording(path: string): Promise<RecordingSummary> {
  const exchanges: RecordedExchange[] = [];
  for await (const exchange of readRecording(path)) {
    exchanges.push(exchange);
  }
  return summarizeExchanges(exchanges);
}
