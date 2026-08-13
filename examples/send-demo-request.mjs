import { readFile } from "node:fs/promises";

const endpoint = new URL(process.env.MCP_TRACE_URL ?? "http://127.0.0.1:7331/mcp");
const requestBody = await readFile(new URL("./request.json", import.meta.url), "utf8");
const parsed = JSON.parse(requestBody);

const response = await fetch(endpoint, {
  body: requestBody,
  headers: {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": parsed.method,
    "mcp-name": parsed.params.name,
    "mcp-protocol-version": parsed.params._meta["io.modelcontextprotocol/protocolVersion"]
  },
  method: "POST"
});

if (!response.ok) {
  throw new Error(`MCP Trace demo returned HTTP ${response.status}: ${await response.text()}`);
}

process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
