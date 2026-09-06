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
BENCHMARK_CONCURRENCY=64 \
BENCHMARK_RUNS=7 \
pnpm benchmark
```

Write machine-readable output directly to a file:

```bash
BENCHMARK_OUTPUT=.local/benchmark.json pnpm benchmark
```

## What it measures

The benchmark compares a client calling a local in-process JSON upstream directly with the same
client calling it through MCP Trace. It uses the same body, headers, concurrency, and response for
both paths. Recording and OTLP export are disabled, so the proxied result measures the default
gateway path: request validation, MCP metadata extraction, span creation, metrics, header handling,
and an additional HTTP hop.

## What it does not measure

Loopback networking, Node version, CPU scheduling, response size, SSE duration, recording, disk
speed, OpenTelemetry export, TLS, upstream latency, and client behavior materially affect results.
Run the benchmark on intended deployment hardware and representative traffic before using it for
capacity decisions.

Future benchmark revisions should add long-lived SSE, metadata recording, body recording, and OTLP
export scenarios while retaining this baseline for regression comparison.
