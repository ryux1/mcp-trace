# Demonstrations

## Automated local demo

The fastest source-checkout demonstration is:

```bash
pnpm install --frozen-lockfile
pnpm demo
```

It builds MCP Trace, allocates ephemeral localhost ports, starts the dependency-free mock upstream,
records a real `tools/call`, verifies that the fixture credential is absent from the recording,
prints a recording summary and Prometheus evidence, and removes its processes and temporary files.

The expected shape is checked into
[`../docs/assets/demo-output.svg`](../docs/assets/demo-output.svg). Values that naturally vary, such
as latency and timestamps, are omitted from that visual.

## Jaeger Compose demo

With Docker Compose installed:

```bash
docker compose -f docker-compose.demo.yml up --build --detach
```

The one-shot `demo-client` sends a modern request after MCP Trace is healthy. Open
`http://127.0.0.1:16686`; in Jaeger, select the `mcp-trace` service and find the `mcp.proxy` span.
Stop and clean up the isolated stack with:

```bash
docker compose -f docker-compose.demo.yml down --volumes
```

## Manual flow

Start the mock MCP upstream:

```bash
node examples/mock-mcp-server.mjs
```

In a second terminal, build and start the gateway with sanitized body recording:

```bash
pnpm build
node dist/cli.js proxy \
  --upstream http://127.0.0.1:3001/mcp \
  --record .local/demo.ndjson \
  --record-bodies
```

Send a request from a third terminal:

```bash
node examples/send-demo-request.mjs
```

Change both `echo` values in `examples/request.json` to `stream` to receive a two-event SSE
response. Inspect the recording with:

```bash
node dist/cli.js inspect .local/demo.ndjson
```

The mock server exists only for demonstrations and tests. It does not implement authorization or the
complete MCP lifecycle.
