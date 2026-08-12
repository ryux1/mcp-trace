import {
  context,
  isSpanContextValid,
  propagation,
  SpanStatusCode,
  type Tracer
} from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Logger, McpMetadata, RecordedExchange } from "../types.js";
import { silentLogger } from "../utils/logger.js";
import {
  BodyTooLargeError,
  captureBody,
  LimitedBuffer,
  readRequestBody
} from "../recording/body.js";
import {
  capturedHeaders,
  forwardingRequestHeaders,
  forwardingResponseHeaders
} from "../recording/headers.js";
import type { NdjsonRecorder } from "../recording/recorder.js";
import { Redactor } from "../recording/redaction.js";
import { MetricsRegistry } from "../telemetry/metrics.js";
import type { TelemetryRuntime } from "../telemetry/tracing.js";
import { extractMcpMetadata } from "./protocol.js";
import { isHostAllowed, isOriginAllowed } from "./security.js";

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_MAX_RECORD_BODY_BYTES = 256 * 1_024;

export interface GatewayOptions {
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly endpointPath?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly host?: string;
  readonly logger?: Logger;
  readonly maxRecordBodyBytes?: number;
  readonly maxRequestBytes?: number;
  readonly metrics?: MetricsRegistry;
  readonly port?: number;
  readonly recordBodies?: boolean;
  readonly recorder?: NdjsonRecorder;
  readonly redactor?: Redactor;
  readonly telemetry: TelemetryRuntime;
  readonly upstream: URL;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
}

interface MutableExchangeState {
  error?: Error;
  metadata: McpMetadata;
  requestBody: Buffer;
  responseBody: LimitedBuffer;
  responseContentType: string | undefined;
  responseHeaders: Headers;
  responseStatus: number;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-length": body.byteLength,
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
}

function writeGatewayError(response: ServerResponse, status: number, message: string): void {
  writeJson(response, status, {
    error: { code: -32_000, message },
    id: null,
    jsonrpc: "2.0"
  });
}

function targetUrl(upstream: URL, incoming: URL): URL {
  const target = new URL(upstream);
  for (const [name, value] of incoming.searchParams) {
    target.searchParams.append(name, value);
  }
  return target;
}

function publicUpstream(upstream: URL): string {
  return `${upstream.origin}${upstream.pathname}`;
}

function capturedPath(incoming: URL, redactor: Redactor): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of incoming.searchParams) {
    parameters.append(name, redactor.redactHeader(name, value));
  }
  const query = parameters.toString();
  return query === "" ? incoming.pathname : `${incoming.pathname}?${query}`;
}

function errorType(error: Error): string {
  if (error.name === "AbortError") {
    return "aborted";
  }
  return error.name || "Error";
}

async function writeResponseChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.destroyed) {
    throw new Error("Client disconnected while the upstream response was streaming");
  }
  if (!response.write(chunk)) {
    await once(response, "drain");
  }
}

export class McpTraceGateway {
  readonly #activeRequests = new Set<AbortController>();
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #endpointPath: string;
  readonly #fetch: typeof fetch;
  readonly #host: string;
  readonly #logger: Logger;
  readonly #maxRecordBodyBytes: number;
  readonly #maxRequestBytes: number;
  readonly #metrics: MetricsRegistry;
  readonly #port: number;
  readonly #recordBodies: boolean;
  readonly #recorder: NdjsonRecorder | undefined;
  readonly #redactor: Redactor;
  readonly #requestTasks = new Set<Promise<void>>();
  readonly #server: Server;
  readonly #telemetry: TelemetryRuntime;
  readonly #tracer: Tracer;
  readonly #upstream: URL;
  readonly #upstreamHeaders: Readonly<Record<string, string>>;
  #closed = false;
  #started = false;

  constructor(options: GatewayOptions) {
    this.#allowedHosts = new Set(options.allowedHosts ?? []);
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.#endpointPath = options.endpointPath ?? "/mcp";
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#host = options.host ?? "127.0.0.1";
    this.#logger = options.logger ?? silentLogger;
    this.#maxRecordBodyBytes = options.maxRecordBodyBytes ?? DEFAULT_MAX_RECORD_BODY_BYTES;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#metrics = options.metrics ?? new MetricsRegistry();
    this.#port = options.port ?? 7_331;
    this.#recordBodies = options.recordBodies ?? false;
    this.#recorder = options.recorder;
    this.#redactor = options.redactor ?? new Redactor();
    this.#telemetry = options.telemetry;
    this.#tracer = options.telemetry.tracer;
    this.#upstream = new URL(options.upstream);
    this.#upstreamHeaders = options.upstreamHeaders ?? {};
    this.#server = createServer((request, response) => {
      const task = this.#handle(request, response).catch((error: unknown) => {
        this.#logger.error("Unhandled gateway request error", { error });
        if (!response.headersSent) {
          writeGatewayError(response, 500, "Unexpected gateway error");
        } else if (!response.writableEnded) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
      this.#requestTasks.add(task);
      void task.finally(() => this.#requestTasks.delete(task));
    });
  }

  get address(): AddressInfo | undefined {
    const address = this.#server.address();
    return typeof address === "object" && address !== null ? address : undefined;
  }

  async start(): Promise<AddressInfo> {
    if (this.#started) {
      throw new Error("Gateway has already been started");
    }
    this.#started = true;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        this.#started = false;
        rejectListen(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolveListen();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, this.#host);
    });
    const address = this.address;
    if (address === undefined) {
      throw new Error("Gateway did not expose a TCP address");
    }
    return address;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const controller of this.#activeRequests) {
      controller.abort(new Error("Gateway is shutting down"));
    }
    if (this.#started) {
      await new Promise<void>((resolveClose, rejectClose) => {
        this.#server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
      });
      this.#started = false;
    }
    await Promise.allSettled([...this.#requestTasks]);
    await this.#recorder?.close();
    await this.#telemetry.shutdown();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const incoming = new URL(request.url ?? "/", "http://mcp-trace.invalid");
    if (!isHostAllowed(request, this.#host, this.#allowedHosts)) {
      writeGatewayError(response, 403, "Host header is not allowed");
      return;
    }
    if (request.method === "GET" && incoming.pathname === "/__mcp_trace/healthz") {
      writeJson(response, 200, { status: "ok", upstream: publicUpstream(this.#upstream) });
      return;
    }
    if (request.method === "GET" && incoming.pathname === "/__mcp_trace/metrics") {
      const metrics = this.#metrics.renderPrometheus();
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      response.end(metrics);
      return;
    }
    if (incoming.pathname !== this.#endpointPath) {
      writeGatewayError(response, 404, "Gateway endpoint not found");
      return;
    }
    if (!isOriginAllowed(request, this.#allowedOrigins)) {
      writeGatewayError(response, 403, "Origin is not allowed");
      return;
    }
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      response.setHeader("allow", "POST, GET, DELETE");
      writeGatewayError(response, 405, "Method is not supported by Streamable HTTP");
      return;
    }

    await this.#proxy(request, response, incoming);
  }

  async #proxy(request: IncomingMessage, response: ServerResponse, incoming: URL): Promise<void> {
    const startedAtDate = new Date();
    const startedAt = performance.now();
    const exchangeId = randomUUID();
    const controller = new AbortController();
    this.#activeRequests.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) {
        controller.abort(new Error("Client disconnected"));
      }
    });
    request.once("aborted", () => controller.abort(new Error("Client aborted request")));

    const state: MutableExchangeState = {
      metadata: { method: "unknown", mismatches: [] },
      requestBody: Buffer.alloc(0),
      responseBody: new LimitedBuffer(this.#recordBodies ? this.#maxRecordBodyBytes : 0),
      responseContentType: undefined,
      responseHeaders: new Headers(),
      responseStatus: 502
    };
    this.#metrics.beginRequest();

    const parentContext = propagation.extract(context.active(), request.headers, {
      get: (carrier, key) => carrier[key.toLowerCase()],
      keys: (carrier) => Object.keys(carrier)
    });
    await this.#tracer.startActiveSpan("mcp.proxy", {}, parentContext, async (span) => {
      try {
        if (request.method === "POST") {
          state.requestBody = await readRequestBody(
            request,
            request.headers,
            this.#maxRequestBytes
          );
        }
        state.metadata = extractMcpMetadata(state.requestBody, request.headers);
        span.setAttributes({
          "http.request.method": request.method ?? "unknown",
          "mcp.method": state.metadata.method,
          "mcp.protocol.version": state.metadata.protocolVersion ?? "unknown",
          "server.address": this.#upstream.hostname,
          "url.full": publicUpstream(this.#upstream)
        });
        if (state.metadata.name !== undefined) {
          span.setAttribute("mcp.name", state.metadata.name);
        }
        if (state.metadata.mismatches.length > 0) {
          span.setAttribute("mcp.header_mismatches", [...state.metadata.mismatches]);
        }

        const headers = forwardingRequestHeaders(request.headers);
        for (const [name, value] of Object.entries(this.#upstreamHeaders)) {
          headers.set(name, value);
        }
        propagation.inject(context.active(), headers, {
          set: (carrier, key, value) => carrier.set(key, value)
        });

        const method = request.method ?? "POST";
        const upstreamResponse = await this.#fetch(targetUrl(this.#upstream, incoming), {
          ...(method === "POST" ? { body: state.requestBody } : {}),
          headers,
          method,
          redirect: "manual",
          signal: controller.signal
        });
        state.responseHeaders = upstreamResponse.headers;
        state.responseContentType = upstreamResponse.headers.get("content-type") ?? undefined;
        state.responseStatus = upstreamResponse.status;
        span.setAttribute("http.response.status_code", upstreamResponse.status);
        if (upstreamResponse.status >= 500) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${upstreamResponse.status}`
          });
        }

        response.writeHead(
          upstreamResponse.status,
          upstreamResponse.statusText,
          forwardingResponseHeaders(upstreamResponse.headers)
        );
        if (upstreamResponse.body === null) {
          response.end();
          return;
        }

        const reader = upstreamResponse.body.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) {
              break;
            }
            if (!(result.value instanceof Uint8Array)) {
              throw new TypeError("Upstream returned a non-byte response chunk");
            }
            state.responseBody.add(result.value);
            await writeResponseChunk(response, result.value);
          }
          response.end();
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        state.error = error instanceof Error ? error : new Error(String(error));
        span.recordException(state.error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: state.error.message });
        if (!response.headersSent) {
          const status = state.error instanceof BodyTooLargeError ? 413 : 502;
          state.responseStatus = status;
          writeGatewayError(response, status, state.error.message);
        } else if (!response.writableEnded) {
          response.destroy(state.error);
        }
      } finally {
        const durationMs = performance.now() - startedAt;
        const spanContext = span.spanContext();
        const traceId = isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
        this.#activeRequests.delete(controller);
        this.#metrics.endRequest(state.metadata.method, state.responseStatus, durationMs);
        if (this.#recorder !== undefined) {
          try {
            await this.#recordExchange(
              exchangeId,
              startedAtDate,
              durationMs,
              request,
              incoming,
              state,
              traceId
            );
          } catch (error) {
            this.#metrics.recordingError();
            this.#logger.error("Failed to write recording", { error, exchangeId });
          }
        }
        this.#logger.info("Proxied MCP request", {
          durationMs: Number(durationMs.toFixed(3)),
          exchangeId,
          method: state.metadata.method,
          status: state.responseStatus,
          ...(traceId === undefined ? {} : { traceId })
        });
        span.end();
      }
    });
  }

  async #recordExchange(
    id: string,
    startedAt: Date,
    durationMs: number,
    request: IncomingMessage,
    incoming: URL,
    state: MutableExchangeState,
    traceId: string | undefined
  ): Promise<void> {
    if (this.#recorder === undefined) {
      return;
    }
    const rawRequestContentType = request.headers["content-type"];
    const requestContentType =
      typeof rawRequestContentType === "string"
        ? rawRequestContentType
        : Array.isArray(rawRequestContentType)
          ? rawRequestContentType[0]
          : undefined;
    const responseBuffer = state.responseBody.toBuffer();
    const exchange: RecordedExchange = {
      completedAt: new Date().toISOString(),
      durationMs: Number(durationMs.toFixed(3)),
      ...(state.error === undefined
        ? {}
        : {
            error: {
              message: this.#redactor.redactText(state.error.message),
              type: errorType(state.error)
            }
          }),
      id,
      request: {
        ...(this.#recordBodies && state.requestBody.byteLength > 0
          ? {
              body: captureBody(state.requestBody.subarray(0, this.#maxRecordBodyBytes), {
                bytes: state.requestBody.byteLength,
                ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
                redactor: this.#redactor,
                truncated: state.requestBody.byteLength > this.#maxRecordBodyBytes
              })
            }
          : {}),
        bytes: state.requestBody.byteLength,
        headers: capturedHeaders(request.headers, this.#redactor),
        httpMethod: request.method ?? "unknown",
        metadata: {
          ...state.metadata,
          ...(state.metadata.name === undefined
            ? {}
            : { name: this.#redactor.redactText(state.metadata.name) })
        },
        path: capturedPath(incoming, this.#redactor)
      },
      response: {
        ...(this.#recordBodies && responseBuffer.byteLength > 0
          ? {
              body: captureBody(responseBuffer, {
                bytes: state.responseBody.bytes,
                ...(state.responseContentType === undefined
                  ? {}
                  : { contentType: state.responseContentType }),
                redactor: this.#redactor,
                truncated: state.responseBody.truncated
              })
            }
          : {}),
        bytes: state.responseBody.bytes,
        headers: capturedHeaders(state.responseHeaders, this.#redactor),
        status: state.responseStatus
      },
      schemaVersion: 1,
      startedAt: startedAt.toISOString(),
      ...(traceId === undefined ? {} : { traceId }),
      upstream: publicUpstream(this.#upstream)
    };
    await this.#recorder.write(exchange);
  }
}
