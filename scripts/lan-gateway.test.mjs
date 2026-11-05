import { describe, expect, it } from "vitest";
import {
  isAllowedClient,
  isAllowedRequest,
  normalizeAddress,
} from "./lan-gateway.mjs";

describe("LAN gateway request filter", () => {
  it.each([
    ["GET", "/health"],
    ["POST", "/v1/collector/bindings/claim"],
    ["GET", "/v1/collector/project-scope?x=1"],
    ["POST", "/v1/collector/uploads/0f8f/parts"],
    ["GET", "/v1/collector/sync-state"],
    ["GET", "/v1/partner/work-cards"],
    ["POST", "/v1/reviews/abc/items/def/approve"],
  ])("lets the App call %s %s", (method, url) => {
    expect(isAllowedRequest(method, url)).toBe(true);
  });

  it.each([
    ["POST", "/v1/auth/login"],
    ["GET", "/v1/admin/overview"],
    ["GET", "/v1/admin/system-logs"],
    ["GET", "/v1/me"],
    ["GET", "/v1/collector"],
    ["GET", "/v1/collector/"],
    ["GET", "/v1/collectorx/anything"],
    ["GET", "/v1/reviews"],
    ["POST", "/health"],
    ["DELETE", "/v1/collector/uploads/abc"],
    ["PUT", "/v1/collector/project-scope"],
    ["GET", "/"],
    ["GET", "v1/collector/sync-state"],
  ])("keeps %s %s away from the App's network", (method, url) => {
    expect(isAllowedRequest(method, url)).toBe(false);
  });

  it.each([
    "/v1/collector/../admin/overview",
    "/v1/collector/%2e%2e/admin/overview",
    "/v1/collector/%2E%2E%2Fadmin",
    "/v1/collector/a/./b",
    "/v1/collector//bindings/claim",
    "/v1/collector\\..\\admin",
    "/v1/reviews/..%2f..%2fadmin",
  ])("refuses a path that tries to climb out: %s", (url) => {
    expect(isAllowedRequest("GET", url)).toBe(false);
  });

  it("does not take a query string for part of the path", () => {
    expect(
      isAllowedRequest("GET", "/v1/admin/overview?x=/v1/collector/a"),
    ).toBe(false);
    expect(isAllowedRequest("GET", "/health?x=1")).toBe(true);
  });
});

describe("LAN gateway client list", () => {
  const allow = ["172.20.10.208", "172.20.10.194"];

  it("accepts a listed address, also when the socket reports it as IPv4-mapped IPv6", () => {
    expect(isAllowedClient("172.20.10.208", allow)).toBe(true);
    expect(isAllowedClient("::ffff:172.20.10.208", allow)).toBe(true);
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  it("refuses everything else, including neighbours and a missing address", () => {
    expect(isAllowedClient("172.20.10.209", allow)).toBe(false);
    expect(isAllowedClient("172.20.10.20", allow)).toBe(false);
    expect(isAllowedClient("127.0.0.1", allow)).toBe(false);
    expect(isAllowedClient(undefined, allow)).toBe(false);
    expect(isAllowedClient("", allow)).toBe(false);
    expect(isAllowedClient("172.20.10.208", [])).toBe(false);
  });
});
