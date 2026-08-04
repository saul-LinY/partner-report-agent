import { describe, expect, it } from "vitest";
import {
  classifyDiagnosticError,
  diagnosticMessage,
  isTerminalExtractionError,
} from "./diagnostics.js";
import { HttpError } from "./http.js";

describe("safe plugin diagnostics", () => {
  it("preserves only mapped server codes and request ids", () => {
    expect(
      classifyDiagnosticError(
        new HttpError(
          401,
          "PLUGIN_BINDING_INVALID",
          "raw server detail",
          undefined,
          "req-safe",
        ),
        "SYNC_FAILED",
      ),
    ).toEqual({ code: "AUTH_FAILED", requestId: "req-safe" });
    expect(diagnosticMessage("AUTH_FAILED")).not.toContain("raw server detail");
  });

  it("maps common network causes without storing raw exceptions", () => {
    const error = Object.assign(new TypeError("request failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(classifyDiagnosticError(error, "SYNC_FAILED")).toEqual({
      code: "CONNECTION_REFUSED",
    });
  });

  it("treats only sensitive egress rejection as terminal per job", () => {
    expect(isTerminalExtractionError("SENSITIVE_EGRESS_REJECTED")).toBe(true);
    expect(isTerminalExtractionError("LOCAL_AGENT_FAILED")).toBe(false);
  });
});
