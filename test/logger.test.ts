import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/utils/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured logger", () => {
  it("emits JSON at or above the configured level", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createLogger("warn");
    logger.info("hidden");
    logger.warn("visible", { count: 2, error: new Error("boom") });

    expect(write).toHaveBeenCalledTimes(1);
    const entry: unknown = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(entry).toMatchObject({
      count: 2,
      error: { message: "boom", name: "Error" },
      level: "warn",
      message: "visible"
    });
    if (typeof entry !== "object" || entry === null || !("time" in entry)) {
      throw new TypeError("Logger did not emit a time field");
    }
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("supports silent logging and non-Error fields", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createLogger("silent").error("hidden", { reason: "safe" });
    expect(write).not.toHaveBeenCalled();
  });
});
