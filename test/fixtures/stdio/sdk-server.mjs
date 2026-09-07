import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "mcp-trace-stdio-test-server", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo through the MCP Trace stdio integration test",
    inputSchema: { message: z.string() }
  },
  ({ message }) => ({ content: [{ text: `through stdio: ${message}`, type: "text" }] })
);
await server.connect(new StdioServerTransport());
