#!/usr/bin/env node

import { Command, Option } from "commander";
import {
  collect,
  normalizeOtlpTraceEndpoint,
  parseByteSize,
  parseHeaderEnvironment,
  parseLogLevel,
  parsePort,
  parsePositiveInteger,
  validateEndpointPath,
  validateOrigin,
  validateUpstream
} from "./config.js";
import { McpTraceGateway } from "./proxy/gateway.js";
import { inspectRecording } from "./recording/inspect.js";
import { NdjsonRecorder } from "./recording/recorder.js";
import { Redactor } from "./recording/redaction.js";
import { replayRecording } from "./replay/replay.js";
import { createTelemetry } from "./telemetry/tracing.js";
import type { LogLevel } from "./types.js";
import { createLogger } from "./utils/logger.js";
import { VERSION } from "./version.js";

interface ProxyCliOptions {
  allowHost: string[];
  allowOrigin: string[];
  endpoint: string;
  host: string;
  logLevel: LogLevel;
  maxRecordBody: number;
  maxRequestBody: number;
  otlpEndpoint?: string;
  otlpHeaderEnv: string[];
  port: number;
  record?: string;
  recordBodies: boolean;
  redactKey: string[];
  upstream: string;
  upstreamHeaderEnv: string[];
}

interface ReplayCliOptions {
  allowRedacted: boolean;
  concurrency: number;
  execute: boolean;
  headerEnv: string[];
  iterations: number;
  rate?: number;
  timeout: number;
  upstream: string;
}

async function waitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function proxyCommand(): Command {
  return new Command("proxy")
    .description("Run the MCP tracing gateway")
    .requiredOption("-u, --upstream <url>", "fixed upstream MCP endpoint")
    .option("--host <host>", "listen address", process.env.MCP_TRACE_HOST ?? "127.0.0.1")
    .option("-p, --port <port>", "listen port", parsePort, 7_331)
    .option("--endpoint <path>", "local MCP endpoint path", "/mcp")
    .option(
      "--allow-origin <origin>",
      "allow a browser Origin header; repeatable",
      collect,
      [] as string[]
    )
    .option("--allow-host <host>", "allow a Host header; repeatable", collect, [] as string[])
    .option("--record <path>", "append sanitized NDJSON exchanges to this file")
    .option("--record-bodies", "capture sanitized request and response bodies", false)
    .option(
      "--max-request-body <size>",
      "maximum forwarded request body",
      parseByteSize,
      4 * 1_024 * 1_024
    )
    .option(
      "--max-record-body <size>",
      "maximum captured bytes per body",
      parseByteSize,
      256 * 1_024
    )
    .option("--redact-key <key>", "additional JSON/header key to redact", collect, [] as string[])
    .option(
      "--upstream-header-env <header=env>",
      "load an upstream header from an environment variable; repeatable",
      collect,
      [] as string[]
    )
    .option("--otlp-endpoint <url>", "OTLP/HTTP base or /v1/traces endpoint")
    .option(
      "--otlp-header-env <header=env>",
      "load an OTLP exporter header from an environment variable; repeatable",
      collect,
      [] as string[]
    )
    .addOption(
      new Option("--log-level <level>", "structured log verbosity")
        .choices(["debug", "info", "warn", "error", "silent"])
        .default("info")
        .argParser(parseLogLevel)
    )
    .action(async (options: ProxyCliOptions) => {
      if (options.recordBodies && options.record === undefined) {
        throw new Error("--record-bodies requires --record");
      }
      const logger = createLogger(options.logLevel);
      const upstream = validateUpstream(options.upstream);
      const endpointPath = validateEndpointPath(options.endpoint);
      const allowedOrigins = options.allowOrigin.map(validateOrigin);
      const recorder =
        options.record === undefined ? undefined : await NdjsonRecorder.create(options.record);
      const otlpEndpoint =
        options.otlpEndpoint ??
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const telemetry = createTelemetry({
        ...(otlpEndpoint === undefined
          ? {}
          : { endpoint: normalizeOtlpTraceEndpoint(otlpEndpoint) }),
        headers: parseHeaderEnvironment(options.otlpHeaderEnv)
      });
      const gateway = new McpTraceGateway({
        allowedHosts: options.allowHost,
        allowedOrigins,
        endpointPath,
        host: options.host,
        logger,
        maxRecordBodyBytes: options.maxRecordBody,
        maxRequestBytes: options.maxRequestBody,
        port: options.port,
        recordBodies: options.recordBodies,
        ...(recorder === undefined ? {} : { recorder }),
        redactor: new Redactor(options.redactKey),
        telemetry,
        upstream,
        upstreamHeaders: parseHeaderEnvironment(options.upstreamHeaderEnv)
      });
      try {
        const address = await gateway.start();
        logger.info("MCP Trace gateway started", {
          endpoint: `http://${address.address}:${address.port}${endpointPath}`,
          recordBodies: options.recordBodies,
          recording: recorder?.path,
          upstream: `${upstream.origin}${upstream.pathname}`
        });
        const signal = await waitForShutdown();
        logger.info("Shutting down MCP Trace gateway", { signal });
      } finally {
        await gateway.close();
      }
    });
}

function inspectCommand(): Command {
  return new Command("inspect")
    .description("Summarize an MCP Trace NDJSON recording")
    .argument("<recording>", "recording path")
    .action(async (recording: string) => {
      process.stdout.write(`${JSON.stringify(await inspectRecording(recording), null, 2)}\n`);
    });
}

function replayCommand(): Command {
  return new Command("replay")
    .description("Plan or execute replay of captured POST requests")
    .argument("<recording>", "recording path")
    .requiredOption("-u, --upstream <url>", "target MCP endpoint")
    .option("--execute", "send requests; without this flag replay is a dry run", false)
    .option("--allow-redacted", "replay payloads containing redaction placeholders", false)
    .option(
      "-c, --concurrency <count>",
      "parallel requests",
      (value) => parsePositiveInteger(value, "Concurrency"),
      1
    )
    .option(
      "-n, --iterations <count>",
      "repeat the recording",
      (value) => parsePositiveInteger(value, "Iterations"),
      1
    )
    .option("--rate <requests-per-second>", "global request rate", (value) =>
      parsePositiveInteger(value, "Rate")
    )
    .option(
      "--timeout <milliseconds>",
      "per-request timeout",
      (value) => parsePositiveInteger(value, "Timeout"),
      30_000
    )
    .option(
      "--header-env <header=env>",
      "load a replay header from an environment variable; repeatable",
      collect,
      [] as string[]
    )
    .action(async (recording: string, options: ReplayCliOptions) => {
      const summary = await replayRecording(recording, {
        allowRedacted: options.allowRedacted,
        concurrency: options.concurrency,
        execute: options.execute,
        headers: parseHeaderEnvironment(options.headerEnv),
        iterations: options.iterations,
        ...(options.rate === undefined ? {} : { ratePerSecond: options.rate }),
        timeoutMs: options.timeout,
        upstream: validateUpstream(options.upstream)
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (summary.failed > 0) {
        process.exitCode = 1;
      }
    });
}

export function createProgram(): Command {
  return new Command()
    .name("mcp-trace")
    .description("Observe, record, inspect, and replay MCP Streamable HTTP traffic")
    .version(VERSION)
    .addCommand(proxyCommand())
    .addCommand(inspectCommand())
    .addCommand(replayCommand());
}

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
