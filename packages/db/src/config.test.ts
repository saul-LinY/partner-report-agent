import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./config.js";

describe("database configuration", () => {
  it("requires an explicit database host in production", () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: "production" })).toThrow(
      /DATABASE_URL is required/,
    );
    expect(
      resolveDatabaseUrl({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://app:secret@postgres.internal:5432/report",
      }),
    ).toBe("postgres://app:secret@postgres.internal:5432/report");
  });

  it("keeps the loopback database as a local development default", () => {
    expect(resolveDatabaseUrl({ NODE_ENV: "development" })).toContain(
      "localhost:54329",
    );
  });
});
