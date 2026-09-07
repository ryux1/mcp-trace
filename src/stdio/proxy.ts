import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";
import { basename } from "node:path";
import { captureBody } from "../recording/body.js";
import type { NdjsonRecorder } from "../recording/recorder.js";
import { Redactor } from "../recording/redaction.js";
import type { Logger, RecordedStdioMessage, StdioDirection } from "../types.js";
import { silentLogger } from "../utils/logger.js";
import { StdioMessageObserver } from "./framing.js";
import { parseStdioMessage, StdioRequestCorrelator } from "./protocol.js";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export interface StdioProxyOptions {
  readonly arguments?: readonly string[];
  readonly childEnvironment?: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly input?: Readable;
  readonly logger?: Logger;
  readonly maxMessageBytes?: number;
  readonly maxRecordBodyBytes?: number;
  readonly output?: Writable;
  readonly recordBodies?: boolean;
  readonly recorder?: NdjsonRecorder;
  readonly redactor?: Redactor;
  readonly shutdownGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly spawnImplementation?: typeof spawn;
  readonly stderr?: Writable;
}

export interface StdioProxyResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function childEnvironment(
  environment: NodeJS.ProcessEnv,
  clearEnvironment: boolean,
  passEnvironment: readonly string[]
): NodeJS.ProcessEnv {
  if (!clearEnvironment) {
    return { ...environment };
  }
  const retained = new Set([
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    ...passEnvironment
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) => retained.has(name) && value !== undefined)
  );
}

export function buildChildEnvironment(
  options: {
    readonly clear: boolean;
    readonly pass: readonly string[];
  },
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  for (const name of options.pass) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    if (environment[name] === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
  }
  return childEnvironment(environment, options.clear, options.pass);
}

function writeStdioMessage(
  direction: StdioDirection,
  line: Buffer,
  options: {
    readonly correlator: StdioRequestCorrelator;
    readonly logger: Logger;
    readonly maxRecordBodyBytes: number;
    readonly recordBodies: boolean;
    readonly recorder?: NdjsonRecorder;
    readonly redactor: Redactor;
  }
): Promise<void> {
  if (options.recorder === undefined) {
    return Promise.resolve();
  }
  const observedAt = performance.now();
  const parsed = parseStdioMessage(line);
  const correlation = options.correlator.observe(direction, parsed, observedAt);
  const entry: RecordedStdioMessage = {
    ...(options.recordBodies
      ? {
          body: captureBody(line.subarray(0, options.maxRecordBodyBytes), {
            bytes: line.byteLength,
            contentType: "application/json",
            redactor: options.redactor,
            truncated: line.byteLength > options.maxRecordBodyBytes
          })
        }
      : {}),
    bytes: line.byteLength,
    direction,
    ...(correlation.durationMs === undefined ? {} : { durationMs: correlation.durationMs }),
    id: randomUUID(),
    metadata: { ...parsed.metadata, method: correlation.method },
    observedAt: new Date().toISOString(),
    schemaVersion: 2,
    transport: "stdio"
  };
  return options.recorder.write(entry).catch((error: unknown) => {
    options.logger.error("Failed to write stdio recording", { error });
  });
}

function exitPromise(child: ChildProcessWithoutNullStreams): Promise<StdioProxyResult> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function runStdioProxy(options: StdioProxyOptions): Promise<StdioProxyResult> {
  if (options.executable.trim() === "") {
    throw new Error("stdio executable must not be empty");
  }
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxRecordBodyBytes = options.maxRecordBodyBytes ?? 256 * 1_024;
  if (maxMessageBytes <= 0 || maxRecordBodyBytes < 0) {
    throw new Error("stdio byte limits must be positive");
  }
  const logger = options.logger ?? silentLogger;
  const recorder = options.recorder;
  const child = (options.spawnImplementation ?? spawn)(
    options.executable,
    [...(options.arguments ?? [])],
    {
      env: options.childEnvironment ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const correlator = new StdioRequestCorrelator();
  const observe = (direction: StdioDirection) => (line: Buffer) =>
    writeStdioMessage(direction, line, {
      correlator,
      logger,
      maxRecordBodyBytes,
      recordBodies: options.recordBodies ?? false,
      ...(recorder === undefined ? {} : { recorder }),
      redactor: options.redactor ?? new Redactor()
    });
  const inputObserver = new StdioMessageObserver(maxMessageBytes, observe("client-to-server"));
  const outputObserver = new StdioMessageObserver(maxMessageBytes, observe("server-to-client"));
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  logger.info("MCP Trace stdio proxy started", {
    executable: basename(options.executable),
    recordBodies: options.recordBodies ?? false,
    recording: recorder?.path
  });

  let forcedTermination: ReturnType<typeof setTimeout> | undefined;
  let shutdownRequested = false;
  const abort = (): void => {
    if (shutdownRequested || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    shutdownRequested = true;
    child.kill("SIGTERM");
    forcedTermination = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
    forcedTermination.unref();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted === true) {
    abort();
  }

  const guardPipeline = (operation: Promise<void>): Promise<void> =>
    operation.catch((error: unknown) => {
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        options.signal?.aborted !== true
      ) {
        abort();
        throw error;
      }
    });
  const clientPipeline = guardPipeline(pipeline(input, inputObserver, child.stdin));
  const serverPipeline = guardPipeline(
    pipeline(child.stdout, outputObserver, output, { end: false })
  );
  const stderrPipeline = guardPipeline(pipeline(child.stderr, stderr, { end: false }));

  try {
    let result: StdioProxyResult;
    try {
      result = await exitPromise(child);
    } catch (error) {
      inputObserver.destroy();
      await Promise.allSettled([clientPipeline, serverPipeline, stderrPipeline]);
      throw error;
    }
    inputObserver.destroy();
    await Promise.all([serverPipeline, stderrPipeline]);
    await clientPipeline;
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (forcedTermination !== undefined) {
      clearTimeout(forcedTermination);
    }
    await recorder?.close();
  }
}
