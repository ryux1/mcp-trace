import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRecording, summarizeExchanges } from "../src/recording/inspect.js";
import { readRecording } from "../src/recording/reader.js";
import { NdjsonRecorder } from "../src/recording/recorder.js";
import type { RecordedExchange } from "../src/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-trace-recording-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function consumeRecording(path: string): Promise<void> {
  for await (const entry of readRecording(path)) {
    void entry;
  }
}

function exchange(
  id: string,
  method: string,
  durationMs: number,
  status: number
): RecordedExchange {
  return {
    completedAt: `2026-08-13T00:00:0${id}.100Z`,
    durationMs,
    id,
    request: {
      bytes: 32,
      headers: { "content-type": "application/json", "mcp-method": method },
      httpMethod: "POST",
      metadata: { method, mismatches: [] },
      path: "/mcp"
    },
    response: {
      bytes: 64,
      headers: { "content-type": "application/json" },
      status
    },
    schemaVersion: 1,
    startedAt: `2026-08-13T00:00:0${id}.000Z`,
    upstream: "https://example.com/mcp"
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("NDJSON recordings", () => {
  it("appends, reads, and summarizes exchanges", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", "traffic.ndjson");
    const recorder = await NdjsonRecorder.create(path);
    await Promise.all([
      recorder.write(exchange("1", "tools/list", 10, 200)),
      recorder.write(exchange("2", "tools/list", 30, 500)),
      recorder.write(exchange("3", "resources/read", 20, 200))
    ]);
    await recorder.close();

    const entries: RecordedExchange[] = [];
    for await (const entry of readRecording(path)) {
      if (entry.schemaVersion === 1) {
        entries.push(entry);
      }
    }
    expect(entries.map(({ id }) => id).sort()).toEqual(["1", "2", "3"]);

    const recording = await open(path, "r");
    try {
      expect((await recording.stat()).mode & 0o777).toBe(0o600);
      expect((await recording.readFile("utf8")).trim().split("\n")).toHaveLength(3);
    } finally {
      await recording.close();
    }

    const summary = await inspectRecording(path);
    expect(summary).toMatchObject({
      bytesFromClient: 96,
      bytesFromServer: 192,
      exchanges: 3,
      methods: {
        "resources/read": { errors: 0, requests: 1 },
        "tools/list": { errors: 1, p50Ms: 10, p95Ms: 30, requests: 2 }
      },
      schemaVersion: 1
    });
    expect(await recorder.close()).toBeUndefined();
    await expect(recorder.write(exchange("4", "ping", 1, 200))).rejects.toThrow("closed recorder");
  });

  it("returns an empty summary", () => {
    expect(summarizeExchanges([])).toEqual({
      bytesFromClient: 0,
      bytesFromServer: 0,
      exchanges: 0,
      messages: 0,
      methods: {},
      schemaVersion: 1
    });
  });

  it("counts an existing file and never writes a partial line at the ceiling", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "traffic.ndjson");
    const existing = `${JSON.stringify(exchange("1", "tools/list", 10, 200))}\n`;
    const next = exchange("2", "resources/read", 20, 200);
    await writeFile(path, existing, { mode: 0o644 });
    const recorder = await NdjsonRecorder.create(path, {
      maxBytes: Buffer.byteLength(existing) + Buffer.byteLength(`${JSON.stringify(next)}\n`) - 1
    });

    expect(await recorder.write(next)).toBe("limit-reached");
    expect(await recorder.write(exchange("3", "ping", 1, 200))).toBe("skipped");
    await recorder.close();

    expect(await readFile(path, "utf8")).toBe(existing);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(recorder.state).toEqual({
      bytesWritten: Buffer.byteLength(existing),
      limitReached: true,
      maxBytes: Buffer.byteLength(existing) + Buffer.byteLength(`${JSON.stringify(next)}\n`) - 1,
      skippedEntries: 2
    });
  });

  it("serializes concurrent admission and permits an exact fit", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "traffic.ndjson");
    const entry = exchange("1", "tools/list", 10, 200);
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
    const recorder = await NdjsonRecorder.create(path, { maxBytes: lineBytes * 2 });

    const results = await Promise.all(Array.from({ length: 10 }, () => recorder.write(entry)));
    await recorder.close();

    expect(results.filter((result) => result === "written")).toHaveLength(2);
    expect(results.filter((result) => result === "limit-reached")).toHaveLength(1);
    expect(results.filter((result) => result === "skipped")).toHaveLength(7);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await stat(path)).size).toBe(lineBytes * 2);
    expect(recorder.state).toEqual({
      bytesWritten: lineBytes * 2,
      limitReached: true,
      maxBytes: lineBytes * 2,
      skippedEntries: 8
    });
  });

  it("starts stopped when an existing file is already at the ceiling", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "traffic.ndjson");
    await writeFile(path, "{}\n", { mode: 0o600 });
    const recorder = await NdjsonRecorder.create(path, { maxBytes: 3 });

    expect(recorder.state.limitReached).toBe(true);
    expect(await recorder.write(exchange("1", "ping", 1, 200))).toBe("skipped");
    await recorder.close();
    expect(await readFile(path, "utf8")).toBe("{}\n");
  });

  it("drains admitted writes on close and validates API limits", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "traffic.ndjson");
    await expect(NdjsonRecorder.create(path, { maxBytes: 0 })).rejects.toThrow(
      "positive safe integer"
    );
    const recorder = await NdjsonRecorder.create(path);
    const writes = [
      recorder.write(exchange("1", "ping", 1, 200)),
      recorder.write(exchange("2", "ping", 1, 200))
    ];
    await recorder.close();
    expect(await Promise.all(writes)).toEqual(["written", "written"]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("reports malformed and unsupported recording lines", async () => {
    const directory = await temporaryDirectory();
    const invalidJson = join(directory, "invalid-json.ndjson");
    await writeFile(invalidJson, "{not-json}\n", { mode: 0o600 });
    await expect(consumeRecording(invalidJson)).rejects.toThrow("Invalid JSON on recording line 1");

    const unsupported = join(directory, "unsupported.ndjson");
    await writeFile(unsupported, '{"schemaVersion":2}\n', { mode: 0o600 });
    await expect(consumeRecording(unsupported)).rejects.toThrow("Unsupported recording entry");
  });
});
