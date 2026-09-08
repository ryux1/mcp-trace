import type { WriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RecordingEntry } from "../types.js";

export interface NdjsonRecorderOptions {
  readonly maxBytes?: number;
}

export interface RecordingState {
  readonly bytesWritten: number;
  readonly limitReached: boolean;
  readonly maxBytes?: number;
  readonly skippedEntries: number;
}

export type RecordingWriteResult = "limit-reached" | "skipped" | "written";

export class NdjsonRecorder {
  #bytesWritten: number;
  #closeOperation: Promise<void> | undefined;
  #closed = false;
  #limitReached: boolean;
  readonly #maxBytes: number | undefined;
  readonly #path: string;
  #skippedEntries = 0;
  readonly #stream: WriteStream;
  #writeTail: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    stream: WriteStream,
    bytesWritten: number,
    maxBytes: number | undefined
  ) {
    this.#path = path;
    this.#stream = stream;
    this.#bytesWritten = bytesWritten;
    this.#maxBytes = maxBytes;
    this.#limitReached = maxBytes !== undefined && bytesWritten >= maxBytes;
  }

  static async create(path: string, options: NdjsonRecorderOptions = {}): Promise<NdjsonRecorder> {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    ) {
      throw new RangeError("Recording byte ceiling must be a positive safe integer");
    }
    const resolvedPath = resolve(path);
    await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    const handle = await open(resolvedPath, "a", 0o600);
    try {
      await handle.chmod(0o600);
      const { size } = await handle.stat();
      return new NdjsonRecorder(
        resolvedPath,
        handle.createWriteStream({ autoClose: true }),
        size,
        options.maxBytes
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get path(): string {
    return this.#path;
  }

  get state(): RecordingState {
    return {
      bytesWritten: this.#bytesWritten,
      limitReached: this.#limitReached,
      ...(this.#maxBytes === undefined ? {} : { maxBytes: this.#maxBytes }),
      skippedEntries: this.#skippedEntries
    };
  }

  write(entry: RecordingEntry): Promise<RecordingWriteResult> {
    if (this.#closed) {
      return Promise.reject(new Error("Cannot write to a closed recorder"));
    }
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    const operation = this.#writeTail.then(async () => {
      if (this.#limitReached) {
        this.#skippedEntries += 1;
        return "skipped" as const;
      }
      if (this.#maxBytes !== undefined && this.#bytesWritten + line.byteLength > this.#maxBytes) {
        this.#limitReached = true;
        this.#skippedEntries += 1;
        return "limit-reached" as const;
      }
      await this.#writeLine(line);
      this.#bytesWritten += line.byteLength;
      return "written" as const;
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  async #writeLine(line: Buffer): Promise<void> {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#stream.write(line, (error) => {
        if (error === null || error === undefined) {
          resolveWrite();
        } else {
          rejectWrite(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closeOperation !== undefined) {
      return this.#closeOperation;
    }
    this.#closed = true;
    this.#closeOperation = (async () => {
      await this.#writeTail;
      await new Promise<void>((resolveClose, rejectClose) => {
        this.#stream.end((error?: Error | null) => {
          if (error === null || error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
      });
    })();
    return this.#closeOperation;
  }
}
