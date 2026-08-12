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

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1);
  return Number((sortedValues[index] ?? 0).toFixed(3));
}

export function summarizeExchanges(exchanges: readonly RecordedExchange[]): RecordingSummary {
  const durations = new Map<string, number[]>();
  const errors = new Map<string, number>();
  let bytesFromClient = 0;
  let bytesFromServer = 0;

  for (const exchange of exchanges) {
    const method = exchange.request.metadata.method;
    const methodDurations = durations.get(method) ?? [];
    methodDurations.push(exchange.durationMs);
    durations.set(method, methodDurations);
    if (exchange.error !== undefined || exchange.response.status >= 400) {
      errors.set(method, (errors.get(method) ?? 0) + 1);
    }
    bytesFromClient += exchange.request.bytes;
    bytesFromServer += exchange.response.bytes;
  }

  const methods = Object.fromEntries(
    [...durations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([method, values]) => {
        const sorted = [...values].sort((left, right) => left - right);
        return [
          method,
          {
            errors: errors.get(method) ?? 0,
            p50Ms: percentile(sorted, 0.5),
            p95Ms: percentile(sorted, 0.95),
            p99Ms: percentile(sorted, 0.99),
            requests: sorted.length
          }
        ];
      })
  );
  const firstExchange = exchanges[0];
  const lastExchange = exchanges.at(-1);

  return {
    bytesFromClient,
    bytesFromServer,
    exchanges: exchanges.length,
    ...(firstExchange === undefined ? {} : { firstStartedAt: firstExchange.startedAt }),
    ...(lastExchange === undefined ? {} : { lastCompletedAt: lastExchange.completedAt }),
    methods,
    schemaVersion: 1
  };
}

export async function inspectRecording(path: string): Promise<RecordingSummary> {
  const exchanges: RecordedExchange[] = [];
  for await (const exchange of readRecording(path)) {
    exchanges.push(exchange);
  }
  return summarizeExchanges(exchanges);
}
