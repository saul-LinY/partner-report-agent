import { afterEach, describe, expect, it, vi } from "vitest";
import { localLoginEmail } from "./routes/auth.js";

afterEach(() => vi.unstubAllEnvs());
describe("local development account alias", () => {
  it("maps only the configured alias in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOCAL_ADMIN_LOGIN_ALIAS", "admin");
    vi.stubEnv("LOCAL_ADMIN_LOGIN_EMAIL", "admin@local.test");
    expect(localLoginEmail(" ADMIN ")).toBe("admin@local.test");
    expect(localLoginEmail("other@example.test")).toBe("other@example.test");
  });
  it("never enables the alias in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_ADMIN_LOGIN_ALIAS", "admin");
    vi.stubEnv("LOCAL_ADMIN_LOGIN_EMAIL", "admin@local.test");
    expect(localLoginEmail("admin")).toBe("admin");
  });
});
