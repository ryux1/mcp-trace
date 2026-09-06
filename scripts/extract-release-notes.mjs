import { readFile, writeFile } from "node:fs/promises";

const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
const heading = `## ${packageMetadata.version} -`;
const start = changelog.indexOf(heading);
if (start < 0) {
  throw new Error(`CHANGELOG.md has no entry for ${packageMetadata.version}`);
}
const next = changelog.indexOf("\n## ", start + heading.length);
const notes = changelog.slice(start, next < 0 ? undefined : next).trim();
const output = process.argv[2];
if (output === undefined) {
  process.stdout.write(`${notes}\n`);
} else {
  await writeFile(output, `${notes}\n`);
}
