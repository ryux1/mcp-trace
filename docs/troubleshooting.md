# Troubleshooting

## The gateway returns `403 Host header is not allowed`

The default loopback listener accepts the matching local Host header. When binding to `0.0.0.0` or
`::`, explicitly allow every hostname through which clients reach the gateway:

```bash
mcp-trace proxy \
  --host 0.0.0.0 \
  --allow-host mcp-gateway.internal:7331 \
  --upstream http://127.0.0.1:3001/mcp
```

Do not use a broad wildcard merely to clear the error. Host validation prevents accidental exposure
through an unexpected virtual host.

## A browser client receives `403 Origin is not allowed`

Browser origins are denied unless configured:

```bash
mcp-trace proxy \
  --allow-origin https://client.example.com \
  --upstream https://mcp.example.com/mcp
```

Origin values must contain only scheme and authority, without path, query, or fragment. `*` is
accepted only when that broad policy is intentional.

## The upstream returns `401` or `403`

MCP Trace forwards client authorization headers by default. To inject a fixed upstream credential,
load it from an environment variable instead of exposing it in command history:

```bash
export MCP_UPSTREAM_AUTHORIZATION='Bearer replace-me'
mcp-trace proxy \
  --upstream https://mcp.example.com/mcp \
  --upstream-header-env Authorization=MCP_UPSTREAM_AUTHORIZATION
```

Authorization and cookie headers are never written to recordings.

## No spans appear in the backend

1. Supply an OTLP/HTTP endpoint with `--otlp-endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT`.
2. MCP Trace appends `/v1/traces` when the URL does not already end with that path.
3. Confirm that the backend accepts OTLP over HTTP with JSON encoding, not only OTLP/gRPC.
4. Supply exporter credentials with `--otlp-header-env Header=ENVIRONMENT_VARIABLE`.
5. Shut the process down normally so the batch span processor flushes buffered spans.

The local Compose demo is a known-good reference:

```bash
docker compose -f docker-compose.demo.yml up --build --detach
```

## The client waits for an SSE response

The gateway streams upstream SSE chunks and does not wait for the final event. Confirm that the
upstream sends `Content-Type: text/event-stream`, flushes an event delimiter (`\n\n`), and does not
sit behind another buffering proxy. The gateway preserves `X-Accel-Buffering` when supplied by the
upstream.

## A request returns `413`

The default maximum forwarded request body is 4 MiB. Change it deliberately:

```bash
mcp-trace proxy --max-request-body 8MiB --upstream http://127.0.0.1:3001/mcp
```

The recording capture limit is separate and defaults to 256 KiB per body. Truncated recorded bodies
are marked and are not replayed.

## Replay skips entries

Replay skips requests without a captured body and entries whose bodies are binary, truncated, or
redacted. Body capture must have been explicitly enabled when the recording was made. Redacted
payloads remain blocked unless `--allow-redacted` is supplied; that flag does not reconstruct the
removed value.

## A recording cannot be shared safely

That is expected. Redaction is defense in depth, not a guarantee that arbitrary payloads are free of
sensitive data. Keep recordings owner-readable, inspect them manually, and create a purpose-built
synthetic reproduction before filing a public issue.
