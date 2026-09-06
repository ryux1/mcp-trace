import { trace } from "@opentelemetry/api";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { McpTraceGateway } from "../src/proxy/gateway.js";
import type { TelemetryRuntime } from "../src/telemetry/tracing.js";

const execFileAsync = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL("./fixtures/python-sdk/", import.meta.url));
const gateways: McpTraceGateway[] = [];
type PythonChild = ChildProcessByStdio<null, Readable, Readable>;
const pythonServers: PythonChild[] = [];
const maxOutputBytes = 16_384;
const processTimeoutMs = 15_000;

interface ClientResult {
  readonly content: string[];
  readonly event: "result";
  readonly isError: boolean;
  readonly protocolVersion: string;
  readonly tools: string[];
}

function fakeTelemetry(): TelemetryRuntime {
  return {
    tracer: trace.getTracer(`mcp-trace-python-sdk-test-${Math.random()}`),
    shutdown: () => Promise.resolve()
  };
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length <= maxOutputBytes ? next : next.slice(-maxOutputBytes);
}

async function stopChild(child: PythonChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 2_000);
  forced.unref();
  await once(child, "exit");
  clearTimeout(forced);
}

async function startPythonServer(): Promise<URL> {
  const child = spawn("uv", ["run", "--frozen", "python", "server.py"], {
    cwd: fixtureDirectory,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  pythonServers.push(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });

  return await new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Python MCP server readiness timed out. stderr: ${stderr.trim()}`));
    }, processTimeoutMs);

    const fail = (error: Error): void => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("error", (error) => {
      fail(new Error(`Python MCP server could not start: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      fail(
        new Error(
          `Python MCP server exited before readiness (${String(code ?? signal)}). stderr: ${stderr.trim()}`
        )
      );
    });
    child.stdout.on("data", () => {
      for (const line of stdout.split(/\r?\n/u)) {
        try {
          const message = JSON.parse(line) as { event?: unknown; port?: unknown };
          if (
            message.event === "ready" &&
            typeof message.port === "number" &&
            Number.isInteger(message.port)
          ) {
            clearTimeout(timeout);
            resolve(new URL(`http://127.0.0.1:${message.port}/mcp`));
            return;
          }
        } catch {
          // Ignore partial or non-readiness output while the child starts.
        }
      }
    });
  });
}

async function startGateway(upstream: URL): Promise<URL> {
  const gateway = new McpTraceGateway({ port: 0, telemetry: fakeTelemetry(), upstream });
  gateways.push(gateway);
  const address = await gateway.start();
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(async (gateway) => gateway.close()));
  await Promise.all(pythonServers.splice(0).map(stopChild));
});

describe.skipIf(process.env.MCP_TRACE_PYTHON_INTEROP !== "1")(
  "official Python SDK compatibility",
  () => {
    it("initializes, lists tools, and calls a tool through MCP Trace", async () => {
      const upstream = await startPythonServer();
      const gateway = await startGateway(upstream);
      const { stdout, stderr } = await execFileAsync(
        "uv",
        ["run", "--frozen", "python", "client.py", gateway.toString()],
        {
          cwd: fixtureDirectory,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          maxBuffer: maxOutputBytes,
          timeout: processTimeoutMs
        }
      ).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Python MCP client failed: ${detail}`);
      });

      expect(stderr.trim()).toBe("");
      const result = JSON.parse(stdout.trim()) as ClientResult;
      expect(result.event).toBe("result");
      expect(result.protocolVersion).toMatch(/^20\d\d-\d\d-\d\d$/u);
      expect(result.tools).toContain("echo");
      expect(result.isError).toBe(false);
      expect(result.content).toEqual(["through mcp-trace: hello"]);
    });
  }
);
