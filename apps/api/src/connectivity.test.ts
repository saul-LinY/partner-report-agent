import { describe, expect, it } from "vitest";
import {
  CONNECTIVITY_CAPABILITY_VERSION,
  CONNECTIVITY_CHALLENGE_TTL_MS,
  validateConnectivityAttempt,
} from "./connectivity.js";
import { sha256 } from "./common.js";

const now = new Date("2026-08-04T09:00:00.000Z").getTime();
const challenge = "connectivity-challenge-value-123456";
const row = {
  connectivityChallengeHash: sha256(challenge),
  connectivityChallengeExpiresAt: new Date(now + CONNECTIVITY_CHALLENGE_TTL_MS),
  connectivityChallengeConsumedAt: null,
  connectivityStatus: "pending",
  version: "0.2.0",
  minimumPluginVersion: "0.2.0",
};
const input = {
  challenge,
  pluginVersion: "0.2.0",
  clientTime: new Date(now).toISOString(),
  capabilityVersion: CONNECTIVITY_CAPABILITY_VERSION,
};

describe("connectivity challenge validation", () => {
  it("accepts a matching short-lived challenge and supported version", () => {
    expect(validateConnectivityAttempt(row, input, now)).toBeNull();
  });

  it("rejects a mismatched or expired challenge", () => {
    expect(
      validateConnectivityAttempt(
        row,
        { ...input, challenge: "different-challenge-value-123456" },
        now,
      ),
    ).toBe("CHALLENGE_INVALID");
    expect(
      validateConnectivityAttempt(
        {
          ...row,
          connectivityChallengeExpiresAt: new Date(now - 1),
        },
        input,
        now,
      ),
    ).toBe("CHALLENGE_EXPIRED");
  });

  it("rejects unsupported versions and excessive clock skew", () => {
    expect(
      validateConnectivityAttempt(
        { ...row, minimumPluginVersion: "0.3.0" },
        input,
        now,
      ),
    ).toBe("VERSION_BLOCKED");
    expect(
      validateConnectivityAttempt(
        row,
        {
          ...input,
          clientTime: new Date(now - 11 * 60_000).toISOString(),
        },
        now,
      ),
    ).toBe("CLIENT_CLOCK_SKEW");
  });
});
