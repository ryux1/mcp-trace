export function bufferFromUnknown(value: unknown): Buffer {
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new TypeError("Expected an HTTP byte chunk");
}
