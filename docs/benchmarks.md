# Benchmarks

MCP Trace publishes its proxy cost as regression evidence. It does not claim that a loopback
microbenchmark predicts production capacity.

## Current baseline

The checked-in `0.2.0` baseline contains five alternating direct/proxied runs on Linux x64 with
Node.js 24.18.1. Each run sends 2,000 170-byte JSON requests at concurrency 32.

| Path    | Median p50 | Median p95 | Median p99 | Median throughput |
| ------- | ---------- | ---------- | ---------- | ----------------- |
| Direct  | 6.449 ms   | 10.237 ms  | 12.908 ms  | 4,678.8 req/s     |
| Proxied | 16.956 ms  | 23.580 ms  | 25.850 ms  | 1,788.2 req/s     |

Across the five paired samples, the median proxy delta was +10.094 ms at p50, +13.906 ms at p95, and
-61.3% throughput. These numbers are deliberately visible because the default path has a material
cost for tiny local responses. Treat them as an optimization baseline, not a performance
endorsement.

The complete samples and environment fields are in
[`benchmark-results/v0.2.0-linux-x64-node24.json`](benchmark-results/v0.2.0-linux-x64-node24.json).

## Reproduce the baseline

```bash
pnpm benchmark
```

The script performs warm-up requests, alternates direct/proxied ordering to reduce order bias, and
reports all samples plus medians. Tune the workload without editing the script:

```bash
BENCHMARK_REQUESTS=10000 \
BENCHMARK_FEATURE_REQUESTS=500 \
BENCHMARK_CONCURRENCY=64 \
BENCHMARK_RUNS=7 \
pnpm benchmark
```

Write machine-readable output directly to a file:

```bash
BENCHMARK_OUTPUT=.local/benchmark.json pnpm benchmark
```

## Scenarios

Every run now emits five named scenarios under `scenarios` while retaining the original top-level
`samples`, `summary`, and `workload` fields for consumers of the version 1 JSON benchmark. Those
top-level fields continue to describe the default JSON scenario.

| Scenario            | Reference | Candidate                | Additional evidence                      |
| ------------------- | --------- | ------------------------ | ---------------------------------------- |
| `json`              | Direct    | Proxied                  | —                                        |
| `sse`               | Direct    | Proxied                  | Finite request-scoped SSE body           |
| `recordingMetadata` | Proxy     | Proxy + metadata NDJSON  | Recording bytes and exchange count       |
| `recordingBodies`   | Proxy     | Proxy + body NDJSON      | Recording bytes and exchange count       |
| `otlp`              | Proxy     | Proxy + OTLP/HTTP export | Export batches, bytes, and shutdown time |

The JSON and SSE comparisons use the same body, headers, concurrency, and response for the direct
and proxied paths. The recording and OTLP comparisons use an otherwise identical uninstrumented
proxy as their reference, isolating the optional feature cost from the base proxy cost. Warm-up
requests are included in recording exchange counts and OTLP export evidence but excluded from timed
samples.

The OTLP request timings measure span creation and batching on the request path. Because the
benchmark closes the telemetry provider after the timed requests, `export.shutdownMs` separately
reports the time required to flush the batch to the local collector. The exporter result includes
the decoded span count, and the run fails if it does not match the number of candidate requests.
Optional recording and OTLP scenarios default to at most 200 requests per timed run to stay within
the telemetry batch queue; tune that bound with `BENCHMARK_FEATURE_REQUESTS`. Temporary recording
files and all local servers and telemetry providers are removed or closed before the process exits.

## What it does not measure

Loopback networking, Node version, CPU scheduling, response size, long-lived SSE connections, disk
speed, collector latency, batch configuration, TLS, upstream latency, and client behavior materially
affect results. The SSE fixture is a bounded request-scoped response, not a soak test. The OTLP
collector accepts payloads in memory and is not representative of a remote telemetry backend. Run
the benchmark on intended deployment hardware and representative traffic before using it for
capacity decisions.
