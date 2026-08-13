import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

async function stop(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

const repository = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "mcp-trace-package-"));
let upstream;
let gateway;

try {
  execute("pnpm", ["pack", "--pack-destination", directory], {
    cwd: repository,
    stdio: "inherit"
  });
  const archive = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  if (archive === undefined) {
    throw new Error("pnpm pack did not produce a tarball");
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
  if (!help.includes("Observe, record, inspect, and replay")) {
    throw new Error("Installed CLI help did not contain the expected description");
  }

  const upstreamPort = await availablePort();
  const gatewayPort = await availablePort();
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
  gateway = spawn(
    process.execPath,
    [
      installedCli,
      "proxy",
      "--upstream",
      `http://127.0.0.1:${upstreamPort}/mcp`,
      "--port",
      String(gatewayPort),
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
  process.stdout.write("Packaged CLI installation and proxy smoke test passed.\n");
} finally {
  if (gateway !== undefined) {
    await stop(gateway);
  }
  if (upstream?.listening === true) {
    await new Promise((resolveClose) => upstream.close(() => resolveClose()));
  }
  await rm(directory, { force: true, recursive: true });
}
