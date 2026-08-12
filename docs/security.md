# Security and threat model

MCP traffic can contain credentials, local file URIs, user data, tool arguments, and destructive
operations. MCP Trace therefore treats observability data as sensitive.

## Protected assets

- upstream authorization headers and cookies;
- MCP tool arguments and results;
- legacy session identifiers;
- local network access exposed by an MCP server;
- replay targets and their side effects;
- OTLP exporter credentials.

## Network defaults

The gateway binds to `127.0.0.1`, validates Host on every endpoint, and validates Origin on the MCP
endpoint. A same-origin browser request is allowed; other browser origins require an exact
`--allow-origin` value.

Wildcard binds (`0.0.0.0` or `::`) reject every Host until `--allow-host` is configured. Avoid
`--allow-origin '*'` unless another trusted layer provides authentication and DNS-rebinding
protection.

MCP Trace does not provide client authentication. If the listener is reachable by other users or
machines, put it behind an authenticated reverse proxy or service mesh. The fixed upstream URL
prevents incoming requests from selecting arbitrary destinations.

## Forwarded headers

Authorization and application headers are forwarded to the fixed upstream but excluded from
recordings. Standard and dynamically nominated hop-by-hop headers are removed. Incoming `Forwarded`
and `X-Forwarded-*` headers are stripped so an untrusted client cannot spoof an earlier proxy hop.

Supply upstream and OTLP credentials indirectly with `--upstream-header-env` and
`--otlp-header-env`; URLs containing embedded credentials are rejected.

## Recording defaults

- No recording occurs unless `--record` is supplied.
- Recordings contain metadata, safe headers, timings, and byte counts by default.
- Bodies require the additional `--record-bodies` flag.
- Files and newly created parent directories use owner-only permissions (`0600` and `0700`).
- `Authorization`, cookies, API-key headers, and session IDs are never stored verbatim.
- `Mcp-Session-Id` is represented only by a truncated SHA-256 correlation hash.
- Query parameters and JSON keys with secret-like names are redacted.
- Common Bearer, OpenAI-style, GitHub, and AWS access-key patterns are redacted from text.
- JSON and SSE bodies are sanitized recursively. Malformed/truncated JSON remains text and receives
  heuristic key/token redaction instead of being stored as reversible base64.

Binary payloads cannot be structurally redacted and are explicitly marked `redacted: false`. Review
the [recording schema](recording-schema.md).

## Redaction limitations

Redaction is best effort. It cannot reliably identify every proprietary token format, secrets
embedded in natural language, encrypted data, compressed payloads, or semantically sensitive values
with innocent key names.

Use `--redact-key` for domain-specific fields. Keep recordings short-lived, avoid shared paths,
encrypt storage at rest, and inspect files before transferring them. Do not treat the absence of a
known token pattern as proof that a recording is safe to publish.

## Replay

Tool calls can send messages, mutate databases, charge accounts, or delete data. Replay therefore:

- performs a dry run unless `--execute` is present;
- skips truncated and binary bodies;
- skips entries containing redaction placeholders unless `--allow-redacted` is explicit;
- drops recorded session IDs and never reuses recorded authorization;
- supports a timeout, concurrency bound, and global rate limit;
- does not follow redirects.

Use replay against an isolated test target whenever possible. The tool cannot determine whether an
MCP method is idempotent.

## Telemetry

Metrics use MCP method names but not tool/resource names, and the method label set is bounded. Spans
can include tool/resource names and upstream addresses. Treat the OTLP collector as a trusted data
processor and protect it with TLS and authentication outside local development.

MCP Trace preserves body-level `_meta` trace context without modification and propagates the HTTP
W3C Trace Context separately.

## Dependency and release controls

- pnpm uses a frozen lockfile in CI.
- Dependency lifecycle scripts are denied except for the explicit `esbuild` allowlist.
- CI runs formatting, lint, strict type checks, tests with coverage thresholds, builds, and package
  inspection.
- CodeQL scans JavaScript/TypeScript changes.
- Release artifacts include SHA-256 checksums.

Report vulnerabilities privately as described in [`SECURITY.md`](../SECURITY.md).
