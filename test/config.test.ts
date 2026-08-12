import { describe, expect, it } from "vitest";
import {
  normalizeOtlpTraceEndpoint,
  parseByteSize,
  parseHeaderEnvironment,
  parseLogLevel,
  parsePort,
  parsePositiveInteger,
  validateEndpointPath,
  validateOrigin,
  validateUpstream
} from "../src/config.js";

describe("configuration parsing", () => {
  it("parses byte sizes and integer options", () => {
    expect(parseByteSize("4MiB")).toBe(4 * 1_024 * 1_024);
    expect(parseByteSize("250kb")).toBe(250_000);
    expect(parseByteSize("42")).toBe(42);
    expect(parsePort("0")).toBe(0);
    expect(parsePort("65535")).toBe(65_535);
    expect(parsePositiveInteger("3", "Workers")).toBe(3);
    expect(parseLogLevel("warn")).toBe("warn");
  });

  it.each(["-1", "1.5", "wat", "12gb"])("rejects invalid byte sizes: %s", (value) => {
    expect(() => parseByteSize(value)).toThrow("Invalid byte size");
  });

  it("rejects invalid numeric and log values", () => {
    expect(() => parsePort("65536")).toThrow("Invalid port");
    expect(() => parsePositiveInteger("0", "Workers")).toThrow("positive integer");
    expect(() => parseLogLevel("verbose")).toThrow("Invalid log level");
  });

  it("validates upstream URLs without accepting embedded credentials", () => {
    expect(validateUpstream("https://example.com/mcp#fragment").toString()).toBe(
      "https://example.com/mcp"
    );
    expect(() => validateUpstream("file:///tmp/socket")).toThrow("HTTP or HTTPS");
    expect(() => validateUpstream("https://user:pass@example.com/mcp")).toThrow(
      "header environment variables"
    );
  });

  it("normalizes endpoint paths and origins", () => {
    expect(validateEndpointPath("/mcp/")).toBe("/mcp");
    expect(validateOrigin("https://client.example")).toBe("https://client.example");
    expect(validateOrigin("*")).toBe("*");
    expect(() => validateEndpointPath("mcp")).toThrow("absolute path");
    expect(() => validateEndpointPath("/mcp?debug=1")).toThrow("without a query");
    expect(() => validateEndpointPath("/__mcp_trace/metrics")).toThrow("reserved");
    expect(() => validateOrigin("https://client.example/path")).toThrow("cannot contain");
  });

  it("loads headers indirectly from environment variables", () => {
    expect(
      parseHeaderEnvironment(["Authorization=MCP_TOKEN", "X-Tenant=TENANT"], {
        MCP_TOKEN: "Bearer secret",
        TENANT: "acme"
      })
    ).toEqual({ Authorization: "Bearer secret", "X-Tenant": "acme" });
    expect(() => parseHeaderEnvironment(["Authorization=MISSING"], {})).toThrow(
      "MISSING is not set"
    );
    expect(() => parseHeaderEnvironment(["broken"], {})).toThrow("Header mapping");
    expect(() => parseHeaderEnvironment(["Bad Header=VALUE"], { VALUE: "present" })).toThrow();
  });

  it("normalizes OTLP trace endpoints", () => {
    expect(normalizeOtlpTraceEndpoint("http://collector:4318")).toBe(
      "http://collector:4318/v1/traces"
    );
    expect(normalizeOtlpTraceEndpoint("https://collector/base/v1/traces")).toBe(
      "https://collector/base/v1/traces"
    );
    expect(() => normalizeOtlpTraceEndpoint("ftp://collector")).toThrow("HTTP or HTTPS");
    expect(() => normalizeOtlpTraceEndpoint("https://user:pass@collector")).toThrow(
      "header environment variables"
    );
  });
});
