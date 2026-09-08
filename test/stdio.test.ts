import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRecording } from "../src/recording/inspect.js";
import { readRecording } from "../src/recording/reader.js";
import { NdjsonRecorder } from "../src/recording/recorder.js";
import {
  StdioMessageObserver,
  StdioMessageTooLargeError,
  UnterminatedStdioMessageError
} from "../src/stdio/framing.js";
import { parseStdioMessage, StdioRequestCorrelator } from "../src/stdio/protocol.js";
import { buildChildEnvironment, runStdioProxy } from "../src/stdio/proxy.js";
import type { RecordedStdioMessage } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function collect(stream: PassThrough): { readonly chunks: Buffer[]; value(): Buffer } {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return { chunks, value: () => Buffer.concat(chunks) };
}

describe("stdio framing", () => {
  it("observes complete messages without changing their bytes", async () => {
    const observed: string[] = [];
    const output = new PassThrough();
    const collected = collect(output);
    await pipeline(
      Readable.from([Buffer.from('{"id":1'), Buffer.from('}\r\n {"id":2}\n')]),
      new StdioMessageObserver(128, (line) => {
        observed.push(line.toString("utf8"));
        return Promise.resolve();
      }),
      output
    );
    expect(collected.value().toString("utf8")).toBe('{"id":1}\r\n {"id":2}\n');
    expect(observed).toEqual(['{"id":1}', ' {"id":2}']);
  });

  it("rejects oversized and unterminated messages", async () => {
    await expect(
      pipeline(
        Readable.from([Buffer.from("12345\n")]),
        new StdioMessageObserver(4, () => Promise.resolve()),
        new PassThrough()
      )
    ).rejects.toBeInstanceOf(StdioMessageTooLargeError);
    await expect(
      pipeline(
        Readable.from([Buffer.from("{}")]),
        new StdioMessageObserver(4, () => Promise.resolve()),
        new PassThrough()
      )
    ).rejects.toBeInstanceOf(UnterminatedStdioMessageError);
  });
});

describe("stdio JSON-RPC metadata", () => {
  it("classifies and correlates requests in both directions", () => {
    const correlator = new StdioRequestCorrelator();
    const request = parseStdioMessage(
      Buffer.from('{"jsonrpc":"2.0","id":7,"method":"tools/list"}')
    );
    const response = parseStdioMessage(Buffer.from('{"jsonrpc":"2.0","id":7,"result":{}}'));
    expect(request.metadata).toMatchObject({ id: 7, kind: "request", method: "tools/list" });
    expect(correlator.observe("client-to-server", request, 10)).toEqual({
      method: "tools/list"
    });
    expect(correlator.observe("server-to-client", response, 25)).toEqual({
      durationMs: 15,
      method: "tools/list"
    });

    expect(
      parseStdioMessage(
        Buffer.from('{"jsonrpc":"2.0","id":8,"error":{"code":-32603,"message":"failed"}}')
      ).metadata
    ).toMatchObject({ id: 8, isError: true, kind: "response" });

    const reverseRequest = parseStdioMessage(
      Buffer.from('{"jsonrpc":"2.0","id":"root","method":"roots/list"}')
    );
    const reverseResponse = parseStdioMessage(
      Buffer.from('{"jsonrpc":"2.0","id":"root","result":{}}')
    );
    correlator.observe("server-to-client", reverseRequest, 30);
    expect(correlator.observe("client-to-server", reverseResponse, 34)).toEqual({
      durationMs: 4,
      method: "roots/list"
    });
  });
});

describe("stdio process proxy", () => {
  it("forwards exact protocol bytes, keeps stderr separate, and records both directions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-trace-stdio-"));
    temporaryDirectories.push(directory);
    const recording = join(directory, "traffic.ndjson");
    const recorder = await NdjsonRecorder.create(recording);
    const message = Buffer.from(
      ' {"jsonrpc":"2.0", "id":1, "method":"tools/list", "params":{"api_key":"topsecretvalue"}}\r\n'
    );
    const output = new PassThrough();
    const stderr = new PassThrough();
    const outputData = collect(output);
    const stderrData = collect(stderr);
    const result = await runStdioProxy({
      arguments: ["test/fixtures/stdio/echo-server.mjs"],
      executable: process.execPath,
      input: Readable.from([message]),
      logger: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined
      },
      output,
      recordBodies: true,
      recorder,
      stderr
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(outputData.value()).toEqual(message);
    expect(stderrData.value().toString("utf8")).toBe("echo-server-ready\n");
    const entries: RecordedStdioMessage[] = [];
    for await (const entry of readRecording(recording)) {
      if (entry.schemaVersion === 2) {
        entries.push(entry);
      }
    }
    expect(entries).toHaveLength(2);
    expect(entries.map(({ direction }) => direction)).toEqual([
      "client-to-server",
      "server-to-client"
    ]);
    expect(entries[0]).toMatchObject({
      body: { format: "json", redacted: true },
      bytes: message.byteLength - 2,
      metadata: { id: 1, kind: "request", method: "tools/list" },
      schemaVersion: 2,
      transport: "stdio"
    });
    expect(entries[1]).toMatchObject({
      metadata: { id: 1, kind: "request", method: "tools/list" }
    });
    expect(await readFile(recording, "utf8")).not.toContain("topsecretvalue");
    expect(await inspectRecording(recording)).toMatchObject({
      bytesFromClient: message.byteLength - 2,
      bytesFromServer: message.byteLength - 2,
      exchanges: 2,
      messages: 2,
      methods: { "tools/list": { errors: 0, requests: 2 } },
      schemaVersion: 2
    });
  });

  it("keeps forwarding after the recording ceiling and warns once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-trace-stdio-retention-"));
    temporaryDirectories.push(directory);
    const recording = join(directory, "traffic.ndjson");
    const recorder = await NdjsonRecorder.create(recording, { maxBytes: 1 });
    const message = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const output = new PassThrough();
    const outputData = collect(output);
    const warnings: string[] = [];

    const result = await runStdioProxy({
      arguments: ["test/fixtures/stdio/echo-server.mjs"],
      executable: process.execPath,
      input: Readable.from([message]),
      logger: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: (text) => warnings.push(text)
      },
      output,
      recorder,
      stderr: new PassThrough()
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(outputData.value()).toEqual(message);
    expect(warnings).toEqual(["Recording byte ceiling reached; further entries will be skipped"]);
    expect(await readFile(recording, "utf8")).toBe("");
    expect(recorder.state.skippedEntries).toBe(2);
  });

  it("builds a minimal child environment only when requested", () => {
    const environment = {
      HOME: "/secret-home",
      PATH: "/bin",
      SERVER_TOKEN: "secret",
      TEMP: "/tmp"
    };
    expect(buildChildEnvironment({ clear: false, pass: [] }, environment)).toEqual(environment);
    expect(buildChildEnvironment({ clear: true, pass: ["SERVER_TOKEN"] }, environment)).toEqual({
      PATH: "/bin",
      SERVER_TOKEN: "secret",
      TEMP: "/tmp"
    });
    expect(() => buildChildEnvironment({ clear: true, pass: ["MISSING"] }, environment)).toThrow(
      "MISSING is not set"
    );
  });

  it("returns an upstream process failure without rewriting its exit code", async () => {
    const result = await runStdioProxy({
      arguments: ["test/fixtures/stdio/exit-server.mjs", "7"],
      executable: process.execPath,
      input: Readable.from([]),
      output: new PassThrough(),
      stderr: new PassThrough()
    });
    expect(result).toEqual({ code: 7, signal: null });
  });

  it("rejects when the upstream executable cannot be started", async () => {
    await expect(
      runStdioProxy({
        executable: `mcp-trace-missing-executable-${process.pid}`,
        input: Readable.from([]),
        output: new PassThrough(),
        stderr: new PassThrough()
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates the upstream process when the proxy is aborted", async () => {
    const controller = new AbortController();
    const input = new PassThrough();
    const stderr = new PassThrough();
    stderr.once("data", () => controller.abort());
    const result = await runStdioProxy({
      arguments: ["test/fixtures/stdio/echo-server.mjs"],
      executable: process.execPath,
      input,
      output: new PassThrough(),
      shutdownGraceMs: 100,
      signal: controller.signal,
      stderr
    });
    expect(result.code !== null || result.signal !== null).toBe(true);
  });
});
