import { createServer } from "node:http";

const host = process.env.MCP_DEMO_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MCP_DEMO_PORT ?? "3001", 10);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("MCP_DEMO_PORT must be an integer between 0 and 65535");
}

function jsonRpcError(id, code, message) {
  return { error: { code, message }, id, jsonrpc: "2.0" };
}

const server = createServer(async (request, response) => {
  if (request.url === "/healthz" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url !== "/mcp" || request.method !== "POST") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify(jsonRpcError(null, -32601, "Method not found")));
    return;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  let message;
  try {
    message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
    return;
  }

  if (message.method !== request.headers["mcp-method"]) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify(jsonRpcError(message.id ?? null, -32020, "Header mismatch")));
    return;
  }

  const toolName = message.params?.name;
  if (toolName === "stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-accel-buffering": "no"
    });
    response.write(
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 0.5 } })}\n\n`
    );
    setTimeout(() => {
      response.end(
        `data: ${JSON.stringify({ id: message.id, jsonrpc: "2.0", result: { content: [{ text: "stream complete", type: "text" }] } })}\n\n`
      );
    }, 150);
    return;
  }

  if (toolName !== "echo") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify(jsonRpcError(message.id ?? null, -32601, "Unknown tool")));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        content: [{ text: String(message.params?.arguments?.message ?? ""), type: "text" }]
      }
    })
  );
});

server.listen(port, host, () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock MCP server did not expose a TCP port");
  }
  process.stdout.write(`Mock MCP server listening on http://${host}:${address.port}/mcp\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
