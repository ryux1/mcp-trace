import type { Logger, LogLevel } from "../types.js";

const levelWeights: Readonly<Record<Exclude<LogLevel, "silent">, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function serializeError(value: unknown): unknown {
  if (!(value instanceof Error)) {
    return value;
  }

  return {
    message: value.message,
    name: value.name,
    stack: value.stack
  };
}

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = level === "silent" ? Number.POSITIVE_INFINITY : levelWeights[level];

  function write(
    entryLevel: Exclude<LogLevel, "silent">,
    message: string,
    fields: Readonly<Record<string, unknown>> = {}
  ): void {
    if (levelWeights[entryLevel] < threshold) {
      return;
    }

    const normalizedFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, serializeError(value)])
    );

    process.stderr.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: entryLevel,
        message,
        ...normalizedFields
      })}\n`
    );
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    error: (message, fields) => write("error", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields)
  };
}

export const silentLogger: Logger = createLogger("silent");
