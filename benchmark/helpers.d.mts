export interface LoadSummary {
  durationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  requestsPerSecond: number;
}

export interface DeltaSummary {
  p50Ms: number;
  p95Ms: number;
  throughputPercent: number;
}

export interface PairedSample {
  candidate: LoadSummary;
  delta: DeltaSummary;
  reference: LoadSummary;
  run: number;
}

export function percentile(values: readonly number[], quantile: number): number;
export function median(values: readonly number[]): number;
export function delta(reference: LoadSummary, candidate: LoadSummary): DeltaSummary;
export function summarize(
  samples: readonly PairedSample[],
  path: "candidate" | "reference"
): LoadSummary;
export function summarizeDelta(samples: readonly PairedSample[]): DeltaSummary;
export function summarizeScenario(samples: readonly PairedSample[]): {
  candidate: LoadSummary;
  delta: DeltaSummary;
  reference: LoadSummary;
};
export function positiveInteger(value: string, label: string): number;
