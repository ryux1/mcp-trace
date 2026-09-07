# Compatibility

This page distinguishes code-backed guarantees from assumptions. “Verified” means the repository's
automated integration suite exercises the behavior with real local HTTP servers on every supported
Node.js line.

## Runtime matrix

| Surface                         | Status   | Evidence                                                        |
| ------------------------------- | -------- | --------------------------------------------------------------- |
| Node.js 20.19                   | Verified | CI verification, package build, unit and HTTP integration tests |
| Node.js 22                      | Verified | CI verification, package build, unit and HTTP integration tests |
| Node.js 24                      | Verified | CI plus clean-consumer package and end-to-end demo smoke tests  |
| `linux/amd64` container         | Verified | Native CI image build, runtime smoke test, and release manifest |
| `linux/arm64` container         | Verified | Native CI image build and runtime smoke test; release manifest  |
| macOS and Windows npm execution | CI-gated | Clean-consumer package and end-to-end demo jobs on hosted CI    |

## Protocol and transport matrix

| Behavior                                    | Status       | Coverage                                                                   |
| ------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `2026-07-28` Streamable HTTP POST with JSON | Verified     | Header/body metadata, propagation, response forwarding, metrics, recording |
| `2026-07-28` request-scoped SSE response    | Verified     | First-chunk streaming, backpressure path, recording sanitization           |
| `2025-03-26` through `2025-11-25` POST      | Verified     | Legacy protocol/session headers and JSON/SSE forwarding                    |
| Standalone GET SSE and DELETE               | Verified     | Method routing and response streaming                                      |
| W3C HTTP Trace Context                      | Verified     | Parent extraction, child span, upstream injection                          |
| MCP `_meta` trace fields                    | Verified     | Preserved without rewriting                                                |
| OTLP/HTTP JSON export                       | Verified     | Completed spans received by a local collector endpoint on shutdown         |
| Offline HTML recording report               | Verified     | Deterministic rendering, hostile metadata escaping, no remote resources    |
| Official TypeScript SDK 1.30.0              | Verified     | HTTP and stdio initialization, `tools/list`, and `tools/call`              |
| Official Python SDK 2.1.1 on Python 3.13    | Verified     | SDK client and server initialization, `tools/list`, and `tools/call`       |
| Redirect following                          | Rejected     | Upstream requests use manual redirect handling                             |
| Legacy `2024-11-05` HTTP+SSE discovery flow | Not targeted | Requires separate endpoint-discovery behavior                              |
| stdio newline framing                       | Verified     | Exact-byte forwarding, split/coalesced chunks, CRLF, size and EOF bounds   |
| stdio child lifecycle                       | Verified     | Normal EOF, abnormal exit propagation, SIGINT/SIGTERM shutdown             |
| stdio v2 recording                          | Verified     | Both directions, request correlation, metadata-only and redacted bodies    |

The suite verifies protocol behavior at the wire level and includes end-to-end tests using version
1.30.0 of the official TypeScript SDK and version 2.1.1 of the official Python SDK on both sides of
the gateway. The Python fixture runs in an isolated, locked environment on Python 3.13. Please
report the client/server SDK versions with interoperability issues.

## Operational boundaries

- One fixed upstream MCP endpoint is configured at startup.
- MCP Trace does not discover, register, aggregate, or dynamically select servers.
- It forwards authorization but does not authenticate clients or authorize MCP methods.
- Browser `Origin` values are rejected unless explicitly allowed.
- Non-loopback listeners require explicit `Host` allowlisting.
- Body recording and replay execution are opt-in.
- stdio commands are executed directly without a shell; child stderr remains outside protocol
  stdout.
- stdio children inherit the current environment unless `--clear-env` is selected.
- HTML report generation is offline, read-only with respect to the input, and body-value free.

See the [security model](security.md) for the threat boundary and [roadmap](roadmap.md) for the
criteria governing additional transports.
