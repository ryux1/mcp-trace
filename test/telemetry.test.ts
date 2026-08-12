import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetry } from "../src/telemetry/tracing.js";
import { bufferFromUnknown } from "./helpers.js";

let server: Server | undefined;

afterEach(async () => {
  const activeServer = server;
  if (activeServer?.listening === true) {
    await new Promise<void>((resolve) => activeServer.close(() => resolve()));
  }
  server = undefined;
});

describe("OpenTelemetry export", () => {
  it("exports completed spans over OTLP/HTTP on shutdown", async () => {
    const requests: Array<{ bodyBytes: number; contentType?: string; path: string }> = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(bufferFromUnknown(chunk));
      }
      requests.push({
        bodyBytes: Buffer.concat(chunks).byteLength,
        ...(typeof request.headers["content-type"] === "string"
          ? { contentType: request.headers["content-type"] }
          : {}),
        path: request.url ?? ""
      });
      response.writeHead(200);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const telemetry = createTelemetry({
      endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
      serviceName: "mcp-trace-test"
    });
    telemetry.tracer.startActiveSpan("test-span", (span) => {
      span.setAttribute("mcp.method", "tools/list");
      span.end();
    });
    await telemetry.shutdown();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: "/v1/traces" });
    expect(requests[0]?.bodyBytes).toBeGreaterThan(0);
    expect(requests[0]?.contentType).toBe("application/json");
  });
});
