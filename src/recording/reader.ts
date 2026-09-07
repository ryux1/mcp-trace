import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedExchange } from "../types.js";

export type ParsedRecordingLine =
  | { readonly kind: "empty" }
  | { readonly exchange: RecordedExchange; readonly kind: "exchange" }
  | { readonly kind: "invalid-json" }
  | { readonly kind: "unsupported" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordedExchange(value: unknown): value is RecordedExchange {
  if (!isObject(value)) {
    return false;
  }
  const request = value.request;
  const response = value.response;
  if (!isObject(request) || !isObject(request.metadata) || !isObject(response)) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.completedAt === "string" &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    typeof request.bytes === "number" &&
    Number.isFinite(request.bytes) &&
    typeof request.metadata.method === "string" &&
    typeof response.bytes === "number" &&
    Number.isFinite(response.bytes) &&
    typeof response.status === "number" &&
    Number.isFinite(response.status)
  );
}

export function parseRecordingLine(line: string): ParsedRecordingLine {
  if (line.trim() === "") {
    return { kind: "empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid-json" };
  }
  return isRecordedExchange(parsed)
    ? { exchange: parsed, kind: "exchange" }
    : { kind: "unsupported" };
}

export async function* readRecording(path: string): AsyncGenerator<RecordedExchange> {
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(path, { encoding: "utf8" })
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const parsed = parseRecordingLine(line);
    switch (parsed.kind) {
      case "empty":
        break;
      case "exchange":
        yield parsed.exchange;
        break;
      case "invalid-json":
        throw new Error(`Invalid JSON on recording line ${lineNumber}`);
      case "unsupported":
        throw new Error(`Unsupported recording entry on line ${lineNumber}`);
    }
  }
}
