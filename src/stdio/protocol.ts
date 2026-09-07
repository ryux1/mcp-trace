import type { JsonPrimitive, JsonRpcMessageKind, McpMetadata, StdioDirection } from "../types.js";
import { extractMcpMetadata } from "../proxy/protocol.js";

export interface ParsedStdioMessage {
  readonly correlationKey?: string;
  readonly metadata: McpMetadata & { readonly kind: JsonRpcMessageKind };
}

interface PendingRequest {
  readonly method: string;
  readonly startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): JsonPrimitive | undefined {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

function correlationKey(id: JsonPrimitive): string {
  return `${typeof id}:${JSON.stringify(id)}`;
}

export function parseStdioMessage(line: Buffer): ParsedStdioMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch {
    return { metadata: { kind: "unknown", method: "unknown", mismatches: [] } };
  }
  if (!isRecord(parsed)) {
    return {
      metadata: {
        kind: "unknown",
        method: Array.isArray(parsed) ? "batch" : "unknown",
        mismatches: []
      }
    };
  }

  const extracted = extractMcpMetadata(line, {});
  const method = typeof parsed.method === "string" ? parsed.method : undefined;
  const id = validId(parsed.id);
  const hasId = Object.hasOwn(parsed, "id") && id !== undefined;
  const kind: JsonRpcMessageKind =
    method !== undefined ? (hasId ? "request" : "notification") : hasId ? "response" : "unknown";
  return {
    ...(hasId && id !== undefined ? { correlationKey: correlationKey(id) } : {}),
    metadata: {
      ...extracted,
      ...(kind === "response" && Object.hasOwn(parsed, "error") ? { isError: true } : {}),
      kind
    }
  };
}

export class StdioRequestCorrelator {
  readonly #clientRequests = new Map<string, PendingRequest>();
  readonly #serverRequests = new Map<string, PendingRequest>();

  observe(
    direction: StdioDirection,
    parsed: ParsedStdioMessage,
    observedAt: number
  ): { readonly durationMs?: number; readonly method: string } {
    const key = parsed.correlationKey;
    if (key === undefined) {
      return { method: parsed.metadata.method };
    }

    if (parsed.metadata.kind === "request") {
      const pending =
        direction === "client-to-server" ? this.#clientRequests : this.#serverRequests;
      pending.set(key, { method: parsed.metadata.method, startedAt: observedAt });
      return { method: parsed.metadata.method };
    }

    if (parsed.metadata.kind !== "response") {
      return { method: parsed.metadata.method };
    }
    const pending = direction === "server-to-client" ? this.#clientRequests : this.#serverRequests;
    const request = pending.get(key);
    if (request === undefined) {
      return { method: "unknown" };
    }
    pending.delete(key);
    return {
      durationMs: Math.max(0, observedAt - request.startedAt),
      method: request.method
    };
  }
}
