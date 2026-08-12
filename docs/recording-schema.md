# Recording schema

MCP Trace recordings are UTF-8 NDJSON. Each completed exchange occupies one line, so a partially
written final line can be identified without invalidating earlier entries.

## Version 1

```json
{
  "schemaVersion": 1,
  "id": "8bc4aa10-a605-49d0-8746-42c17ee97f10",
  "startedAt": "2026-08-13T10:00:00.000Z",
  "completedAt": "2026-08-13T10:00:00.018Z",
  "durationMs": 18.104,
  "upstream": "https://mcp.example.com/mcp",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "request": {
    "httpMethod": "POST",
    "path": "/mcp",
    "bytes": 148,
    "headers": {
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": "weather",
      "mcp-protocol-version": "2026-07-28"
    },
    "metadata": {
      "method": "tools/call",
      "name": "weather",
      "protocolVersion": "2026-07-28",
      "id": 1,
      "mismatches": []
    }
  },
  "response": {
    "status": 200,
    "bytes": 91,
    "headers": {
      "content-type": "application/json"
    }
  }
}
```

`traceId` is omitted when no valid span context exists. `error` is included when proxying or
streaming fails.

## Captured bodies

With `--record-bodies`, `request.body` and `response.body` can contain:

```json
{
  "bytes": 148,
  "format": "json",
  "redacted": true,
  "truncated": false,
  "value": {
    "jsonrpc": "2.0",
    "params": {
      "api_key": "[REDACTED]"
    }
  }
}
```

Formats:

- `json`: parsed JSON after recursive key and token redaction;
- `text`: UTF-8 text, including SSE, after heuristic redaction;
- `base64`: binary bytes; always marked `redacted: false`.

`bytes` is the original observed size. `truncated` indicates that `value` contains only the
configured prefix. Body truncation does not truncate the live proxied response.

## Metadata mismatches

For 2026 requests, `mismatches` can contain `method`, `name`, or `protocol-version` when mirrored
headers disagree with the JSON body. The gateway records the observation and lets the upstream MCP
server enforce the protocol.

## Compatibility

Readers must reject unknown `schemaVersion` values rather than guessing. Future additive fields can
be ignored. A future breaking representation will increment `schemaVersion`.
