import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../src/telemetry/metrics.js";

describe("Prometheus metrics", () => {
  it("tracks in-flight, status, latency, and recording errors", () => {
    const metrics = new MetricsRegistry([10, 100]);
    metrics.beginRequest();
    expect(metrics.renderPrometheus()).toContain("mcp_trace_in_flight_requests 1");
    metrics.endRequest('tools/call"quoted', 200, 50);
    metrics.beginRequest();
    metrics.endRequest('tools/call"quoted', 500, 150);
    metrics.recordingError();

    const output = metrics.renderPrometheus();
    expect(output).toContain("mcp_trace_in_flight_requests 0");
    expect(output).toContain('method="tools/call\\"quoted",status="200"} 1');
    expect(output).toContain('method="tools/call\\"quoted",status="500"} 1');
    expect(output).toContain('le="0.1"} 1');
    expect(output).toContain('le="+Inf"} 2');
    expect(output).toContain("mcp_trace_recording_errors_total 1");
  });

  it("bounds method-label cardinality", () => {
    const metrics = new MetricsRegistry([10], 1);
    metrics.beginRequest();
    metrics.endRequest("first/method", 200, 1);
    metrics.beginRequest();
    metrics.endRequest("attacker-controlled-method", 400, 2);
    const output = metrics.renderPrometheus();
    expect(output).toContain('method="first/method"');
    expect(output).toContain('method="other"');
    expect(output).not.toContain("attacker-controlled-method");
  });
});
