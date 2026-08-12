import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  captureBody,
  LimitedBuffer,
  readRequestBody
} from "../src/recording/body.js";
import {
  capturedHeaders,
  forwardingRequestHeaders,
  forwardingResponseHeaders
} from "../src/recording/headers.js";
import { REDACTED, Redactor } from "../src/recording/redaction.js";

describe("recording redaction", () => {
  const redactor = new Redactor(["private-field"]);

  it("redacts nested secret keys and recognizable credentials", () => {
    expect(
      redactor.redactJson({
        api_key: "sk-abcdefghijklmnop",
        nested: [{ password: "plain" }, "Bearer abcdefghijklmnop"],
        "private-field": "hidden",
        safe: "visible"
      })
    ).toEqual({
      api_key: REDACTED,
      nested: [{ password: REDACTED }, REDACTED],
      "private-field": REDACTED,
      safe: "visible"
    });
    expect(redactor.redactText("token ghp_12345678901234567890 end")).toBe(`token ${REDACTED} end`);
  });

  it("captures and sanitizes JSON and SSE bodies", () => {
    const json = captureBody(Buffer.from('{"token":"secret","answer":42}'), {
      contentType: "application/json; charset=utf-8",
      redactor
    });
    expect(json).toMatchObject({
      format: "json",
      redacted: true,
      value: { answer: 42, token: REDACTED }
    });

    const sse = captureBody(
      Buffer.from('event: message\ndata: {"password":"secret","ok":true}\n\n'),
      { contentType: "text/event-stream", redactor }
    );
    expect(sse.value).toContain(`"password":"${REDACTED}"`);
    expect(sse.value).toContain('"ok":true');
  });

  it("labels binary data as not redacted", () => {
    expect(captureBody(Buffer.from([0, 1, 2]), { redactor })).toEqual({
      bytes: 3,
      format: "base64",
      redacted: false,
      truncated: false,
      value: "AAEC"
    });
  });

  it("sanitizes malformed or truncated JSON instead of storing reversible base64", () => {
    const captured = captureBody(Buffer.from('{"password":"plain-text-secret'), {
      bytes: 80,
      contentType: "application/json",
      redactor,
      truncated: true
    });
    expect(captured).toEqual({
      bytes: 80,
      format: "text",
      redacted: true,
      truncated: true,
      value: `{"password":"${REDACTED}"`
    });
  });

  it("bounds captured streams while retaining the real byte count", () => {
    const buffer = new LimitedBuffer(4);
    buffer.add(Buffer.from("abc"));
    buffer.add(Buffer.from("def"));
    expect(buffer.bytes).toBe(6);
    expect(buffer.toBuffer().toString()).toBe("abcd");
    expect(buffer.truncated).toBe(true);
  });

  it("reads bounded request bodies", async () => {
    await expect(readRequestBody(Readable.from(["ab", "cd"]), {}, 4)).resolves.toEqual(
      Buffer.from("abcd")
    );
    await expect(
      readRequestBody(Readable.from(["abc"]), { "content-length": "3" }, 2)
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    await expect(readRequestBody(Readable.from(["ab", "cd"]), {}, 3)).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });

  it("records only safe headers while forwarding credentials", () => {
    const source = {
      accept: "application/json, text/event-stream",
      authorization: "Bearer abcdefghijklmnop",
      connection: "keep-alive",
      forwarded: "for=spoofed.example",
      host: "gateway.local",
      "mcp-method": "tools/list",
      "x-forwarded-for": "203.0.113.1",
      "x-remove-me": "dynamic-hop"
    };
    expect(capturedHeaders(source, redactor)).toEqual({
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/list"
    });
    const forwarded = forwardingRequestHeaders(source);
    expect(forwarded.get("authorization")).toBe("Bearer abcdefghijklmnop");
    expect(forwarded.get("connection")).toBeNull();
    expect(forwarded.get("host")).toBeNull();
    expect(forwarded.get("forwarded")).toBeNull();
    expect(forwarded.get("x-forwarded-for")).toBeNull();
    expect(forwarded.get("accept-encoding")).toBe("identity");
    expect(forwarded.get("via")).toBe("1.1 mcp-trace");

    const dynamic = forwardingRequestHeaders({
      connection: "x-remove-me",
      "x-remove-me": "secret-hop"
    });
    expect(dynamic.get("x-remove-me")).toBeNull();
  });

  it("preserves multiple Set-Cookie values when forwarding responses", () => {
    const headers = new Headers();
    headers.append("set-cookie", "one=1; HttpOnly");
    headers.append("set-cookie", "two=2; Secure");
    headers.set("connection", "close");
    expect(forwardingResponseHeaders(headers)).toEqual({
      "set-cookie": ["one=1; HttpOnly", "two=2; Secure"]
    });

    headers.set("connection", "x-remove-me");
    headers.set("x-remove-me", "hop-value");
    expect(forwardingResponseHeaders(headers)).not.toHaveProperty("x-remove-me");
  });
});
