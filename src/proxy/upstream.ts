import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HeaderSource } from "../recording/headers.js";

export interface UpstreamRequestOptions {
  readonly body?: Buffer;
  readonly fetchImplementation?: typeof fetch;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly signal: AbortSignal;
  readonly url: URL;
}

export interface UpstreamResponse {
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly headers: HeaderSource;
  readonly status: number;
  readonly statusText: string;
}

async function* fetchBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError("Upstream returned a non-byte response chunk");
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestWithFetch(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
  const fetchImplementation = options.fetchImplementation;
  if (fetchImplementation === undefined) {
    throw new Error("Fetch implementation is unavailable");
  }
  const response = await fetchImplementation(options.url, {
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: options.headers,
    method: options.method,
    redirect: "manual",
    signal: options.signal
  });
  return {
    body: response.body === null ? null : fetchBody(response.body),
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  };
}

function requestWithNode(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
  const requestImplementation =
    options.url.protocol === "http:"
      ? httpRequest
      : options.url.protocol === "https:"
        ? httpsRequest
        : undefined;
  if (requestImplementation === undefined) {
    return Promise.reject(new TypeError(`Unsupported upstream protocol: ${options.url.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const request = requestImplementation(
      options.url,
      {
        headers: options.headers,
        method: options.method,
        signal: options.signal
      },
      (response) => {
        resolve({
          body: response,
          headers: response.headers,
          status: response.statusCode ?? 502,
          statusText: response.statusMessage ?? ""
        });
      }
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

export function requestUpstream(options: UpstreamRequestOptions): Promise<UpstreamResponse> {
  return options.fetchImplementation === undefined
    ? requestWithNode(options)
    : requestWithFetch(options);
}
