import type { IncomingHttpHeaders } from "node:http";
import type { CapturedBody, JsonValue } from "../types.js";
import { isJsonValue } from "../proxy/protocol.js";
import type { Redactor } from "./redaction.js";

export class BodyTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Request body exceeds the configured ${limit}-byte limit`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

export class LimitedBuffer {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #bytes = 0;
  #storedBytes = 0;

  constructor(limit: number) {
    this.#limit = Math.max(0, limit);
  }

  add(chunk: Uint8Array): void {
    const buffer = Buffer.from(chunk);
    this.#bytes += buffer.byteLength;
    const remaining = this.#limit - this.#storedBytes;
    if (remaining <= 0) {
      return;
    }
    const stored = buffer.subarray(0, remaining);
    this.#chunks.push(stored);
    this.#storedBytes += stored.byteLength;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get truncated(): boolean {
    return this.#bytes > this.#storedBytes;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#storedBytes);
  }
}

export async function readRequestBody(
  request: AsyncIterable<Uint8Array>,
  headers: IncomingHttpHeaders,
  limit: number
): Promise<Buffer> {
  const contentLength = headers["content-length"];
  const declaredLength =
    typeof contentLength === "string"
      ? contentLength
      : Array.isArray(contentLength)
        ? contentLength[0]
        : undefined;
  if (declaredLength !== undefined) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > limit) {
      throw new BodyTooLargeError(limit);
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      throw new BodyTooLargeError(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function mediaType(contentType: string | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream";
}

function parseJson(buffer: Buffer): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function redactSse(value: string, redactor: Redactor): string {
  return value
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return redactor.redactText(line);
      }
      const prefix = line.startsWith("data: ") ? "data: " : "data:";
      const data = line.slice(prefix.length);
      try {
        const parsed: unknown = JSON.parse(data);
        if (isJsonValue(parsed)) {
          return `${prefix}${JSON.stringify(redactor.redactJson(parsed))}`;
        }
      } catch {
        // Non-JSON SSE data is valid and still receives token-pattern redaction.
      }
      return `${prefix}${redactor.redactText(data)}`;
    })
    .join("\n");
}

export function captureBody(
  buffer: Buffer,
  options: {
    readonly bytes?: number;
    readonly contentType?: string;
    readonly redactor: Redactor;
    readonly truncated?: boolean;
  }
): CapturedBody {
  const bytes = options.bytes ?? buffer.byteLength;
  const truncated = options.truncated ?? false;
  const type = mediaType(options.contentType);
  const json = type === "application/json" ? parseJson(buffer) : undefined;

  if (json !== undefined) {
    return {
      bytes,
      format: "json",
      redacted: true,
      truncated,
      value: options.redactor.redactJson(json)
    };
  }

  if (type === "application/json" || type.startsWith("text/") || type.endsWith("+json")) {
    const value = buffer.toString("utf8");
    return {
      bytes,
      format: "text",
      redacted: true,
      truncated,
      value:
        type === "text/event-stream"
          ? redactSse(value, options.redactor)
          : options.redactor.redactText(value)
    };
  }

  return {
    bytes,
    format: "base64",
    redacted: false,
    truncated,
    value: buffer.toString("base64")
  };
}
