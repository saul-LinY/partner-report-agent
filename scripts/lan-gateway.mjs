#!/usr/bin/env node
// HTTPS gateway for testing the macOS App on the office network without exposing the whole API.
//
// Only what the App needs gets through: the collector endpoints, work cards and reviews, and /health. Everything else
// (web login, admin API, other tenants' routes) answers 404, so the local admin account is never reachable from the LAN.
// Only listed clients (addresses or networks such as 172.20.10.0/23) may even finish a TLS handshake. Requests are
// logged without headers or bodies.
//
//   LAN_GATEWAY_ALLOW=172.20.10.0/23 node scripts/lan-gateway.mjs
//   node scripts/lan-gateway.mjs fingerprint     # SHA-256 of the certificate, to build into the App
//
// Settings (environment): LAN_GATEWAY_ALLOW (required, comma-separated IPv4 addresses or CIDR networks, no wider than /16),
// LAN_GATEWAY_HOST (0.0.0.0: the Mac's address changes with DHCP, so the allow list is the access control, not the bind
// address), LAN_GATEWAY_PORT (4315), LAN_GATEWAY_UPSTREAM (http://127.0.0.1:4314),
// LAN_GATEWAY_CERT / LAN_GATEWAY_KEY (.local/lan/server.crt, .local/lan/server.key).
import http from "node:http";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const READ = ["GET"];
const READ_WRITE = ["GET", "POST"];
const ALLOWED = [
  { methods: READ, pattern: /^\/health$/ },
  { methods: READ_WRITE, pattern: /^\/v1\/collector\/[A-Za-z0-9._~\-/]+$/ },
  { methods: READ_WRITE, pattern: /^\/v1\/partner\/work-cards$/ },
  { methods: READ_WRITE, pattern: /^\/v1\/reviews\/[A-Za-z0-9._~\-/]+$/ },
];

/** Whether the App may call this method and path. Encoded or relative path tricks are refused outright. */
export function isAllowedRequest(method, rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return false;
  const path = rawUrl.split("?")[0];
  if (/%|\\|\/\.{1,2}(\/|$)|\/\//.test(path)) return false;
  return ALLOWED.some(
    (rule) => rule.methods.includes(method) && rule.pattern.test(path),
  );
}

/** Node reports IPv4 peers on a dual-stack socket as ::ffff:a.b.c.d. */
export function normalizeAddress(address) {
  return typeof address === "string" ? address.replace(/^::ffff:/i, "") : "";
}

function ipv4ToNumber(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** `a.b.c.d` or `a.b.c.d/n`. Anything wider than /16 is refused so a typo cannot open the gateway to everyone. */
export function parseAllowEntry(entry) {
  const [address, bits, ...rest] = entry.split("/");
  const base = ipv4ToNumber(address ?? "");
  const prefix = bits === undefined ? 32 : Number(bits);
  if (
    base === null ||
    rest.length > 0 ||
    !Number.isInteger(prefix) ||
    prefix < 16 ||
    prefix > 32
  )
    throw new Error(`Invalid LAN_GATEWAY_ALLOW entry: ${entry}`);
  const size = 2 ** (32 - prefix);
  return { first: Math.floor(base / size) * size, size };
}

export function isAllowedClient(address, allowList) {
  const client = ipv4ToNumber(normalizeAddress(address));
  if (client === null) return false;
  return allowList.some((entry) => {
    try {
      const { first, size } = parseAllowEntry(entry);
      return client >= first && client < first + size;
    } catch {
      return false;
    }
  });
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
  "te",
  "trailer",
]);

function forwardHeaders(headers, clientAddress, upstream) {
  const out = {};
  for (const [name, value] of Object.entries(headers))
    if (!HOP_BY_HOP.has(name)) out[name] = value;
  out.host = upstream.host;
  out["x-forwarded-for"] = clientAddress;
  out.connection = "close";
  return out;
}

export function createGateway({ cert, key, upstream, allow, log = () => {} }) {
  const target = new URL(upstream);
  const server = https.createServer(
    { cert, key, minVersion: "TLSv1.2" },
    (req, res) => {
      const client = normalizeAddress(req.socket.remoteAddress);
      const finish = (status, body) => {
        if (!res.headersSent)
          res.writeHead(status, {
            "content-type": "application/json",
            connection: "close",
          });
        res.end(body);
        log(
          `${client} ${req.method} ${(req.url ?? "").split("?")[0]} ${status}`,
        );
      };
      if (!isAllowedRequest(req.method, req.url))
        return finish(
          404,
          JSON.stringify({ code: "NOT_FOUND", message: "Not found." }),
        );
      const proxied = http.request(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req.headers, client, target),
        },
        (upstreamResponse) => {
          res.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(res);
          res.on("close", () =>
            log(
              `${client} ${req.method} ${(req.url ?? "").split("?")[0]} ${upstreamResponse.statusCode}`,
            ),
          );
        },
      );
      proxied.setTimeout(120_000, () =>
        proxied.destroy(new Error("upstream timeout")),
      );
      proxied.on("error", () =>
        finish(
          502,
          JSON.stringify({
            code: "UPSTREAM_UNAVAILABLE",
            message: "Service unavailable.",
          }),
        ),
      );
      req.on("aborted", () => proxied.destroy());
      req.pipe(proxied);
    },
  );
  // A client that is not on the list never gets as far as a TLS handshake.
  server.on("connection", (socket) => {
    if (!isAllowedClient(socket.remoteAddress, allow)) {
      log(`${normalizeAddress(socket.remoteAddress)} refused`);
      socket.destroy();
    }
  });
  server.on("tlsClientError", () => {});
  return server;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const certPath =
    process.env.LAN_GATEWAY_CERT ?? resolve(root, ".local/lan/server.crt");
  const keyPath =
    process.env.LAN_GATEWAY_KEY ?? resolve(root, ".local/lan/server.key");
  if (process.argv[2] === "fingerprint") {
    console.log(
      new X509Certificate(readFileSync(certPath)).fingerprint256
        .replaceAll(":", "")
        .toLowerCase(),
    );
    return;
  }
  const host = process.env.LAN_GATEWAY_HOST ?? "0.0.0.0";
  const allow = (process.env.LAN_GATEWAY_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of allow) parseAllowEntry(entry);
  if (allow.length === 0)
    throw new Error(
      "Set LAN_GATEWAY_ALLOW to the client addresses that may connect.",
    );
  const port = Number(process.env.LAN_GATEWAY_PORT ?? 4315);
  const upstream = process.env.LAN_GATEWAY_UPSTREAM ?? "http://127.0.0.1:4314";
  const server = createGateway({
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    upstream,
    allow,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  server.listen(port, host, () =>
    console.log(
      `LAN gateway on https://${host}:${port} -> ${upstream}; allowed clients: ${allow.join(", ")}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
