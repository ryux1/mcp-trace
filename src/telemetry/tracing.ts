import type { Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface TelemetryRuntime {
  readonly tracer: Tracer;
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly serviceName?: string;
}

export function createTelemetry(options: TelemetryOptions = {}): TelemetryRuntime {
  const spanProcessors = [];
  if (options.endpoint !== undefined) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: options.endpoint,
          ...(options.headers === undefined ? {} : { headers: { ...options.headers } })
        })
      )
    );
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": options.serviceName ?? "mcp-trace",
      "service.version": "0.1.0"
    }),
    spanProcessors
  });
  provider.register();

  return {
    tracer: provider.getTracer("mcp-trace", "0.1.0"),
    shutdown: async () => provider.shutdown()
  };
}
