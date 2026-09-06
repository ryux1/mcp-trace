import { describe, expect, it } from "vitest";
import {
  delta,
  percentile,
  positiveInteger,
  summarizeScenario,
  type LoadSummary,
  type PairedSample
} from "../benchmark/helpers.mjs";

function load(p50Ms: number, p95Ms: number, requestsPerSecond: number): LoadSummary {
  return { durationMs: 100, p50Ms, p95Ms, p99Ms: p95Ms + 1, requestsPerSecond };
}

describe("benchmark result helpers", () => {
  it("uses nearest-rank percentiles and stable precision", () => {
    expect(percentile([10.1119, 1.1111, 5.5555, 20.9999], 0.5)).toBe(5.556);
    expect(percentile([10.1119, 1.1111, 5.5555, 20.9999], 0.95)).toBe(21);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("reports latency and throughput deltas", () => {
    expect(delta(load(2, 4, 1_000), load(3.25, 7.5, 750))).toEqual({
      p50Ms: 1.25,
      p95Ms: 3.5,
      throughputPercent: -25
    });
  });

  it("summarizes paired scenario samples by median", () => {
    const samples: PairedSample[] = [
      {
        candidate: load(5, 10, 500),
        delta: { p50Ms: 3, p95Ms: 6, throughputPercent: -50 },
        reference: load(2, 4, 1_000),
        run: 1
      },
      {
        candidate: load(7, 12, 400),
        delta: { p50Ms: 4, p95Ms: 7, throughputPercent: -60 },
        reference: load(3, 5, 1_000),
        run: 2
      },
      {
        candidate: load(6, 11, 450),
        delta: { p50Ms: 3.5, p95Ms: 6.5, throughputPercent: -55 },
        reference: load(2.5, 4.5, 1_000),
        run: 3
      }
    ];

    expect(summarizeScenario(samples)).toEqual({
      candidate: load(6, 11, 450),
      delta: { p50Ms: 3.5, p95Ms: 6.5, throughputPercent: -55 },
      reference: load(2.5, 4.5, 1_000)
    });
  });

  it("accepts only safe positive decimal integers", () => {
    expect(positiveInteger("32", "CONCURRENCY")).toBe(32);
    for (const value of ["", "0", "-1", "1.5", "1e2", "9007199254740992"]) {
      expect(() => positiveInteger(value, "CONCURRENCY")).toThrow(
        "CONCURRENCY must be a positive integer"
      );
    }
  });
});
