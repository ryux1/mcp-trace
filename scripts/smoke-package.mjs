import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWindows = process.platform === "win32";

function command(name) {
  return isWindows ? `${name}.cmd` : name;
}

function execute(name, arguments_, options = {}) {
  const environment = { ...process.env, ...options.env };
  if (name === "npm") {
    for (const key of [
      "npm_config__jsr_registry",
      "npm_config_npm_globalconfig",
      "npm_config_strict_peer_dependencies",
      "npm_config_verify_deps_before_run"
    ]) {
      delete environment[key];
    }
  }
  return execFileSync(command(name), arguments_, {
    ...options,
    env: environment,
    ...(isWindows ? { shell: true } : {})
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a local smoke-test port");
  }
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  );
  return address.port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("Installed MCP Trace process exited before becoming ready");
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The installed CLI is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Installed MCP Trace process did not become ready");
}

async function waitForRecording(path, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("Installed MCP Trace process exited before recording the request");
    }
    try {
      if ((await readFile(path, "utf8")).includes('"method":"tools/list"')) {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Installed MCP Trace process did not record the proxied request");
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(forceKill);
      resolve();
    };
    child.once("exit", finish);
    const forceKill = setTimeout(() => {
      if (!child.kill("SIGKILL")) {
        finish();
      }
    }, 2_000);
    if (!child.kill("SIGTERM")) {
      finish();
    }
  });
}

async function runStdioSmoke(installedCli, directory) {
  const server = join(directory, "stdio-echo-server.mjs");
  const recording = join(directory, "stdio-traffic.ndjson");
  await writeFile(server, "process.stdin.pipe(process.stdout);\n");
  const child = spawn(
    process.execPath,
    [
      installedCli,
      "stdio",
      "--record",
      recording,
      "--log-level",
      "silent",
      "--",
      process.execPath,
      server
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const message = Buffer.from(' {"jsonrpc":"2.0", "id":1, "method":"tools/list", "params":{}}\r\n');
  child.stdin.end(message);
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `Installed stdio proxy failed (${result.code ?? result.signal}): ${Buffer.concat(stderr)}`
    );
  }
  if (!Buffer.concat(stdout).equals(message)) {
    throw new Error("Installed stdio proxy did not preserve protocol bytes");
  }
  const entries = (await readFile(recording, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    entries.length !== 2 ||
    entries[0]?.schemaVersion !== 2 ||
    entries[0]?.direction !== "client-to-server" ||
    entries[1]?.direction !== "server-to-client"
  ) {
    throw new Error("Installed stdio proxy did not record both protocol directions");
  }
}

const repository = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "mcp-trace-package-"));
let upstream;
let gateway;

try {
  execute("npm", ["pack", "--pack-destination", directory], {
    cwd: repository,
    stdio: "inherit"
  });
  const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  if (archive === undefined) {
    throw new Error("npm pack did not produce a tarball");
  }
  await writeFile(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
  execute(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(directory, archive)],
    { cwd: directory, stdio: "inherit" }
  );
  const help = execute("npm", ["exec", "--offline", "--", "mcp-trace", "--help"], {
    cwd: directory,
    encoding: "utf8"
  });
  if (!help.includes("Observe, record, inspect, report, and replay")) {
    throw new Error("Installed CLI help did not contain the expected description");
  }

  const upstreamPort = await availablePort();
  const gatewayPort = await availablePort();
  const recording = join(directory, "traffic.ndjson");
  const report = join(directory, "report.html");
  upstream = createServer(async (request, response) => {
    for await (const chunk of request) {
      void chunk;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"id":1,"jsonrpc":"2.0","result":{"ok":true}}');
  });
  await new Promise((resolveListen, rejectListen) => {
    upstream.once("error", rejectListen);
    upstream.listen(upstreamPort, "127.0.0.1", resolveListen);
  });
  const installedCli = join(directory, "node_modules", "@ryux1", "mcp-trace", "dist", "cli.js");
  await runStdioSmoke(installedCli, directory);
  gateway = spawn(
    process.execPath,
    [
      installedCli,
      "proxy",
      "--upstream",
      `http://127.0.0.1:${upstreamPort}/mcp`,
      "--port",
      String(gatewayPort),
      "--record",
      recording,
      "--log-level",
      "silent"
    ],
    { stdio: "inherit" }
  );
  await waitFor(`http://127.0.0.1:${gatewayPort}/__mcp_trace/healthz`, gateway);
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    body: '{"id":1,"jsonrpc":"2.0","method":"tools/list"}',
    headers: { "content-type": "application/json", "mcp-method": "tools/list" },
    method: "POST"
  });
  if (!response.ok || !JSON.stringify(await response.json()).includes('"ok":true')) {
    throw new Error("Installed package did not proxy a request successfully");
  }
  await waitForRecording(recording, gateway);
  await stop(gateway);
  gateway = undefined;
  const reportResult = execFileSync(
    process.execPath,
    [installedCli, "report", recording, "--output", report],
    { encoding: "utf8" }
  );
  const reportHtml = await readFile(report, "utf8");
  if (
    !reportResult.includes('"exchanges": 1') ||
    !reportHtml.includes("<code>tools/list</code>") ||
    !reportHtml.includes("default-src 'none'")
  ) {
    throw new Error("Installed package did not generate the expected offline report");
  }
  process.stdout.write(
    "Packaged CLI installation, stdio/HTTP proxy, and report smoke test passed.\n"
  );
} finally {
  if (gateway !== undefined) {
    await stop(gateway);
  }
  if (upstream?.listening === true) {
    await new Promise((resolveClose) => upstream.close(() => resolveClose()));
  }
  await rm(directory, { force: true, recursive: true });
}
