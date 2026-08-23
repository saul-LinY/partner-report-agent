import { describe, expect, it } from "vitest";
import { isDevelopmentLoginEnabled } from "./common.js";

describe("development login", () => {
  it("requires both development mode and the explicit login flag", () => {
    expect(
      isDevelopmentLoginEnabled({
        NODE_ENV: "development",
        PARTNER_REPORT_DEV_LOGIN: "true",
      }),
    ).toBe(true);
    expect(
      isDevelopmentLoginEnabled({
        NODE_ENV: "production",
        PARTNER_REPORT_DEV_LOGIN: "true",
      }),
    ).toBe(false);
    expect(isDevelopmentLoginEnabled({ NODE_ENV: "development" })).toBe(false);
  });
});
