# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Optional `--max-recording-size` retention for HTTP and stdio recordings, with serialized
  whole-line admission, existing-file accounting, one-shot diagnostics, and bounded metric/state
  visibility while preserving unlimited recording by default.
- Secure stdio process proxying with no-shell execution, byte-transparent bounded framing,
  bidirectional JSON-RPC correlation, child lifecycle handling, and transport-neutral v2 recordings.
- Offline, deterministic HTML recording reports with body-free summaries, hostile-value escaping,
  malformed-line accounting, and overwrite protection.
- CI-verified interoperability with the official Python MCP SDK 2.1.1 on Python 3.13 using an
  isolated, locked test fixture.
- Reproducible SSE, metadata-recording, body-recording, and OTLP benchmark scenarios with
  machine-readable evidence and backward-compatible default-path results.

### Fixed

- Preserve the `mcp-trace` executable in npm 12 package manifests and smoke-test the exact
  npm-packed artifact used by the release workflow.

### Changed

- Use Node's native HTTP/HTTPS client for the default upstream hop, reducing loopback JSON and SSE
  latency and increasing throughput while preserving streaming, cancellation, manual redirects,
  header hardening, and custom Fetch injection.

## 0.2.0 - 2026-08-14

### Added

- Publishable npm trusted-publishing workflow with a clean-consumer installation and proxy smoke
  test.
- Deterministic local demo and a Docker Compose demonstration with Jaeger.
- Multi-architecture `linux/amd64` and `linux/arm64` container release manifests with SBOM and
  provenance.
- Compatibility matrix, troubleshooting guide, scoped roadmap, searchable documentation site, social
  preview, and real demo output.
- End-to-end compatibility coverage using the official TypeScript MCP SDK 1.30.0 as both client and
  server.
- Versioned five-run benchmark samples with an output-file mode for reproducible evidence.

### Changed

- Lead documentation with a zero-install quick start, explicit early-preview status, and the narrow
  security boundary.
- Publish complete release notes from this changelog instead of generated commit summaries.
- Alternate benchmark path ordering and report medians across multiple samples.

### Known limitations

- stdio and the legacy `2024-11-05` HTTP+SSE discovery flow remain unsupported.
- The current loopback JSON benchmark shows material default-path proxy overhead; results are
  published as an optimization baseline rather than a capacity claim.

## 0.1.1 - 2026-08-13

### Fixed

- Align Node.js 20 development guidance with the pnpm 10.34.0 toolchain used by the package and CI.
- Report the package version consistently in the CLI and OpenTelemetry resource/tracer metadata.
- Avoid a check/use race when inspecting recording permissions and contents in the test suite.

### Changed

- Keep Dependabot major updates within the project's Node.js and TypeScript peer-support ranges.

## 0.1.0 - 2026-08-13

### Added

- Transparent JSON and SSE proxying for modern and legacy Streamable HTTP.
- Host/Origin validation, bounded requests, header hardening, and cancellation propagation.
- Structured logs, bounded-cardinality Prometheus metrics, and OTLP/HTTP tracing.
- Metadata-only NDJSON recording with optional sanitized body capture.
- Recording inspection and dry-run-by-default replay with rate/concurrency controls.
- Strict TypeScript, integration tests, coverage gates, CI, CodeQL, Docker, and release packaging.
