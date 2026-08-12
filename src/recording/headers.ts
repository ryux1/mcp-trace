import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { Redactor } from "./redaction.js";

const SAFE_HEADERS = new Set([
  "accept",
  "content-type",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "user-agent",
  "x-request-id"
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

type HeaderSource = Headers | IncomingHttpHeaders | OutgoingHttpHeaders;

function entries(source: HeaderSource): [string, string][] {
  if (source instanceof Headers) {
    return [...source.entries()];
  }

  const result: [string, string][] = [];
  for (const [name, rawValue] of Object.entries(source)) {
    if (rawValue === undefined) {
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      result.push([name, String(value)]);
    }
  }
  return result;
}

function dynamicHopByHopHeaders(source: HeaderSource): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, value] of entries(source)) {
    if (name.toLowerCase() !== "connection") {
      continue;
    }
    for (const token of value.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized !== "") {
        names.add(normalized);
      }
    }
  }
  return names;
}

export function capturedHeaders(source: HeaderSource, redactor: Redactor): Record<string, string> {
  return Object.fromEntries(
    entries(source)
      .filter(([name]) => SAFE_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), redactor.redactHeader(name, value)])
  );
}

export function forwardingRequestHeaders(source: IncomingHttpHeaders): Headers {
  const target = new Headers();
  const dynamicHopByHop = dynamicHopByHopHeaders(source);
  for (const [name, value] of entries(source)) {
    const normalizedName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalizedName) ||
      dynamicHopByHop.has(normalizedName) ||
      normalizedName === "host" ||
      normalizedName === "content-length" ||
      normalizedName === "accept-encoding" ||
      normalizedName === "forwarded" ||
      normalizedName.startsWith("x-forwarded-")
    ) {
      continue;
    }
    target.append(name, value);
  }
  target.set("accept-encoding", "identity");
  target.set("via", "1.1 mcp-trace");
  return target;
}

export function forwardingResponseHeaders(source: Headers): Record<string, string | string[]> {
  const target: Record<string, string | string[]> = {};
  const dynamicHopByHop = dynamicHopByHopHeaders(source);
  for (const [name, value] of source.entries()) {
    const normalizedName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalizedName) || dynamicHopByHop.has(normalizedName)) {
      continue;
    }
    if (normalizedName === "set-cookie") {
      target[name] = source.getSetCookie();
    } else if (!(name in target)) {
      target[name] = value;
    }
  }
  return target;
}
