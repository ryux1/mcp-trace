import { createReadStream } from "node:fs";
import { link, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { RecordingSummaryBuilder, type RecordingSummary } from "./inspect.js";
import { parseRecordingLine } from "./reader.js";

export interface RecordingReportData {
  readonly capturedBodies: number;
  readonly invalidJsonLines: number;
  readonly redactedBodies: number;
  readonly skippedBlankLines: number;
  readonly summary: RecordingSummary;
  readonly totalLines: number;
  readonly truncatedBodies: number;
  readonly unsupportedLines: number;
  readonly validEntries: number;
}

export interface RecordingReportOptions {
  readonly force?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function scanRecordingForReport(path: string): Promise<RecordingReportData> {
  const builder = new RecordingSummaryBuilder();
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(path, { encoding: "utf8" })
  });
  let capturedBodies = 0;
  let invalidJsonLines = 0;
  let redactedBodies = 0;
  let skippedBlankLines = 0;
  let totalLines = 0;
  let truncatedBodies = 0;
  let unsupportedLines = 0;
  let validEntries = 0;

  for await (const line of lines) {
    totalLines += 1;
    const parsed = parseRecordingLine(line);
    switch (parsed.kind) {
      case "empty":
        skippedBlankLines += 1;
        break;
      case "invalid-json":
        invalidJsonLines += 1;
        break;
      case "unsupported":
        unsupportedLines += 1;
        break;
      case "exchange": {
        validEntries += 1;
        builder.add(parsed.exchange);
        for (const body of [parsed.exchange.request.body, parsed.exchange.response.body]) {
          if (!isObject(body)) {
            continue;
          }
          capturedBodies += 1;
          if (body.redacted === true) {
            redactedBodies += 1;
          }
          if (body.truncated === true) {
            truncatedBodies += 1;
          }
        }
        break;
      }
      case "message": {
        validEntries += 1;
        builder.addMessage(parsed.message);
        const body = parsed.message.body;
        if (isObject(body)) {
          capturedBodies += 1;
          if (body.redacted === true) {
            redactedBodies += 1;
          }
          if (body.truncated === true) {
            truncatedBodies += 1;
          }
        }
        break;
      }
    }
  }

  return {
    capturedBodies,
    invalidJsonLines,
    redactedBodies,
    skippedBlankLines,
    summary: builder.build(),
    totalLines,
    truncatedBodies,
    unsupportedLines,
    validEntries
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatInteger(value: number): string {
  const digits = Math.trunc(value).toString();
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${formatInteger(value)} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1_024;
    unit = candidate;
    if (amount < 1_024) {
      break;
    }
  }
  return `${Number(amount.toFixed(2))} ${unit}`;
}

export function renderRecordingReport(data: RecordingReportData): string {
  const { summary } = data;
  const schemaLabel =
    typeof summary.schemaVersion === "number" ? `v${summary.schemaVersion}` : summary.schemaVersion;
  const errors = Object.values(summary.methods).reduce((total, method) => total + method.errors, 0);
  const captureState =
    data.capturedBodies === 0 ? "No captured bodies" : `${data.capturedBodies} captured bodies`;
  const redactionState =
    data.capturedBodies === 0
      ? "Not applicable"
      : data.redactedBodies === 0
        ? "Not observed"
        : `${data.redactedBodies} bodies redacted`;
  const methodRows = Object.entries(summary.methods)
    .map(
      ([method, values]) => `        <tr>
          <th scope="row"><code>${escapeHtml(method)}</code></th>
          <td>${formatInteger(values.requests)}</td>
          <td>${formatInteger(values.errors)}</td>
          <td>${values.p50Ms}</td>
          <td>${values.p95Ms}</td>
          <td>${values.p99Ms}</td>
        </tr>`
    )
    .join("\n");
  const methodTableBody =
    methodRows === ""
      ? '        <tr><td colspan="6" class="empty">No valid exchanges found.</td></tr>'
      : methodRows;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>MCP Trace recording report</title>
    <style>
      :root { color-scheme: light dark; --bg: #071426; --surface: #0b1d33; --border: #28445f; --text: #f4f7fb; --muted: #a7bacd; --accent: #65d9ff; --good: #50dfbd; --warn: #f8c75c; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
      main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
      h1 { margin: 0; font-size: clamp(2rem, 6vw, 4rem); letter-spacing: -0.04em; }
      h2 { margin-top: 40px; }
      .eyebrow { color: var(--good); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
      .muted, caption { color: var(--muted); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 28px; }
      .card { padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
      .card strong { display: block; margin-top: 5px; font-size: 1.35rem; }
      .notice { padding: 16px 18px; border-left: 4px solid var(--warn); background: var(--surface); }
      .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
      table { width: 100%; border-collapse: collapse; background: var(--surface); }
      caption { padding: 14px; text-align: left; }
      th, td { padding: 12px 14px; border-top: 1px solid var(--border); text-align: right; }
      thead th { color: var(--muted); border-top: 0; font-size: 0.85rem; text-transform: uppercase; }
      th:first-child, td:first-child { text-align: left; }
      code { color: var(--accent); }
      .empty { color: var(--muted); text-align: center !important; }
      footer { margin-top: 40px; color: var(--muted); font-size: 0.9rem; }
      @media (prefers-color-scheme: light) { :root { --bg: #f6f8fa; --surface: #ffffff; --border: #d0d7de; --text: #1f2328; --muted: #59636e; --accent: #0969da; --good: #1a7f37; --warn: #bf8700; } }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Offline · read only · reader schema ${schemaLabel}</div>
      <h1>MCP Trace recording report</h1>
      <p class="muted">A deterministic summary of valid exchanges and messages. The source path, headers, bodies, and error messages are not embedded.</p>

      <section class="grid" aria-label="Recording summary">
        <div class="card">Requests<strong>${formatInteger(summary.exchanges)}</strong></div>
        <div class="card">stdio messages<strong>${formatInteger(summary.messages)}</strong></div>
        <div class="card">Failures<strong>${formatInteger(errors)}</strong></div>
        <div class="card">Client bytes<strong>${formatBytes(summary.bytesFromClient)}</strong></div>
        <div class="card">Server bytes<strong>${formatBytes(summary.bytesFromServer)}</strong></div>
        <div class="card">Capture evidence<strong>${escapeHtml(captureState)}</strong></div>
        <div class="card">Redaction evidence<strong>${escapeHtml(redactionState)}</strong></div>
      </section>

      <h2>Methods</h2>
      <div class="table-wrap">
        <table>
          <caption>Latency values are milliseconds.</caption>
          <thead><tr><th scope="col">Method</th><th scope="col">Requests</th><th scope="col">Failures</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">p99</th></tr></thead>
          <tbody>
${methodTableBody}
          </tbody>
        </table>
      </div>

      <h2>Input accounting</h2>
      <section class="grid" aria-label="Input line accounting">
        <div class="card">Total lines<strong>${formatInteger(data.totalLines)}</strong></div>
        <div class="card">Valid entries<strong>${formatInteger(data.validEntries)}</strong></div>
        <div class="card">Recognized schema<strong>${data.validEntries === 0 ? "None" : schemaLabel}</strong></div>
        <div class="card">Invalid JSON<strong>${formatInteger(data.invalidJsonLines)}</strong></div>
        <div class="card">Unsupported entries<strong>${formatInteger(data.unsupportedLines)}</strong></div>
        <div class="card">Blank lines skipped<strong>${formatInteger(data.skippedBlankLines)}</strong></div>
        <div class="card">Truncated bodies<strong>${formatInteger(data.truncatedBodies)}</strong></div>
      </section>

      <p class="notice">No captured body value is included in this report. Redaction is best effort; keep both recordings and reports owner-readable.</p>
      <footer>Generated locally by MCP Trace. This document contains no scripts or remote resources.</footer>
    </main>
  </body>
</html>
`;
}

async function assertDifferentFiles(input: string, output: string): Promise<void> {
  if (resolve(input) === resolve(output)) {
    throw new Error("Report output must differ from the recording path");
  }
  const inputRealPath = await realpath(input);
  try {
    const [inputStats, outputStats, outputRealPath] = await Promise.all([
      stat(inputRealPath),
      stat(output),
      realpath(output)
    ]);
    if (
      inputRealPath === outputRealPath ||
      (inputStats.dev === outputStats.dev && inputStats.ino === outputStats.ino)
    ) {
      throw new Error("Report output must not refer to the recording file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function generateRecordingReport(
  recording: string,
  output: string,
  options: RecordingReportOptions = {}
): Promise<RecordingReportData> {
  await assertDifferentFiles(recording, output);
  const data = await scanRecordingForReport(recording);
  const html = renderRecordingReport(data);
  const temporaryPath = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, html, { flag: "wx", mode: 0o600 });
    if (options.force === true) {
      await rm(output, { force: true });
      await rename(temporaryPath, output);
    } else {
      try {
        await link(temporaryPath, output);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Report output already exists: ${output}; use --force to overwrite`, {
            cause: error
          });
        }
        throw error;
      }
      await rm(temporaryPath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return data;
}
