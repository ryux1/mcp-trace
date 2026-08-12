# Local demo

Start the dependency-free mock MCP upstream:

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

Send a modern MCP request through the gateway:

```bash
curl --no-buffer http://127.0.0.1:7331/mcp \
  --request POST \
  --header 'Accept: application/json, text/event-stream' \
  --header 'Content-Type: application/json' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: tools/call' \
  --header 'Mcp-Name: echo' \
  --data @examples/request.json
```

Change both `echo` values in `examples/request.json` to `stream` to receive a two-event SSE
response. Inspect the recording with:

```bash
node dist/cli.js inspect .local/demo.ndjson
```

The mock server exists only for local testing. It does not implement authorization or the complete
MCP lifecycle.
