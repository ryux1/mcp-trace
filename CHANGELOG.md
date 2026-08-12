# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
