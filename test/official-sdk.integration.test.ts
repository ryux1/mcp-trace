import { trace } from "@opentelemetry/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { McpTraceGateway } from "../src/proxy/gateway.js";
import type { TelemetryRuntime } from "../src/telemetry/tracing.js";
import { bufferFromUnknown } from "./helpers.js";

const clients: Client[] = [];
const gateways: McpTraceGateway[] = [];
const servers: Server[] = [];

function fakeTelemetry(): TelemetryRuntime {
  return {
    tracer: trace.getTracer(`mcp-trace-official-sdk-test-${Math.random()}`),
    shutdown: () => Promise.resolve()
  };
}

function createOfficialMcpServer(): McpServer {
  const server = new McpServer({ name: "mcp-trace-test-server", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Echo a message through the MCP Trace compatibility test",
      inputSchema: { message: z.string() }
    },
    ({ message }) => ({
      content: [{ text: `through mcp-trace: ${message}`, type: "text" }]
    })
  );
  return server;
}

async function startOfficialServer(): Promise<URL> {
  const httpServer = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(bufferFromUnknown(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    const mcpServer = createOfficialMcpServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true
    });
    response.once("close", () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      // SDK 1.30.0's optional transport callbacks are not exactOptionalPropertyTypes-compatible.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { code: -32_603, message: "Official SDK test server failed" },
            id: null,
            jsonrpc: "2.0"
          })
        );
      }
    }
  });

  httpServer.listen(0, "127.0.0.1");
  servers.push(httpServer);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  const address = httpServer.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function startGateway(upstream: URL): Promise<URL> {
  const gateway = new McpTraceGateway({
    port: 0,
    telemetry: fakeTelemetry(),
    upstream
  });
  gateways.push(gateway);
  const address = await gateway.start();
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        })
    )
  );
});

describe("official TypeScript SDK compatibility", () => {
  it("initializes, lists tools, and calls a tool through MCP Trace", async () => {
    const upstream = await startOfficialServer();
    const gateway = await startGateway(upstream);
    const client = new Client({ name: "mcp-trace-test-client", version: "1.0.0" });
    clients.push(client);

    const transport = new StreamableHTTPClientTransport(gateway);
    // SDK 1.30.0's optional sessionId is not exactOptionalPropertyTypes-compatible.
    await client.connect(transport as unknown as Transport);

    const toolList = await client.listTools();
    expect(toolList.tools.map((tool) => tool.name)).toContain("echo");

    const result = await client.callTool({
      arguments: { message: "hello" },
      name: "echo"
    });
    expect(result.content).toEqual([{ text: "through mcp-trace: hello", type: "text" }]);
  });
});
