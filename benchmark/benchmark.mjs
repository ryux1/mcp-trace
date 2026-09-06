import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { McpTraceGateway, NdjsonRecorder, createTelemetry } from "../dist/index.js";
import { delta, percentile, positiveInteger, summarizeScenario } from "./helpers.mjs";

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
const JSON_RESPONSE = '{"id":1,"jsonrpc":"2.0","result":{"ok":true}}';
const SSE_RESPONSE = `event: message\ndata: ${JSON_RESPONSE}\n\n`;

async function listen(server, path = "/mcp") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Benchmark server did not expose a TCP port");
  return new URL(`http://127.0.0.1:${address.port}${path}`);
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
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
      if (!response.ok) throw new Error(`Benchmark request failed with HTTP ${response.status}`);
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

async function runScenario(referenceUrl, candidateUrl, options) {
  const warmupRequests = Math.min(200, options.requestCount);
  await runLoad(referenceUrl, warmupRequests, options.concurrency);
  await runLoad(candidateUrl, warmupRequests, options.concurrency);
  const samples = [];
  for (let run = 0; run < options.runCount; run += 1) {
    let reference;
    let candidate;
    if (run % 2 === 0) {
      reference = await runLoad(referenceUrl, options.requestCount, options.concurrency);
      candidate = await runLoad(candidateUrl, options.requestCount, options.concurrency);
    } else {
      candidate = await runLoad(candidateUrl, options.requestCount, options.concurrency);
      reference = await runLoad(referenceUrl, options.requestCount, options.concurrency);
    }
    samples.push({ candidate, delta: delta(reference, candidate), reference, run: run + 1 });
  }
  return {
    candidateLabel: options.candidateLabel,
    referenceLabel: options.referenceLabel,
    samples,
    summary: summarizeScenario(samples),
    workload: {
      concurrency: options.concurrency,
      requestBytes: Buffer.byteLength(REQUEST_BODY),
      requestCount: options.requestCount,
      runs: options.runCount
    }
  };
}

async function startGateway(upstream, options = {}) {
  const gateway = new McpTraceGateway({
    port: 0,
    telemetry: options.telemetry ?? createTelemetry({ serviceName: "mcp-trace-benchmark" }),
    upstream,
    ...(options.recorder === undefined ? {} : { recorder: options.recorder }),
    ...(options.recordBodies === undefined ? {} : { recordBodies: options.recordBodies })
  });
  const address = await gateway.start();
  return { gateway, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

async function benchmarkDirect(upstream, options) {
  const proxy = await startGateway(upstream);
  try {
    return await runScenario(upstream, proxy.url, {
      ...options,
      candidateLabel: "proxied",
      referenceLabel: "direct"
    });
  } finally {
    await proxy.gateway.close();
  }
}

async function benchmarkRecording(upstream, options, directory, recordBodies) {
  const path = join(directory, recordBodies ? "bodies.ndjson" : "metadata.ndjson");
  const recorder = await NdjsonRecorder.create(path);
  const reference = await startGateway(upstream);
  const candidate = await startGateway(upstream, { recordBodies, recorder });
  try {
    const scenario = await runScenario(reference.url, candidate.url, {
      ...options,
      candidateLabel: recordBodies ? "proxy+body recording" : "proxy+metadata recording",
      referenceLabel: "proxy"
    });
    await candidate.gateway.close();
    const contents = await readFile(path, "utf8");
    return {
      ...scenario,
      recording: {
        bytes: (await stat(path)).size,
        exchanges: contents.trim() === "" ? 0 : contents.trim().split("\n").length
      }
    };
  } finally {
    await Promise.all([reference.gateway.close(), candidate.gateway.close()]);
  }
}

async function benchmarkOtlp(upstream, options) {
  const exports = [];
  const collector = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const payload = JSON.parse(body.toString("utf8"));
    const spans = (payload.resourceSpans ?? []).reduce(
      (resourceTotal, resource) =>
        resourceTotal +
        (resource.scopeSpans ?? []).reduce(
          (scopeTotal, scope) => scopeTotal + (scope.spans ?? []).length,
          0
        ),
      0
    );
    exports.push({ bytes: body.byteLength, path: request.url ?? "", spans });
    response.writeHead(200);
    response.end();
  });
  const endpoint = await listen(collector, "/v1/traces");
  const reference = await startGateway(upstream);
  const candidate = await startGateway(upstream, {
    telemetry: createTelemetry({
      endpoint: endpoint.toString(),
      serviceName: "mcp-trace-benchmark"
    })
  });
  try {
    const scenario = await runScenario(reference.url, candidate.url, {
      ...options,
      candidateLabel: "proxy+OTLP export",
      referenceLabel: "proxy"
    });
    const shutdownStartedAt = performance.now();
    await candidate.gateway.close();
    const expectedSpans =
      Math.min(200, options.requestCount) + options.requestCount * options.runCount;
    const exportedSpans = exports.reduce((total, entry) => total + entry.spans, 0);
    if (exportedSpans !== expectedSpans) {
      throw new Error(
        `OTLP benchmark exported ${exportedSpans} of ${expectedSpans} expected spans`
      );
    }
    return {
      ...scenario,
      export: {
        batches: exports.length,
        bytes: exports.reduce((total, entry) => total + entry.bytes, 0),
        spans: exportedSpans,
        shutdownMs: Number((performance.now() - shutdownStartedAt).toFixed(3))
      }
    };
  } finally {
    await Promise.all([
      reference.gateway.close(),
      candidate.gateway.close(),
      closeServer(collector)
    ]);
  }
}

const requestCount = positiveInteger(
  process.env.BENCHMARK_REQUESTS ?? "2000",
  "BENCHMARK_REQUESTS"
);
const concurrency = positiveInteger(
  process.env.BENCHMARK_CONCURRENCY ?? "32",
  "BENCHMARK_CONCURRENCY"
);
const runCount = positiveInteger(process.env.BENCHMARK_RUNS ?? "5", "BENCHMARK_RUNS");
const options = { concurrency, requestCount, runCount };
const featureRequestCount = positiveInteger(
  process.env.BENCHMARK_FEATURE_REQUESTS ?? String(Math.min(requestCount, 200)),
  "BENCHMARK_FEATURE_REQUESTS"
);
const featureOptions = { concurrency, requestCount: featureRequestCount, runCount };
const upstreamServer = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  if (request.url?.startsWith("/sse") === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(SSE_RESPONSE);
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON_RESPONSE);
  }
});
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mcp-trace-benchmark-"));
const jsonUpstream = await listen(upstreamServer, "/json");
const sseUpstream = new URL("/sse", jsonUpstream);

try {
  const json = await benchmarkDirect(jsonUpstream, options);
  const sse = await benchmarkDirect(sseUpstream, options);
  const recordingMetadata = await benchmarkRecording(
    jsonUpstream,
    featureOptions,
    temporaryDirectory,
    false
  );
  const recordingBodies = await benchmarkRecording(
    jsonUpstream,
    featureOptions,
    temporaryDirectory,
    true
  );
  const otlp = await benchmarkOtlp(jsonUpstream, featureOptions);
  const samples = json.samples.map(({ candidate, delta: sampleDelta, reference, run }) => ({
    delta: sampleDelta,
    direct: reference,
    proxied: candidate,
    run
  }));
  const result = {
    benchmarkVersion: 2,
    environment: { arch: arch(), node: process.version, platform: platform() },
    samples,
    scenarios: { json, otlp, recordingBodies, recordingMetadata, sse },
    summary: {
      delta: json.summary.delta,
      direct: json.summary.reference,
      proxied: json.summary.candidate
    },
    workload: json.workload
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = process.env.BENCHMARK_OUTPUT;
  if (output === undefined) process.stdout.write(serialized);
  else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized);
    process.stdout.write(
      `${JSON.stringify({ output, scenarios: result.scenarios, summary: result.summary }, null, 2)}\n`
    );
  }
} finally {
  await Promise.all([
    closeServer(upstreamServer),
    rm(temporaryDirectory, { force: true, recursive: true })
  ]);
}
