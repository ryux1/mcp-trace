const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;

interface MethodMetrics {
  buckets: number[];
  count: number;
  durationMsSum: number;
  statuses: Map<number, number>;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Readonly<Record<string, number | string>>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(",")}}`;
}

export class MetricsRegistry {
  readonly #bucketsMs: readonly number[];
  readonly #maxMethods: number;
  readonly #methods = new Map<string, MethodMetrics>();
  #inFlight = 0;
  #recordingErrors = 0;

  constructor(bucketsMs: readonly number[] = DEFAULT_BUCKETS_MS, maxMethods = 100) {
    this.#bucketsMs = [...bucketsMs].sort((left, right) => left - right);
    this.#maxMethods = maxMethods;
  }

  beginRequest(): void {
    this.#inFlight += 1;
  }

  endRequest(method: string, status: number, durationMs: number): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    const boundedMethod =
      this.#methods.has(method) || this.#methods.size < this.#maxMethods ? method : "other";
    const current = this.#methods.get(boundedMethod) ?? {
      buckets: this.#bucketsMs.map(() => 0),
      count: 0,
      durationMsSum: 0,
      statuses: new Map<number, number>()
    };
    current.count += 1;
    current.durationMsSum += durationMs;
    current.statuses.set(status, (current.statuses.get(status) ?? 0) + 1);
    this.#bucketsMs.forEach((upperBound, index) => {
      if (durationMs <= upperBound) {
        current.buckets[index] = (current.buckets[index] ?? 0) + 1;
      }
    });
    this.#methods.set(boundedMethod, current);
  }

  recordingError(): void {
    this.#recordingErrors += 1;
  }

  renderPrometheus(): string {
    const lines = [
      "# HELP mcp_trace_in_flight_requests Current requests being proxied.",
      "# TYPE mcp_trace_in_flight_requests gauge",
      `mcp_trace_in_flight_requests ${this.#inFlight}`,
      "# HELP mcp_trace_recording_errors_total Recording writes that failed.",
      "# TYPE mcp_trace_recording_errors_total counter",
      `mcp_trace_recording_errors_total ${this.#recordingErrors}`,
      "# HELP mcp_trace_requests_total Proxied MCP requests by method and HTTP status.",
      "# TYPE mcp_trace_requests_total counter"
    ];

    const sortedMethods = [...this.#methods.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    for (const [method, metrics] of sortedMethods) {
      for (const [status, count] of [...metrics.statuses.entries()].sort(
        ([left], [right]) => left - right
      )) {
        lines.push(`mcp_trace_requests_total${labels({ method, status })} ${count}`);
      }
    }

    lines.push(
      "# HELP mcp_trace_request_duration_seconds MCP proxy request latency.",
      "# TYPE mcp_trace_request_duration_seconds histogram"
    );
    for (const [method, metrics] of sortedMethods) {
      this.#bucketsMs.forEach((bucket, index) => {
        lines.push(
          `mcp_trace_request_duration_seconds_bucket${labels({ method, le: bucket / 1_000 })} ${metrics.buckets[index] ?? 0}`
        );
      });
      lines.push(
        `mcp_trace_request_duration_seconds_bucket${labels({ method, le: "+Inf" })} ${metrics.count}`,
        `mcp_trace_request_duration_seconds_sum${labels({ method })} ${metrics.durationMsSum / 1_000}`,
        `mcp_trace_request_duration_seconds_count${labels({ method })} ${metrics.count}`
      );
    }

    return `${lines.join("\n")}\n`;
  }
}
