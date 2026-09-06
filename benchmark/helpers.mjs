export function percentile(values, quantile) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}

export function median(values) {
  return percentile(values, 0.5);
}

export function delta(reference, candidate) {
  return {
    p50Ms: Number((candidate.p50Ms - reference.p50Ms).toFixed(3)),
    p95Ms: Number((candidate.p95Ms - reference.p95Ms).toFixed(3)),
    throughputPercent: Number(
      ((candidate.requestsPerSecond / reference.requestsPerSecond) * 100 - 100).toFixed(1)
    )
  };
}

export function summarize(samples, path) {
  return {
    durationMs: median(samples.map((sample) => sample[path].durationMs)),
    p50Ms: median(samples.map((sample) => sample[path].p50Ms)),
    p95Ms: median(samples.map((sample) => sample[path].p95Ms)),
    p99Ms: median(samples.map((sample) => sample[path].p99Ms)),
    requestsPerSecond: median(samples.map((sample) => sample[path].requestsPerSecond))
  };
}

export function summarizeDelta(samples) {
  return {
    p50Ms: median(samples.map((sample) => sample.delta.p50Ms)),
    p95Ms: median(samples.map((sample) => sample.delta.p95Ms)),
    throughputPercent: median(samples.map((sample) => sample.delta.throughputPercent))
  };
}

export function summarizeScenario(samples) {
  return {
    candidate: summarize(samples, "candidate"),
    delta: summarizeDelta(samples),
    reference: summarize(samples, "reference")
  };
}

export function positiveInteger(value, label) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
