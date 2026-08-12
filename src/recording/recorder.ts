import type { WriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RecordedExchange } from "../types.js";

export class NdjsonRecorder {
  readonly #path: string;
  readonly #stream: WriteStream;
  #closed = false;

  private constructor(path: string, stream: WriteStream) {
    this.#path = path;
    this.#stream = stream;
  }

  static async create(path: string): Promise<NdjsonRecorder> {
    const resolvedPath = resolve(path);
    await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
    const handle = await open(resolvedPath, "a", 0o600);
    try {
      await handle.chmod(0o600);
      return new NdjsonRecorder(
        resolvedPath,
        handle.createWriteStream({ autoClose: true, encoding: "utf8" })
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get path(): string {
    return this.#path;
  }

  async write(exchange: RecordedExchange): Promise<void> {
    if (this.#closed) {
      throw new Error("Cannot write to a closed recorder");
    }
    const line = `${JSON.stringify(exchange)}\n`;
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
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await new Promise<void>((resolveClose, rejectClose) => {
      this.#stream.end((error?: Error | null) => {
        if (error === null || error === undefined) {
          resolveClose();
        } else {
          rejectClose(error);
        }
      });
    });
  }
}
