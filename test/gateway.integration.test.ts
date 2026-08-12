import { trace } from "@opentelemetry/api";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpTraceGateway } from "../src/proxy/gateway.js";
import { readRecording } from "../src/recording/reader.js";
import { NdjsonRecorder } from "../src/recording/recorder.js";
import { REDACTED } from "../src/recording/redaction.js";
import type { RecordedExchange } from "../src/types.js";
import type { TelemetryRuntime } from "../src/telemetry/tracing.js";
import { bufferFromUnknown } from "./helpers.js";

const gateways: McpTraceGateway[] = [];
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

function fakeTelemetry(): TelemetryRuntime {
  return {
    tracer: trace.getTracer(`mcp-trace-test-${Math.random()}`),
    shutdown: () => Promise.resolve()
  };
}

async function listen(server: Server, path = "/mcp"): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}${path}`);
}

async function startGateway(
  upstream: URL,
  options: Partial<ConstructorParameters<typeof McpTraceGateway>[0]> = {}
): Promise<{ gateway: McpTraceGateway; url: URL }> {
  const gateway = new McpTraceGateway({
    port: 0,
    telemetry: fakeTelemetry(),
    upstream,
    ...options
  });
  gateways.push(gateway);
  const address = await gateway.start();
  return {
    gateway,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`)
  };
}

async function rawGet(url: URL, host: string): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host },
        hostname: url.hostname,
        method: "GET",
        path: url.pathname,
        port: url.port
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: unknown) => chunks.push(bufferFromUnknown(chunk)));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0
          })
        );
      }
    );
    request.once("error", reject);
    request.end();
  });
}

async function readEntries(path: string): Promise<RecordedExchange[]> {
  const entries: RecordedExchange[] = [];
  for await (const entry of readRecording(path)) {
    entries.push(entry);
  }
  return entries;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("MCP tracing gateway", () => {
  it("proxies modern JSON requests and writes sanitized evidence", async () => {
    let upstreamRequest:
      | { authorization?: string; body: unknown; traceparent?: string; url: string; via?: string }
      | undefined;
    const upstreamResponseBody = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      result: { content: [{ text: "ok", type: "text" }], token: "sk-abcdefghijklmnop" }
    });
    const upstream = await listen(
      createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(bufferFromUnknown(chunk));
        }
        upstreamRequest = {
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ...(typeof request.headers.traceparent === "string"
            ? { traceparent: request.headers.traceparent }
            : {}),
          url: request.url ?? "",
          ...(typeof request.headers.via === "string" ? { via: request.headers.via } : {})
        };
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "upstream-session"
        });
        response.end(upstreamResponseBody);
      })
    );
    const directory = await mkdtemp(join(tmpdir(), "mcp-trace-gateway-"));
    temporaryDirectories.push(directory);
    const recordingPath = join(directory, "traffic.ndjson");
    const recorder = await NdjsonRecorder.create(recordingPath);
    const { gateway, url } = await startGateway(upstream, {
      recordBodies: true,
      recorder,
      upstreamHeaders: { "X-From-Gateway": "yes" }
    });
    url.searchParams.set("tenant", "acme");
    url.searchParams.set("api_key", "sk-query-secret-value");

    const requestBody = {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        arguments: { api_key: "sk-client-secret-value", city: "Brussels" },
        name: "weather"
      }
    };
    const response = await fetch(url, {
      body: JSON.stringify(requestBody),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer abcdefghijklmnop",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "weather",
        "mcp-protocol-version": "2026-07-28",
        origin: url.origin,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
      },
      method: "POST"
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(upstreamResponseBody));
    expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
    expect(upstreamRequest).toMatchObject({
      authorization: "Bearer abcdefghijklmnop",
      body: requestBody,
      url: "/mcp?tenant=acme&api_key=sk-query-secret-value",
      via: "1.1 mcp-trace"
    });
    expect(upstreamRequest?.traceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[a-f0-9]{16}-01$/
    );

    const metrics = await fetch(new URL("/__mcp_trace/metrics", url));
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain(
      'mcp_trace_requests_total{method="tools/call",status="200"} 1'
    );
    const health = await fetch(new URL("/__mcp_trace/healthz", url));
    expect(await health.json()).toEqual({ status: "ok", upstream: upstream.toString() });

    await gateway.close();
    const entries = await readEntries(recordingPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      request: {
        body: {
          format: "json",
          value: { params: { arguments: { api_key: REDACTED, city: "Brussels" } } }
        },
        bytes: Buffer.byteLength(JSON.stringify(requestBody)),
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "weather",
          "mcp-protocol-version": "2026-07-28"
        },
        metadata: { method: "tools/call", mismatches: [], name: "weather" },
        path: "/mcp?tenant=acme&api_key=%5BREDACTED%5D"
      },
      response: {
        body: { format: "json", value: { result: { token: REDACTED } } },
        bytes: Buffer.byteLength(upstreamResponseBody),
        status: 200
      }
    });
    expect(JSON.stringify(entries[0])).not.toContain("Bearer abcdefghijklmnop");
    expect(JSON.stringify(entries[0])).not.toContain("sk-client-secret-value");
    expect(JSON.stringify(entries[0])).not.toContain("sk-query-secret-value");
  });

  it("streams SSE without waiting for the final event and sanitizes the recording", async () => {
    let releaseUpstream: (() => void) | undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = await listen(
      createServer((_request, response) => {
        void (async () => {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "x-accel-buffering": "no"
          });
          response.write('data: {"jsonrpc":"2.0","params":{"token":"sk-abcdefghijklmnop"}}\n\n');
          await waitForRelease;
          response.end('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
        })();
      })
    );
    const directory = await mkdtemp(join(tmpdir(), "mcp-trace-sse-"));
    temporaryDirectories.push(directory);
    const recordingPath = join(directory, "traffic.ndjson");
    const recorder = await NdjsonRecorder.create(recordingPath);
    const { gateway, url } = await startGateway(upstream, { recordBodies: true, recorder });

    const response = await fetch(url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "slow" }
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(bufferFromUnknown(first?.value ?? new Uint8Array()).toString()).toContain(
      "sk-abcdefghijklmnop"
    );
    releaseUpstream?.();
    const chunks: Buffer[] = [];
    while (true) {
      const result = await reader?.read();
      if (result === undefined || result.done) {
        break;
      }
      chunks.push(bufferFromUnknown(result.value));
    }
    expect(Buffer.concat(chunks).toString()).toContain('"result":{"ok":true}');

    await gateway.close();
    const entries = await readEntries(recordingPath);
    expect(entries[0]?.response.body).toMatchObject({ format: "text", redacted: true });
    expect(entries[0]?.response.body?.value).toContain(`"token":"${REDACTED}"`);
    expect(JSON.stringify(entries[0])).not.toContain("sk-abcdefghijklmnop");
  });

  it("rejects unsafe origins, invalid hosts, oversized bodies, and unsupported methods", async () => {
    let upstreamHits = 0;
    const upstream = await listen(
      createServer((_request, response) => {
        upstreamHits += 1;
        response.end("{}");
      })
    );
    const { url } = await startGateway(upstream, { maxRequestBytes: 8 });

    const originResponse = await fetch(url, {
      body: "{}",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      method: "POST"
    });
    expect(originResponse.status).toBe(403);

    const hostResponse = await rawGet(new URL("/__mcp_trace/healthz", url), "evil.example");
    expect(hostResponse.status).toBe(403);

    const oversized = await fetch(url, {
      body: JSON.stringify({ too: "large" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(oversized.status).toBe(413);

    const unsupported = await fetch(url, { method: "PUT" });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe("POST, GET, DELETE");
    expect((await fetch(new URL("/missing", url))).status).toBe(404);
    expect(upstreamHits).toBe(0);
  });

  it("fails closed on wildcard binds until an allowed Host is configured", async () => {
    let upstreamHits = 0;
    const upstream = await listen(
      createServer((_request, response) => {
        upstreamHits += 1;
        response.end("{}");
      })
    );
    const blocked = await startGateway(upstream, { host: "0.0.0.0" });
    expect((await fetch(blocked.url)).status).toBe(403);

    const allowed = await startGateway(upstream, {
      allowedHosts: ["127.0.0.1"],
      host: "0.0.0.0"
    });
    expect((await fetch(allowed.url)).status).toBe(200);
    expect(upstreamHits).toBe(1);
  });

  it("forwards legacy GET and DELETE requests and hashes their session identifier", async () => {
    const methods: string[] = [];
    const upstream = await listen(
      createServer((request, response) => {
        methods.push(request.method ?? "unknown");
        response.writeHead(request.method === "GET" ? 200 : 204, {
          "content-type": request.method === "GET" ? "text/event-stream" : "text/plain"
        });
        response.end(request.method === "GET" ? ": keepalive\n\n" : undefined);
      })
    );
    const directory = await mkdtemp(join(tmpdir(), "mcp-trace-legacy-"));
    temporaryDirectories.push(directory);
    const recordingPath = join(directory, "traffic.ndjson");
    const recorder = await NdjsonRecorder.create(recordingPath);
    const { gateway, url } = await startGateway(upstream, { recorder });

    const headers = { "mcp-session-id": "legacy-session-secret" };
    expect((await fetch(url, { headers })).status).toBe(200);
    expect((await fetch(url, { headers, method: "DELETE" })).status).toBe(204);
    expect(methods).toEqual(["GET", "DELETE"]);

    await gateway.close();
    const entries = await readEntries(recordingPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.request.metadata.sessionHash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(entries)).not.toContain("legacy-session-secret");
  });

  it("returns a structured 502 when the upstream cannot be reached", async () => {
    const disposable = createServer();
    const unavailable = await listen(disposable);
    await new Promise<void>((resolve) => disposable.close(() => resolve()));
    const { url } = await startGateway(unavailable);

    const response = await fetch(url, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: -32_000 },
      id: null,
      jsonrpc: "2.0"
    });
  });
});
