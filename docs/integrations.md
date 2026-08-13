# Observability integrations

MCP Trace emits standard Prometheus text metrics and OTLP/HTTP JSON spans. It does not require a
hosted vendor or a proprietary collector.

## Jaeger

The repository's complete Compose demo uses the pinned Jaeger image and sends spans directly over
OTLP/HTTP:

```bash
docker compose -f docker-compose.demo.yml up --build --detach
```

Open `http://127.0.0.1:16686` in a browser.

For an existing Jaeger deployment with OTLP HTTP enabled:

```bash
mcp-trace proxy \
  --upstream http://127.0.0.1:3001/mcp \
  --otlp-endpoint http://127.0.0.1:4318
```

## Prometheus

The metrics endpoint is `GET /__mcp_trace/metrics`. A minimal scrape job is:

```yaml
scrape_configs:
  - job_name: mcp-trace
    metrics_path: /__mcp_trace/metrics
    static_configs:
      - targets: ["127.0.0.1:7331"]
```

Available signals include in-flight requests, request counts by bounded MCP method/status, request
latency histograms, and recording failures. Tool and resource names are deliberately excluded from
metric labels to prevent unbounded cardinality.

## Grafana Tempo or another OTLP backend

Point `--otlp-endpoint` at the backend's OTLP/HTTP receiver or at an OpenTelemetry Collector. MCP
Trace appends `/v1/traces` when absent:

```bash
export OTEL_AUTHORIZATION='Bearer replace-me'
mcp-trace proxy \
  --upstream https://mcp.example.com/mcp \
  --otlp-endpoint https://tempo.example.com:4318 \
  --otlp-header-env Authorization=OTEL_AUTHORIZATION
```

Keep exporter credentials in environment variables. They are validated as HTTP headers and are not
written to recordings.

## OpenTelemetry Collector

Use an OTLP/HTTP receiver and any desired exporter:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  debug:
    verbosity: basic

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
```

Then run MCP Trace with `--otlp-endpoint http://127.0.0.1:4318`. Production collectors should add
authentication, batching, retry, memory limits, and a durable exporter appropriate to their threat
model.
