import type { JsonValue } from "../types.js";

const DEFAULT_SECRET_KEYS = [
  "authorization",
  "client_secret",
  "client-secret",
  "cookie",
  "password",
  "proxy-authorization",
  "refresh_token",
  "refresh-token",
  "secret",
  "set-cookie",
  "token",
  "access_token",
  "access-token",
  "api_key",
  "api-key",
  "x-api-key"
] as const;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g
];

export const REDACTED = "[REDACTED]";

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Redactor {
  readonly #secretKeys: ReadonlySet<string>;

  constructor(additionalSecretKeys: readonly string[] = []) {
    this.#secretKeys = new Set(
      [...DEFAULT_SECRET_KEYS, ...additionalSecretKeys].map((key) => key.toLowerCase())
    );
  }

  redactJson(value: JsonValue): JsonValue {
    if (typeof value === "string") {
      return this.redactText(value);
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.redactJson(entry));
    }

    if (!isJsonRecord(value)) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        this.#secretKeys.has(key.toLowerCase()) ? REDACTED : this.redactJson(entry)
      ])
    );
  }

  redactText(value: string): string {
    let redacted = TOKEN_PATTERNS.reduce(
      (current, pattern) => current.replace(pattern, REDACTED),
      value
    );
    for (const key of this.#secretKeys) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const jsonValue = new RegExp(
        `("${escapedKey}"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"?|[^,}\\s]+)`,
        "gi"
      );
      redacted = redacted.replace(jsonValue, `$1"${REDACTED}"`);
    }
    return redacted;
  }

  redactHeader(name: string, value: string): string {
    return this.#secretKeys.has(name.toLowerCase()) ? REDACTED : this.redactText(value);
  }
}
