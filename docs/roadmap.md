# Roadmap

MCP Trace is intentionally a small observability gateway, not an MCP registry or enterprise control
plane. Roadmap items must preserve transparent streaming, a fixed upstream, safe recording defaults,
and an auditable trust boundary.

## Delivered

### stdio proxying

The `stdio` command launches one fixed upstream executable without a shell and forwards
newline-delimited JSON-RPC bytes in both directions with backpressure and bounded framing. It keeps
child stderr outside protocol stdout, propagates EOF and shutdown, exposes an optional minimal
environment, and writes transport-neutral v2 message recordings. Cross-platform package CI runs the
same process integration tests on Linux, macOS, and Windows.

### Lower-overhead native upstream transport

The default HTTP and HTTPS upstream hop uses Node's native client instead of converting every
response through Fetch and Web Streams. Manual redirects, streaming backpressure, disconnect
cancellation, header filtering, and the injectable Fetch path remain covered. Complete same-host
before/after benchmark samples are published with the benchmark documentation.

### Native multi-architecture container verification

Container CI builds and starts MCP Trace on GitHub-hosted native `linux/amd64` and `linux/arm64`
runners. Each job verifies the image architecture and validates the running health endpoint; this is
separate from the QEMU/Buildx multi-architecture release build.

### Read-only local report

`mcp-trace report` produces a deterministic, self-contained HTML summary without starting a
listener. It escapes recording-derived values, exposes capture/redaction and malformed-line state,
omits captured bodies, and protects existing output unless overwrite is explicit.

## Explicit non-goals

- Server discovery, registration, aggregation, or dynamic routing.
- Client authentication and per-tool authorization policy.
- A hosted telemetry backend or mandatory cloud service.
- Claiming that redaction makes production recordings safe to publish.
- Registering MCP Trace as an MCP server merely for directory exposure.

Open a focused issue before implementing a roadmap item that changes a trust boundary or adds a
runtime dependency.
