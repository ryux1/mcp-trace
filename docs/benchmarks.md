# Benchmarks

The benchmark compares a client calling a local in-process JSON upstream directly with the same
client calling it through MCP Trace. It uses the same body, headers, concurrency, and response for
both paths.

```bash
pnpm benchmark
```

Tune the workload without editing the script:

```bash
BENCHMARK_REQUESTS=10000 BENCHMARK_CONCURRENCY=64 pnpm benchmark
```

The output is JSON containing environment information, p50/p95/p99 latency, throughput, and the
proxied-minus-direct delta. The benchmark performs warm-up runs before measurement.

This is a microbenchmark, not a production capacity claim. Loopback networking, Node version, CPU
scheduling, OpenTelemetry configuration, response size, SSE duration, recording, and disk speed can
materially change results. Run it on the intended deployment hardware and workload. Body recording
is disabled in the benchmark so the result measures the default gateway path.
