import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createServer } from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  local = resolve(root, ".local");
mkdirSync(local, { recursive: true });
const configPath = resolve(local, "collector-dev-config.json"),
  pidPath = resolve(local, "collector-dev-processes.json");
const command = process.argv[2] ?? "start";
if (!["start", "stop", "restart", "status"].includes(command))
  throw new Error("Use start, stop, restart or status");
const targets = process.argv[3] ? [process.argv[3]] : ["api", "web", "worker"];
if (targets.some((name) => !["api", "web", "worker"].includes(name)))
  throw new Error("Unknown service");
const read = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const config = read(configPath);
if (!config.sessionSecret) {
  config.sessionSecret = randomBytes(32).toString("hex");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
}
chmodSync(configPath, 0o600);
const urls = { api: "http://127.0.0.1:4314", web: "http://127.0.0.1:4313" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const database =
  process.env.COLLECTOR_DATABASE_URL ??
  "postgres://partner_report:partner_report@127.0.0.1:54339/partner_report";
const modelBase =
  process.env.MODEL_API_BASE_URL ??
  config.modelApiBaseUrl ??
  "http://127.0.0.1:11434";
const localModel = ["127.0.0.1", "localhost", "[::1]"].includes(
  new URL(modelBase).hostname,
);
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: "development",
  DATABASE_URL: database,
  SESSION_SECRET: config.sessionSecret,
  API_HOST: "127.0.0.1",
  API_PORT: "4314",
  WEB_ORIGIN: urls.web,
  LOCAL_LOGIN_ENABLED: "true",
  API_PROXY_TARGET: urls.api,
  LOCAL_ADMIN_LOGIN_ALIAS: "admin",
  LOCAL_ADMIN_LOGIN_EMAIL: "admin@local.test",
  MODEL_API_BASE_URL: modelBase,
  MODEL_API_KEY:
    process.env.MODEL_API_KEY ??
    config.modelApiKey ??
    (localModel ? "ollama" : ""),
  MODEL_REASONING_EFFORT: "none",
  MODEL_REQUEST_TIMEOUT_MS: process.env.MODEL_REQUEST_TIMEOUT_MS ?? "240000",
  MODEL_INSTRUCTION_ROLE:
    process.env.MODEL_INSTRUCTION_ROLE ?? (localModel ? "system" : "developer"),
};
function isOurs(pid, name) {
  if (!pid) return false;
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const signature = {
      api: "apps/api/src/server.ts",
      web: "vite/bin/vite.js",
      worker: "apps/worker/src/worker.ts",
    }[name];
    return Boolean(
      signature && text.includes(signature) && text.includes(process.execPath),
    );
  } catch {
    return false;
  }
}
async function healthy(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
let pids = read(pidPath);
if (command === "stop" || command === "restart") {
  for (const [name, pid] of Object.entries(pids))
    if (targets.includes(name) && isOurs(pid, name))
      process.kill(pid, "SIGTERM");
  for (
    let i = 0;
    i < 50 &&
    Object.entries(pids).some(
      ([name, pid]) => targets.includes(name) && isOurs(pid, name),
    );
    i++
  )
    await pause(100);
  if (
    Object.entries(pids).some(
      ([name, pid]) => targets.includes(name) && isOurs(pid, name),
    )
  )
    throw new Error("Services are still stopping; retry shortly");
  for (const name of targets) delete pids[name];
  writeFileSync(pidPath, JSON.stringify(pids), { mode: 0o600 });
}
if (command === "start" || command === "restart") {
  if (!process.env.COLLECTOR_DATABASE_URL)
    execFileSync("docker", ["start", "partner-report-collector-test"], {
      stdio: "ignore",
    });
  execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/db/src/migrate.ts"],
    { cwd: root, env, stdio: "inherit" },
  );
  for (const name of targets) {
    if (isOurs(pids[name], name)) continue;
    if (name !== "worker") await free(name === "api" ? 4314 : 4313);
    const fd = openSync(resolve(local, `collector-${name}.log`), "a", 0o600);
    const args =
      name === "web"
        ? [
            "../../node_modules/vite/bin/vite.js",
            "--host",
            "127.0.0.1",
            "--port",
            "4313",
            "--strictPort",
          ]
        : [
            "--import",
            "tsx",
            `apps/${name}/src/${name === "api" ? "server" : "worker"}.ts`,
          ];
    const child = spawn(process.execPath, args, {
      cwd: name === "web" ? resolve(root, "apps/web") : root,
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    closeSync(fd);
    child.unref();
    pids[name] = child.pid;
    writeFileSync(pidPath, JSON.stringify(pids), { mode: 0o600 });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (
        name === "worker"
          ? isOurs(child.pid, name)
          : await healthy(urls[name] + (name === "api" ? "/health" : ""))
      ) {
        ready = true;
        break;
      }
      await pause(250);
    }
    if (!ready)
      throw new Error(
        `${name} failed to start; inspect .local/collector-${name}.log`,
      );
  }
}
for (const [name, url] of Object.entries(urls))
  console.log(
    `${name}: ${url} ${(await healthy(url + (name === "api" ? "/health" : ""))) ? "ready" : "stopped"}`,
  );
console.log(`worker: ${isOurs(pids.worker, "worker") ? "running" : "stopped"}`);
