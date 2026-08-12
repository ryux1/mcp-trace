import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NdjsonRecorder } from "../src/recording/recorder.js";
import { REDACTED } from "../src/recording/redaction.js";
import { replayRecording } from "../src/replay/replay.js";
import type { CapturedBody, RecordedExchange } from "../src/types.js";
import { bufferFromUnknown } from "./helpers.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

async function listen(server: Server): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function recordingPath(bodies: readonly (CapturedBody | undefined)[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-trace-replay-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "recording.ndjson");
  const recorder = await NdjsonRecorder.create(path);
  for (const [index, body] of bodies.entries()) {
    const exchange: RecordedExchange = {
      completedAt: new Date().toISOString(),
      durationMs: 1,
      id: String(index),
      request: {
        ...(body === undefined ? {} : { body }),
        bytes: body?.bytes ?? 0,
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "echo",
          "mcp-protocol-version": "2026-07-28"
        },
        httpMethod: "POST",
        metadata: { method: "tools/call", mismatches: [], name: "echo" },
        path: index === 3 ? `/mcp?token=${encodeURIComponent(REDACTED)}` : "/mcp?source=recording"
      },
      response: { bytes: 2, headers: {}, status: 200 },
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      upstream: "https://original.invalid/mcp"
    };
    await recorder.write(exchange);
  }
  await recorder.close();
  return path;
}

const safeBody: CapturedBody = {
  bytes: 70,
  format: "json",
  redacted: true,
  truncated: false,
  value: { id: 1, jsonrpc: "2.0", method: "tools/call", params: { name: "echo" } }
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
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

describe("recording replay", () => {
  it("is a dry run by default and skips unsafe payloads", async () => {
    const path = await recordingPath([
      safeBody,
      { ...safeBody, value: { token: REDACTED } },
      { ...safeBody, truncated: true },
      safeBody,
      undefined
    ]);
    await expect(
      replayRecording(path, { iterations: 2, upstream: new URL("https://target.invalid/mcp") })
    ).resolves.toEqual({
      attempted: 0,
      durationMs: 0,
      failed: 0,
      mode: "dry-run",
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      planned: 2,
      skipped: 8,
      succeeded: 0
    });
  });

  it("executes bounded concurrent replays and forwards explicit headers", async () => {
    const received: Array<{ body: unknown; query: string; tenant?: string }> = [];
    const target = await listen(
      createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(bufferFromUnknown(chunk));
        }
        received.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          query: request.url ?? "",
          ...(typeof request.headers["x-tenant"] === "string"
            ? { tenant: request.headers["x-tenant"] }
            : {})
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      })
    );
    const path = await recordingPath([safeBody]);
    const summary = await replayRecording(path, {
      concurrency: 2,
      execute: true,
      headers: { "X-Tenant": "acme" },
      iterations: 3,
      timeoutMs: 2_000,
      upstream: target
    });

    expect(summary).toMatchObject({
      attempted: 3,
      failed: 0,
      mode: "execute",
      planned: 3,
      skipped: 0,
      succeeded: 3
    });
    expect(received).toHaveLength(3);
    expect(received.every(({ tenant }) => tenant === "acme")).toBe(true);
    expect(received.every(({ query }) => query === "/mcp?source=recording")).toBe(true);
  });

  it("counts HTTP and network failures", async () => {
    const target = await listen(
      createServer((_request, response) => {
        response.writeHead(503);
        response.end();
      })
    );
    const path = await recordingPath([safeBody]);
    const failed = await replayRecording(path, { execute: true, upstream: target });
    expect(failed).toMatchObject({ attempted: 1, failed: 1, succeeded: 0 });

    const address = servers[0]?.address() as AddressInfo;
    await new Promise<void>((resolve) => servers[0]?.close(() => resolve()));
    servers.shift();
    const unavailable = await replayRecording(path, {
      execute: true,
      timeoutMs: 200,
      upstream: new URL(`http://127.0.0.1:${address.port}/mcp`)
    });
    expect(unavailable.failed).toBe(1);
  });

  it("validates execution controls", async () => {
    const path = await recordingPath([safeBody]);
    await expect(
      replayRecording(path, { concurrency: 0, upstream: new URL("https://target.invalid/mcp") })
    ).rejects.toThrow("positive");
    await expect(
      replayRecording(path, {
        ratePerSecond: 0,
        upstream: new URL("https://target.invalid/mcp")
      })
    ).rejects.toThrow("rate must be positive");
  });
});
