import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedExchange } from "../types.js";

function isRecordedExchange(value: unknown): value is RecordedExchange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.request === "object" &&
    record.request !== null &&
    typeof record.response === "object" &&
    record.response !== null
  );
}

export async function* readRecording(path: string): AsyncGenerator<RecordedExchange> {
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(path, { encoding: "utf8" })
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on recording line ${lineNumber}`, { cause: error });
    }
    if (!isRecordedExchange(parsed)) {
      throw new Error(`Unsupported recording entry on line ${lineNumber}`);
    }
    yield parsed;
  }
}
