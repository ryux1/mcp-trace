export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CapturedBody {
  readonly bytes: number;
  readonly format: "base64" | "json" | "text";
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly value: JsonValue | string;
}

export interface McpMetadata {
  readonly bodyMethod?: string;
  readonly headerMethod?: string;
  readonly id?: JsonPrimitive;
  readonly method: string;
  readonly mismatches: readonly string[];
  readonly name?: string;
  readonly protocolVersion?: string;
  readonly sessionHash?: string;
}

export interface RecordedRequest {
  readonly body?: CapturedBody;
  readonly bytes: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly httpMethod: string;
  readonly metadata: McpMetadata;
  readonly path: string;
}

export interface RecordedResponse {
  readonly body?: CapturedBody;
  readonly bytes: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface RecordedExchange {
  readonly completedAt: string;
  readonly durationMs: number;
  readonly error?: {
    readonly message: string;
    readonly type: string;
  };
  readonly id: string;
  readonly request: RecordedRequest;
  readonly response: RecordedResponse;
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly traceId?: string;
  readonly upstream: string;
}

export type LogLevel = "debug" | "error" | "info" | "silent" | "warn";

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}
