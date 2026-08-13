import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("version metadata", () => {
  it("keeps the CLI version aligned with the package", async () => {
    const packageMetadata: unknown = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageMetadata).toMatchObject({ version: VERSION });
  });
});
