# Roadmap

MCP Trace is intentionally a small observability gateway, not an MCP registry or enterprise control
plane. Roadmap items must preserve transparent streaming, a fixed upstream, safe recording defaults,
and an auditable trust boundary.

## Near term

- Add named Python SDK interoperability tests and publish their exact versions.
- Add benchmark scenarios for SSE, recording, and OTLP export.
- Improve default-path overhead identified by the checked-in benchmark baseline.
- Add native `linux/arm64` container runtime coverage beyond the release build gate.

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

### Read-only local report

A local HTML report could make recordings easier to understand without adding a persistent service.
It must operate offline, escape all captured values, make redaction status visible, and avoid
exposing recordings over a network listener by default.

## Explicit non-goals

- Server discovery, registration, aggregation, or dynamic routing.
- Client authentication and per-tool authorization policy.
- A hosted telemetry backend or mandatory cloud service.
- Claiming that redaction makes production recordings safe to publish.
- Registering MCP Trace as an MCP server merely for directory exposure.

Open a focused issue before implementing a roadmap item that changes a trust boundary or adds a
runtime dependency.
