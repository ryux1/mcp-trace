# Roadmap

MCP Trace is intentionally a small observability gateway, not an MCP registry or enterprise control
plane. Roadmap items must preserve transparent streaming, a fixed upstream, safe recording defaults,
and an auditable trust boundary.

## Near term

- Improve default-path overhead identified by the checked-in benchmark baseline.

## Delivered

### Native multi-architecture container verification

Container CI builds and starts MCP Trace on GitHub-hosted native `linux/amd64` and `linux/arm64`
runners. Each job verifies the image architecture and validates the running health endpoint; this is
separate from the QEMU/Buildx multi-architecture release build.

### Read-only local report

`mcp-trace report` produces a deterministic, self-contained HTML summary without starting a
listener. It escapes recording-derived values, exposes capture/redaction and malformed-line state,
omits captured bodies, and protects existing output unless overwrite is explicit.

## Under evaluation

### stdio proxying

stdio would make the tool useful for more local MCP development, but it adds process lifecycle,
environment inheritance, standard-error handling, executable selection, and credential-boundary
questions. It will be accepted only with:

- an explicit child-process and environment threat model;
- no accidental credential recording;
- byte-transparent JSON-RPC framing and cancellation behavior;
- cross-platform lifecycle tests;
- an interface that does not weaken the fixed-upstream HTTP mode.

## Explicit non-goals

- Server discovery, registration, aggregation, or dynamic routing.
- Client authentication and per-tool authorization policy.
- A hosted telemetry backend or mandatory cloud service.
- Claiming that redaction makes production recordings safe to publish.
- Registering MCP Trace as an MCP server merely for directory exposure.

Open a focused issue before implementing a roadmap item that changes a trust boundary or adds a
runtime dependency.
