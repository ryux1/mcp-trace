import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { JsonPrimitive, JsonValue, McpMetadata } from "../types.js";

interface JsonRpcRequest {
  readonly id?: JsonPrimitive;
  readonly method?: unknown;
  readonly params?: unknown;
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function parseRequest(body: Buffer): JsonRpcRequest | undefined {
  if (body.byteLength === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (Array.isArray(parsed)) {
      return { method: "batch" };
    }
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function requestName(request: JsonRpcRequest | undefined): string | undefined {
  const name = stringProperty(request?.params, "name");
  return name ?? stringProperty(request?.params, "uri");
}

function protocolVersion(request: JsonRpcRequest | undefined): string | undefined {
  if (!isRecord(request?.params)) {
    return undefined;
  }
  const meta = request.params._meta;
  return stringProperty(meta, "io.modelcontextprotocol/protocolVersion");
}

function validId(value: unknown): JsonPrimitive | undefined {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

export function hashSessionId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function extractMcpMetadata(body: Buffer, headers: IncomingHttpHeaders): McpMetadata {
  const request = parseRequest(body);
  const bodyMethod = typeof request?.method === "string" ? request.method : undefined;
  const bodyName = requestName(request);
  const bodyProtocol = protocolVersion(request);
  const headerMethod = firstHeader(headers, "mcp-method");
  const headerName = firstHeader(headers, "mcp-name");
  const headerProtocol = firstHeader(headers, "mcp-protocol-version");
  const sessionId = firstHeader(headers, "mcp-session-id");
  const id = validId(request?.id);
  const name = bodyName ?? headerName;
  const resolvedProtocolVersion = bodyProtocol ?? headerProtocol;
  const mismatches: string[] = [];

  if (bodyMethod !== undefined && headerMethod !== undefined && bodyMethod !== headerMethod) {
    mismatches.push("method");
  }
  if (bodyName !== undefined && headerName !== undefined && bodyName !== headerName) {
    mismatches.push("name");
  }
  if (
    bodyProtocol !== undefined &&
    headerProtocol !== undefined &&
    bodyProtocol !== headerProtocol
  ) {
    mismatches.push("protocol-version");
  }

  return {
    ...(bodyMethod === undefined ? {} : { bodyMethod }),
    ...(headerMethod === undefined ? {} : { headerMethod }),
    ...(id === undefined ? {} : { id }),
    method: bodyMethod ?? headerMethod ?? "unknown",
    mismatches,
    ...(name === undefined ? {} : { name }),
    ...(resolvedProtocolVersion === undefined ? {} : { protocolVersion: resolvedProtocolVersion }),
    ...(sessionId === undefined ? {} : { sessionHash: hashSessionId(sessionId) })
  };
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  return isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));
}
