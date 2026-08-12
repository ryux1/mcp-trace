import type { LogLevel } from "./types.js";

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000_000,
  mib: 1_048_576
};

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseByteSize(value: string): number {
  const match = /^(\d+)(b|kb|kib|mb|mib)?$/i.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid byte size: ${value}`);
  }
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = BYTE_UNITS[unit];
  if (multiplier === undefined || !Number.isSafeInteger(amount * multiplier)) {
    throw new Error(`Invalid byte size: ${value}`);
  }
  return amount * multiplier;
}

export function parseLogLevel(value: string): LogLevel {
  if (
    value === "debug" ||
    value === "error" ||
    value === "info" ||
    value === "silent" ||
    value === "warn"
  ) {
    return value;
  }
  throw new Error(`Invalid log level: ${value}`);
}

export function validateUpstream(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Upstream credentials must be supplied through header environment variables");
  }
  url.hash = "";
  return url;
}

export function validateEndpointPath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("Endpoint must be an absolute path without a query or fragment");
  }
  const normalized = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  if (normalized === "/__mcp_trace" || normalized.startsWith("/__mcp_trace/")) {
    throw new Error("Endpoint uses the reserved /__mcp_trace namespace");
  }
  return normalized;
}

export function validateOrigin(value: string): string {
  if (value === "*") {
    return value;
  }
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
    throw new Error(`Invalid allowed origin: ${value}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(`Allowed origins cannot contain a path, query, or fragment: ${value}`);
  }
  return url.origin;
}

export function parseHeaderEnvironment(
  specifications: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const specification of specifications) {
    const separator = specification.indexOf("=");
    if (separator <= 0 || separator === specification.length - 1) {
      throw new Error(`Header mapping must use Header-Name=ENVIRONMENT_VARIABLE: ${specification}`);
    }
    const name = specification.slice(0, separator).trim();
    const environmentName = specification.slice(separator + 1).trim();
    const value = environment[environmentName];
    if (value === undefined) {
      throw new Error(`Environment variable ${environmentName} is not set`);
    }
    const validationHeaders = new Headers();
    validationHeaders.set(name, value);
    headers[name] = value;
  }
  return headers;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function normalizeOtlpTraceEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OTLP endpoint must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("OTLP credentials must be supplied through header environment variables");
  }
  if (!url.pathname.endsWith("/v1/traces")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  }
  return url.toString();
}
