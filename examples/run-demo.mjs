import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRecording } from "../dist/recording/inspect.js";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a local demo port");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
  return address.port;
}

async function waitFor(url, child, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not become ready`);
}

async function stop(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000).unref();
  });
}

const directory = await mkdtemp(join(tmpdir(), "mcp-trace-demo-"));
const upstreamPort = await availablePort();
const gatewayPort = await availablePort();
const recording = join(directory, "traffic.ndjson");
const upstream = spawn(process.execPath, ["examples/mock-mcp-server.mjs"], {
  env: { ...process.env, MCP_DEMO_PORT: String(upstreamPort) },
  stdio: ["ignore", "ignore", "inherit"]
});
const gateway = spawn(
  process.execPath,
  [
    "dist/cli.js",
    "proxy",
    "--upstream",
    `http://127.0.0.1:${upstreamPort}/mcp`,
    "--port",
    String(gatewayPort),
    "--record",
    recording,
    "--record-bodies",
    "--log-level",
    "silent"
  ],
  { stdio: ["ignore", "ignore", "inherit"] }
);

try {
  await waitFor(`http://127.0.0.1:${upstreamPort}/healthz`, upstream, "Mock MCP server");
  await waitFor(`http://127.0.0.1:${gatewayPort}/__mcp_trace/healthz`, gateway, "MCP Trace");
  const requestBody = await readFile("examples/request.json", "utf8");
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    body: requestBody,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": "echo",
      "mcp-protocol-version": "2026-07-28"
    },
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`Demo request returned HTTP ${response.status}`);
  }
  const result = await response.json();
  const metrics = await fetch(`http://127.0.0.1:${gatewayPort}/__mcp_trace/metrics`).then((value) =>
    value.text()
  );
  await stop(gateway);
  const summary = await inspectRecording(recording);
  const recorded = await readFile(recording, "utf8");
  if (recorded.includes("demo-secret-that-will-be-redacted")) {
    throw new Error("Demo recording contains the source credential");
  }

  process.stdout.write("MCP response\n");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n`);
  process.stdout.write("Sanitized recording summary\n");
  process.stdout.write(
    `${JSON.stringify(
      {
        bytesFromClient: summary.bytesFromClient,
        bytesFromServer: summary.bytesFromServer,
        exchanges: summary.exchanges,
        methods: Object.fromEntries(
          Object.entries(summary.methods).map(([method, value]) => [
            method,
            { errors: value.errors, requests: value.requests }
          ])
        ),
        schemaVersion: summary.schemaVersion
      },
      null,
      2
    )}\n\n`
  );
  process.stdout.write("Prometheus evidence\n");
  process.stdout.write(
    `${metrics
      .split("\n")
      .filter((line) => line.startsWith("mcp_trace_requests_total{"))
      .join("\n")}\n`
  );
} finally {
  await Promise.all([stop(gateway), stop(upstream)]);
  await rm(directory, { force: true, recursive: true });
}
