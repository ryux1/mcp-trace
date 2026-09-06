# Compatibility

This page distinguishes code-backed guarantees from assumptions. “Verified” means the repository's
automated integration suite exercises the behavior with real local HTTP servers on every supported
Node.js line.

## Runtime matrix

| Surface                         | Status        | Evidence                                                        |
| ------------------------------- | ------------- | --------------------------------------------------------------- |
| Node.js 20.19                   | Verified      | CI verification, package build, unit and HTTP integration tests |
| Node.js 22                      | Verified      | CI verification, package build, unit and HTTP integration tests |
| Node.js 24                      | Verified      | CI plus clean-consumer package and end-to-end demo smoke tests  |
| `linux/amd64` container         | Verified      | CI image build and release manifest                             |
| `linux/arm64` container         | Release-gated | QEMU/Buildx release build; no native hardware test yet          |
| macOS and Windows npm execution | CI-gated      | Clean-consumer package and end-to-end demo jobs on hosted CI    |

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
| Official TypeScript SDK 1.30.0              | Verified     | SDK client and server initialization, `tools/list`, and `tools/call`       |
| Redirect following                          | Rejected     | Upstream requests use manual redirect handling                             |
| Legacy `2024-11-05` HTTP+SSE discovery flow | Not targeted | Requires separate endpoint-discovery behavior                              |
| stdio                                       | Unsupported  | Requires a separately designed process and credential boundary             |

The suite verifies protocol behavior at the wire level and includes an end-to-end test using version
1.30.0 of the official TypeScript SDK on both sides of the gateway. Python SDK compatibility is not
yet claimed. Please report the client/server SDK versions with interoperability issues.

## Operational boundaries

- One fixed upstream MCP endpoint is configured at startup.
- MCP Trace does not discover, register, aggregate, or dynamically select servers.
- It forwards authorization but does not authenticate clients or authorize MCP methods.
- Browser `Origin` values are rejected unless explicitly allowed.
- Non-loopback listeners require explicit `Host` allowlisting.
- Body recording and replay execution are opt-in.

See the [security model](security.md) for the threat boundary and [roadmap](roadmap.md) for the
criteria governing additional transports.
