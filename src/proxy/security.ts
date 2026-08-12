import type { IncomingMessage } from "node:http";

function normalizedHostname(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
  } catch {
    return "";
  }
}

export function isHostAllowed(
  request: IncomingMessage,
  bindHost: string,
  additionalHosts: ReadonlySet<string>
): boolean {
  const hostHeader = request.headers.host;
  if (hostHeader === undefined) {
    return false;
  }
  const hostname = normalizedHostname(hostHeader);
  const normalizedAdditionalHosts = new Set(
    [...additionalHosts].map(normalizedHostname).filter((candidate) => candidate !== "")
  );
  if (normalizedAdditionalHosts.has(hostname)) {
    return true;
  }

  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return normalizedAdditionalHosts.has(hostname);
  }

  const loopbackNames = new Set(["127.0.0.1", "::1", "localhost"]);
  if (loopbackNames.has(bindHost.toLowerCase())) {
    return loopbackNames.has(hostname);
  }
  return hostname === bindHost.toLowerCase();
}

export function isOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (allowedOrigins.has("*") || allowedOrigins.has(origin)) {
    return true;
  }

  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.protocol === "http:" && parsedOrigin.host === request.headers.host;
  } catch {
    return false;
  }
}
