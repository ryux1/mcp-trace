import { describe, expect, it } from "vitest";
import { extractMcpMetadata, hashSessionId, isJsonValue } from "../src/proxy/protocol.js";

describe("MCP protocol metadata", () => {
  it("extracts modern request routing metadata", () => {
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "weather",
          arguments: { city: "Brussels" },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }
        }
      })
    );

    expect(
      extractMcpMetadata(body, {
        "mcp-method": "tools/call",
        "mcp-name": "weather",
        "mcp-protocol-version": "2026-07-28"
      })
    ).toEqual({
      bodyMethod: "tools/call",
      headerMethod: "tools/call",
      id: 7,
      method: "tools/call",
      mismatches: [],
      name: "weather",
      protocolVersion: "2026-07-28"
    });
  });

  it("reports header mismatches without exposing a legacy session ID", () => {
    const session = "secret-session-value";
    const metadata = extractMcpMetadata(
      Buffer.from(
        JSON.stringify({
          id: "request-1",
          method: "resources/read",
          params: {
            uri: "file:///safe.txt",
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }
          }
        })
      ),
      {
        "mcp-method": "tools/call",
        "mcp-name": "wrong-name",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": session
      }
    );

    expect(metadata.mismatches).toEqual(["method", "name", "protocol-version"]);
    expect(metadata.sessionHash).toBe(hashSessionId(session));
    expect(JSON.stringify(metadata)).not.toContain(session);
  });

  it("handles batches, invalid JSON, notifications, and non-JSON IDs", () => {
    expect(extractMcpMetadata(Buffer.from("[]"), {}).method).toBe("batch");
    expect(extractMcpMetadata(Buffer.from("not-json"), { "mcp-method": "tools/list" })).toEqual({
      headerMethod: "tools/list",
      method: "tools/list",
      mismatches: []
    });
    expect(
      extractMcpMetadata(Buffer.from(JSON.stringify({ method: "ping", id: { bad: true } })), {})
    ).toEqual({ bodyMethod: "ping", method: "ping", mismatches: [] });
  });

  it("validates recursive JSON values", () => {
    expect(isJsonValue({ nested: [1, true, null, "value"] })).toBe(true);
    expect(isJsonValue({ invalid: undefined })).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
  });
});
