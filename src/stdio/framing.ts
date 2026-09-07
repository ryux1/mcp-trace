import { Transform, type TransformCallback } from "node:stream";

export class StdioMessageTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`stdio message exceeds the configured ${limit}-byte limit`);
    this.name = "StdioMessageTooLargeError";
    this.limit = limit;
  }
}

export class UnterminatedStdioMessageError extends Error {
  constructor() {
    super("stdio input ended with a message that was not newline-terminated");
    this.name = "UnterminatedStdioMessageError";
  }
}

export class StdioMessageObserver extends Transform {
  readonly #limit: number;
  readonly #observe: (line: Buffer) => Promise<void>;
  #pending = Buffer.alloc(0);

  constructor(limit: number, observe: (line: Buffer) => Promise<void>) {
    super();
    this.#limit = limit;
    this.#observe = observe;
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    void this.#consume(buffer).then(() => {
      this.push(buffer);
      callback();
    }, callback);
  }

  override _flush(callback: TransformCallback): void {
    if (this.#pending.byteLength === 0) {
      callback();
      return;
    }
    callback(new UnterminatedStdioMessageError());
  }

  async #consume(chunk: Buffer): Promise<void> {
    let buffer = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    let newline = buffer.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > this.#limit) {
        throw new StdioMessageTooLargeError(this.#limit);
      }
      let line = buffer.subarray(0, newline);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      await this.#observe(Buffer.from(line));
      buffer = buffer.subarray(newline + 1);
      newline = buffer.indexOf(0x0a);
    }
    if (buffer.byteLength > this.#limit) {
      throw new StdioMessageTooLargeError(this.#limit);
    }
    this.#pending = Buffer.from(buffer);
  }
}
