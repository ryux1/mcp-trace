import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateRecordingReport,
  renderRecordingReport,
  scanRecordingForReport
} from "../src/recording/report.js";
import type { CapturedBody, RecordedExchange } from "../src/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-trace-report-"));
  temporaryDirectories.push(directory);
  return directory;
}

function exchange(method: string, body?: CapturedBody): RecordedExchange {
  return {
    completedAt: "2026-09-07T10:00:00.025Z",
    durationMs: 25,
    error: { message: "secret upstream detail", type: "UpstreamError" },
    id: "report-1",
    request: {
      ...(body === undefined ? {} : { body }),
      bytes: 1_536,
      headers: { authorization: "Bearer secret" },
      httpMethod: "POST",
      metadata: { method, mismatches: [] },
      path: "/mcp"
    },
    response: {
      bytes: 2_048,
      headers: { "content-type": "application/json" },
      status: 500
    },
    schemaVersion: 1,
    startedAt: "2026-09-07T10:00:00.000Z",
    traceId: "private-trace-id",
    upstream: "https://private.example/mcp"
  };
}

async function writeRecording(path: string, entries: readonly string[]): Promise<void> {
  await writeFile(path, `${entries.join("\n")}\n`, { mode: 0o600 });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("offline recording reports", () => {
  it("escapes hostile metadata and accounts for malformed input deterministically", async () => {
    const directory = await temporaryDirectory();
    const recording = join(directory, "traffic.ndjson");
    const method = 'tools/<script data-x="&">alert(1)</script>';
    await writeRecording(recording, [
      JSON.stringify(exchange(method)),
      JSON.stringify(exchange("alpha")),
      "",
      "{not-json}",
      JSON.stringify({ schemaVersion: 2 })
    ]);

    const data = await scanRecordingForReport(recording);
    expect(data).toMatchObject({
      capturedBodies: 0,
      invalidJsonLines: 1,
      skippedBlankLines: 1,
      totalLines: 5,
      unsupportedLines: 1
    });
    const first = renderRecordingReport(data);
    const second = renderRecordingReport(data);

    expect(second).toBe(first);
    expect(first).toContain("tools/&lt;script data-x=&quot;&amp;&quot;&gt;alert(1)&lt;/script&gt;");
    expect(first.indexOf("<code>alpha</code>")).toBeLessThan(
      first.indexOf("<code>tools/&lt;script")
    );
    expect(first).not.toContain(method);
    expect(first).not.toContain("Bearer secret");
    expect(first).not.toContain("secret upstream detail");
    expect(first).not.toContain("{not-json}");
    expect(first).not.toContain('"schemaVersion":2');
    expect(first).not.toContain("private.example");
    expect(first).not.toContain("private-trace-id");
    expect(first).not.toContain("<script");
    expect(first).not.toMatch(/\s(?:href|src)=/u);
    expect(first).toContain("default-src 'none'");
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      "b7f228ff94101e96e70212eddb1faa4b89ef7ab28c1bf8fff6a628b260ea5488"
    );
  });

  it("reports captured-body evidence without embedding body values", async () => {
    const directory = await temporaryDirectory();
    const recording = join(directory, "bodies.ndjson");
    const body: CapturedBody = {
      bytes: 18,
      format: "json",
      redacted: true,
      truncated: true,
      value: { token: "must-not-appear" }
    };
    await writeRecording(recording, [JSON.stringify(exchange("tools/call", body))]);

    const data = await scanRecordingForReport(recording);
    const html = renderRecordingReport(data);
    expect(data).toMatchObject({ capturedBodies: 1, redactedBodies: 1, truncatedBodies: 1 });
    expect(html).toContain("1 captured bodies");
    expect(html).toContain("1 bodies redacted");
    expect(html).not.toContain("must-not-appear");
  });

  it("protects existing output unless force is explicit", async () => {
    const directory = await temporaryDirectory();
    const recording = join(directory, "traffic.ndjson");
    const output = join(directory, "report.html");
    await writeRecording(recording, [JSON.stringify(exchange("ping"))]);
    await writeFile(output, "keep me", { mode: 0o644 });

    await expect(generateRecordingReport(recording, output)).rejects.toThrow(
      "use --force to overwrite"
    );
    expect(await readFile(output, "utf8")).toBe("keep me");

    await generateRecordingReport(recording, output, { force: true });
    expect(await readFile(output, "utf8")).toContain("MCP Trace recording report");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("never replaces the input through the same path, a symlink, or a hard link", async () => {
    const directory = await temporaryDirectory();
    const recording = join(directory, "traffic.ndjson");
    const symbolicOutput = join(directory, "symbolic.html");
    const hardOutput = join(directory, "hard.html");
    const original = `${JSON.stringify(exchange("ping"))}\n`;
    await writeFile(recording, original, { mode: 0o600 });
    await symlink(recording, symbolicOutput);
    await link(recording, hardOutput);

    await expect(generateRecordingReport(recording, recording, { force: true })).rejects.toThrow(
      "must differ"
    );
    await expect(
      generateRecordingReport(recording, symbolicOutput, { force: true })
    ).rejects.toThrow("must not refer");
    await expect(generateRecordingReport(recording, hardOutput, { force: true })).rejects.toThrow(
      "must not refer"
    );
    expect(await readFile(recording, "utf8")).toBe(original);
  });
});
