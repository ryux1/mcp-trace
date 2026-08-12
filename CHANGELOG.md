# Changelog

All notable changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-08-13

### Added

- Transparent JSON and SSE proxying for modern and legacy Streamable HTTP.
- Host/Origin validation, bounded requests, header hardening, and cancellation propagation.
- Structured logs, bounded-cardinality Prometheus metrics, and OTLP/HTTP tracing.
- Metadata-only NDJSON recording with optional sanitized body capture.
- Recording inspection and dry-run-by-default replay with rate/concurrency controls.
- Strict TypeScript, integration tests, coverage gates, CI, CodeQL, Docker, and release packaging.
