import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { McpTraceGateway, createTelemetry } from "../dist/index.js";

const REQUEST_BODY = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    arguments: { value: "benchmark" },
    name: "echo"
  }
});

const REQUEST_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-method": "tools/call",
  "mcp-name": "echo",
  "mcp-protocol-version": "2026-07-28"
};

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

function median(values) {
  return percentile(values, 0.5);
}

function delta(direct, proxied) {
  return {
    p50Ms: Number((proxied.p50Ms - direct.p50Ms).toFixed(3)),
    p95Ms: Number((proxied.p95Ms - direct.p95Ms).toFixed(3)),
    throughputPercent: Number(
      ((proxied.requestsPerSecond / direct.requestsPerSecond) * 100 - 100).toFixed(1)
    )
  };
}

function summarize(samples, path) {
  return {
    durationMs: median(samples.map((sample) => sample[path].durationMs)),
    p50Ms: median(samples.map((sample) => sample[path].p50Ms)),
    p95Ms: median(samples.map((sample) => sample[path].p95Ms)),
    p99Ms: median(samples.map((sample) => sample[path].p99Ms)),
    requestsPerSecond: median(samples.map((sample) => sample[path].requestsPerSecond))
  };
}

function summarizeDelta(samples) {
  return {
    p50Ms: median(samples.map((sample) => sample.delta.p50Ms)),
    p95Ms: median(samples.map((sample) => sample.delta.p95Ms)),
    throughputPercent: median(samples.map((sample) => sample.delta.throughputPercent))
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Benchmark server did not expose a TCP port");
  }
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function runLoad(url, requests, concurrency) {
  let cursor = 0;
  const latencies = [];
  const startedAt = performance.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < requests) {
      cursor += 1;
      const requestStartedAt = performance.now();
      const response = await fetch(url, {
        body: REQUEST_BODY,
        headers: REQUEST_HEADERS,
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Benchmark request failed with HTTP ${response.status}`);
      }
      await response.arrayBuffer();
      latencies.push(performance.now() - requestStartedAt);
    }
  });
  await Promise.all(workers);
  const durationMs = performance.now() - startedAt;
  return {
    durationMs: Number(durationMs.toFixed(3)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    requestsPerSecond: Number(((requests / durationMs) * 1_000).toFixed(1))
  };
}

const requestCount = Number.parseInt(process.env.BENCHMARK_REQUESTS ?? "2000", 10);
const concurrency = Number.parseInt(process.env.BENCHMARK_CONCURRENCY ?? "32", 10);
const runCount = Number.parseInt(process.env.BENCHMARK_RUNS ?? "5", 10);
if (!Number.isInteger(requestCount) || requestCount <= 0) {
  throw new Error("BENCHMARK_REQUESTS must be a positive integer");
}
if (!Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error("BENCHMARK_CONCURRENCY must be a positive integer");
}
if (!Number.isInteger(runCount) || runCount <= 0) {
  throw new Error("BENCHMARK_RUNS must be a positive integer");
}

const upstreamServer = createServer(async (request, response) => {
  for await (const chunk of request) {
    // Consume the request body.
    void chunk;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"id":1,"jsonrpc":"2.0","result":{"ok":true}}');
});

const upstream = await listen(upstreamServer);
const gateway = new McpTraceGateway({
  port: 0,
  telemetry: createTelemetry({ serviceName: "mcp-trace-benchmark" }),
  upstream
});
const gatewayAddress = await gateway.start();
const gatewayUrl = new URL(`http://127.0.0.1:${gatewayAddress.port}/mcp`);

try {
  await runLoad(upstream, 200, concurrency);
  await runLoad(gatewayUrl, 200, concurrency);
  const samples = [];
  for (let run = 0; run < runCount; run += 1) {
    let direct;
    let proxied;
    if (run % 2 === 0) {
      direct = await runLoad(upstream, requestCount, concurrency);
      proxied = await runLoad(gatewayUrl, requestCount, concurrency);
    } else {
      proxied = await runLoad(gatewayUrl, requestCount, concurrency);
      direct = await runLoad(upstream, requestCount, concurrency);
    }
    samples.push({ delta: delta(direct, proxied), direct, proxied, run: run + 1 });
  }
  const direct = summarize(samples, "direct");
  const proxied = summarize(samples, "proxied");
  const result = {
    benchmarkVersion: 1,
    environment: { arch: arch(), node: process.version, platform: platform() },
    samples,
    summary: {
      delta: summarizeDelta(samples),
      direct,
      proxied
    },
    workload: {
      concurrency,
      requestBytes: Buffer.byteLength(REQUEST_BODY),
      requestCount,
      runs: runCount
    }
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = process.env.BENCHMARK_OUTPUT;
  if (output === undefined) {
    process.stdout.write(serialized);
  } else {
    await writeFile(output, serialized);
    process.stdout.write(
      `${JSON.stringify({ output, summary: result.summary, workload: result.workload }, null, 2)}\n`
    );
  }
} finally {
  await gateway.close();
  await new Promise((resolve) => upstreamServer.close(resolve));
}
