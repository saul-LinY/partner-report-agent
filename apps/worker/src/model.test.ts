import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregationResultSchema } from "@partner-report/contracts";
import { generateStructured } from "./model.js";

const result = {
  schemaVersion: "1.0",
  groups: [],
  qualityWarnings: [],
  production: {
    skillVersion: "partner-report-platform/0.2.0",
    promptVersion: "2026-08-03.central.v1",
    schemaVersion: "1.0",
    producer: "data-platform",
    modelVersion: "deepseek-v4-flash:cloud",
  },
};

describe("central structured model client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
  });

  it("uses the Responses API JSON schema format and validates the result", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        model: "deepseek-v4-flash:cloud",
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "aggregation_test",
            strict: false,
          },
        },
      });
      expect(url).toBe("http://model.test:8080/v1/responses");
      expect(body.text.format.schema.type).toBe("object");
      expect(body.text.format.schema.$schema).toBeUndefined();
      expect(body.input[0].content[0].text).toContain(
        "Return exactly one valid JSON object",
      );
      expect(body.input[0].content[0].text).toContain("<output_json_schema>");
      return new Response(
        JSON.stringify({
          id: "resp_test",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(result) }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateStructured({
        name: "aggregation_test",
        schema: aggregationResultSchema,
        instructions: "Aggregate facts.",
        input: { facts: [] },
        model: "deepseek-v4-flash:cloud",
      }),
    ).resolves.toEqual(result);
  });

  it("accepts a whole-response JSON code fence from compatible gateways", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "resp_fenced",
              output_text: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      generateStructured({
        name: "aggregation_test",
        schema: aggregationResultSchema,
        instructions: "Aggregate facts.",
        input: { facts: [] },
        model: "deepseek-v4-flash:cloud",
      }),
    ).resolves.toEqual(result);
  });

  it("rejects Markdown instead of treating it as structured output", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "resp_markdown",
              output_text: "**project** generated successfully",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      generateStructured({
        name: "aggregation_test",
        schema: aggregationResultSchema,
        instructions: "Aggregate facts.",
        input: { facts: [] },
        model: "deepseek-v4-flash:cloud",
      }),
    ).rejects.toThrow("MODEL_OUTPUT_NOT_VALID_JSON");
  });

  it("fails explicitly instead of fabricating output without an API key", async () => {
    await expect(
      generateStructured({
        name: "aggregation_test",
        schema: aggregationResultSchema,
        instructions: "Aggregate facts.",
        input: { facts: [] },
        model: "deepseek-v4-flash:cloud",
      }),
    ).rejects.toThrow("MODEL_API_KEY");
  });
});
