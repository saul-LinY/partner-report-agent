#!/usr/bin/env node
const baseUrl = process.argv[2];
if (!baseUrl)
  throw new Error("Usage: node scripts/check-public-api.mjs <public-base-url>");

const checks = [
  { method: "GET", path: "/health", status: 200 },
  { method: "GET", path: "/v1/project-scope", status: 401 },
  { method: "GET", path: "/v2/project-scope", status: 401 },
  { method: "POST", path: "/v1/project-scope/candidates", status: 401 },
  { method: "POST", path: "/v2/project-scope/resolve", status: 401 },
];

// No credentials are sent: successful routing must reach API authentication.
for (const check of checks) {
  const response = await fetch(new URL(check.path, baseUrl), {
    method: check.method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...(check.method === "POST"
      ? { headers: { "content-type": "application/json" }, body: "{}" }
      : {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.status !== check.status ||
    !contentType.includes("application/json")
  )
    throw new Error(
      `${check.method} ${check.path}: expected JSON ${check.status}, received ${response.status} ${contentType}`,
    );
  const body = await response.json();
  if (
    check.status === 200
      ? body.status !== "ok"
      : body.code !== "UNAUTHENTICATED"
  )
    throw new Error(`${check.method} ${check.path}: unexpected API response`);
  console.log(`${check.method} ${check.path}: JSON ${response.status} OK`);
}
