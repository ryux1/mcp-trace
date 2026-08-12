# MCP Trace

[![CI](https://github.com/ryux1/mcp-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/ryux1/mcp-trace/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ryux1/mcp-trace/actions/workflows/codeql.yml/badge.svg)](https://github.com/ryux1/mcp-trace/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A security-conscious observability gateway for the Model Context Protocol over Streamable HTTP.

MCP Trace sits between an MCP client and a fixed upstream server. It preserves JSON and SSE traffic
while adding structured logs, Prometheus metrics, OpenTelemetry spans, sanitized NDJSON recordings,
inspection, and controlled replay.

```text
MCP client  ──POST / GET / DELETE──▶  MCP Trace  ──transparent HTTP──▶  MCP server
                                            │
                                            ├── Prometheus metrics
                                            ├── OpenTelemetry spans
                                            └── sanitized NDJSON recording
```

The gateway does not implement MCP methods, terminate authorization, or mutate JSON-RPC bodies. That
narrow boundary is intentional: the upstream server remains the protocol authority.

## Why MCP Trace?

Generic reverse proxies can measure HTTP, but they do not understand `tools/call`, `resources/read`,
MCP protocol revisions, JSON-RPC identifiers, or header/body mismatches. Application-level logging
has the opposite problem: it often captures tool arguments and credentials too freely.

MCP Trace provides MCP-aware signals with conservative defaults:

- streams `application/json` and `text/event-stream` responses without buffering them;
- preserves 2026 routing headers and 2025 session/resumption headers;
- extracts and forwards W3C Trace Context;
- exposes method/status counters and latency histograms without tool-name metric labels;
- records metadata only unless body capture is explicitly enabled;
- hashes legacy session IDs and never records authorization or cookie headers;
- redacts common credentials, configured secret keys, and secrets in JSON/SSE text;
- makes replay a dry run unless `--execute` is supplied.

## Protocol compatibility

| MCP transport revision            | Status            | Behavior                                                                    |
| --------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `2026-07-28` Streamable HTTP      | Supported         | POST, JSON or request-scoped SSE, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`   |
| `2025-03-26` through `2025-11-25` | Supported         | POST/GET/DELETE, `Mcp-Session-Id`, `Last-Event-ID`, standalone SSE          |
| `2024-11-05` HTTP+SSE             | Not targeted      | Its separate endpoint discovery flow is outside this fixed-endpoint gateway |
| stdio                             | Not yet supported | Use an HTTP bridge or follow the roadmap                                    |

See the official
[2026 Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
and
[2025 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Quick start

Requirements: Node.js 20.19 or newer and pnpm 11.

```bash
git clone https://github.com/ryux1/mcp-trace.git
cd mcp-trace
corepack enable
pnpm install --frozen-lockfile
pnpm build

node dist/cli.js proxy \
  --upstream http://127.0.0.1:3001/mcp
```

Point the MCP client at `http://127.0.0.1:7331/mcp`. The gateway binds only to `127.0.0.1` by
default.

For an authenticated upstream, keep the credential out of command history:

```bash
export MCP_UPSTREAM_AUTHORIZATION='Bearer replace-me'

node dist/cli.js proxy \
  --upstream https://mcp.example.com/mcp \
  --upstream-header-env Authorization=MCP_UPSTREAM_AUTHORIZATION
```

The example server in [`examples/`](examples/README.md) provides a local end-to-end demo.

## Record and inspect

Metadata-only recording is the default:

```bash
node dist/cli.js proxy \
  --upstream http://127.0.0.1:3001/mcp \
  --record ./traffic.ndjson
```

Payload capture requires a second, explicit switch:

```bash
node dist/cli.js proxy \
  --upstream http://127.0.0.1:3001/mcp \
  --record ./traffic.ndjson \
  --record-bodies \
  --redact-key tenant-secret
```

Recording files are forced to owner-only mode (`0600`). Inspect them without starting a server:

```bash
node dist/cli.js inspect ./traffic.ndjson
```

The output summarizes request counts, failures, bytes, and p50/p95/p99 latency by MCP method. See
the [recording schema](docs/recording-schema.md) and [security model](docs/security.md) before
capturing production traffic.

## Replay safely

Replay is a dry run by default. It reports how many requests are replayable and skips truncated,
binary, body-less, and redacted entries.

```bash
node dist/cli.js replay ./traffic.ndjson \
  --upstream http://127.0.0.1:3001/mcp
```

Execute only against a system where repeating tool calls is safe:

```bash
node dist/cli.js replay ./traffic.ndjson \
  --upstream http://127.0.0.1:3001/mcp \
  --execute \
  --concurrency 4 \
  --rate 20
```

Authorization can be supplied with `--header-env`. Legacy `Mcp-Session-Id` values are never recorded
or replayed, so replay is best suited to stateless 2026 traffic.

## Metrics and tracing

The gateway exposes two local administrative endpoints:

- `GET /__mcp_trace/healthz`
- `GET /__mcp_trace/metrics`

Prometheus metrics include request totals, in-flight requests, recording failures, and latency
histograms. Method-label cardinality is bounded; tool/resource names are not used as metric labels.

Export spans to any OTLP/HTTP collector:

```bash
export OTEL_AUTHORIZATION='Bearer collector-token'

node dist/cli.js proxy \
  --upstream http://127.0.0.1:3001/mcp \
  --otlp-endpoint http://127.0.0.1:4318 \
  --otlp-header-env Authorization=OTEL_AUTHORIZATION
```

Each span includes the HTTP method/status, MCP method, protocol revision, upstream address, and
detected header/body mismatch fields. Tool/resource names appear only on individual spans. MCP Trace
preserves JSON `_meta.traceparent`, `_meta.tracestate`, and `_meta.baggage` fields without rewriting
them, and separately propagates standard HTTP trace headers.

## Docker

```bash
docker build -t mcp-trace:local .

docker run --rm \
  --network host \
  mcp-trace:local proxy \
  --host 127.0.0.1 \
  --upstream http://127.0.0.1:3001/mcp
```

When binding to `0.0.0.0` or `::`, at least one `--allow-host` value is required. This fail-closed
behavior prevents a wildcard bind from silently accepting arbitrary Host headers.

## Verification

```bash
pnpm verify
```

The gate runs formatting, ESLint, strict TypeScript checks, the unit/integration suite with coverage
thresholds, and a clean build. The integration tests use real HTTP servers and cover JSON, streamed
SSE, modern and legacy transports, origin/host rejection, payload limits, recording, redaction,
metrics, OTLP export, and replay.

Run the reproducible local microbenchmark with:

```bash
pnpm benchmark
```

Methodology and interpretation are documented in [docs/benchmarks.md](docs/benchmarks.md).

## Design and limits

- [Architecture](docs/architecture.md)
- [Security and threat model](docs/security.md)
- [Recording schema](docs/recording-schema.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

MCP Trace is not a data-loss-prevention system, authorization server, or protocol validator.
Redaction is defense in depth, not proof that a recording contains no sensitive data. Review
recordings before sharing them.

## License

[MIT](LICENSE)
