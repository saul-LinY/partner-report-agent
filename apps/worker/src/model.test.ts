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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.MODEL_REQUEST_TIMEOUT_MS;
    delete process.env.MODEL_MAX_OUTPUT_TOKENS;
    delete process.env.MODEL_REASONING_EFFORT;
    delete process.env.OPENAI_REASONING_EFFORT;
  });

  it("uses the Responses API JSON schema format and validates the result", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        model: "deepseek-v4-flash:cloud",
        store: false,
        max_output_tokens: 32_768,
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

  it("uses a configured output token budget", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    process.env.MODEL_MAX_OUTPUT_TOKENS = "24000";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).max_output_tokens).toBe(24_000);
      return new Response(
        JSON.stringify({ output_text: JSON.stringify(result) }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
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

  it("explicitly disables reasoning when the configured effort is none", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    process.env.MODEL_REASONING_EFFORT = "none";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).reasoning).toEqual({
        effort: "none",
      });
      return new Response(
        JSON.stringify({ output_text: JSON.stringify(result) }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
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

  it("reports incomplete response diagnostics when output text is absent", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_API_BASE_URL = "http://model.test:8080";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "resp_incomplete",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [{ type: "reasoning" }],
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
    ).rejects.toThrow(
      "status=incomplete, reason=max_output_tokens, outputTypes=reasoning",
    );
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

  it("classifies an aborted request as a model timeout", async () => {
    vi.useFakeTimers();
    process.env.MODEL_API_KEY = "test-only-key";
    process.env.MODEL_REQUEST_TIMEOUT_MS = "25";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    const request = generateStructured({
      name: "aggregation_test",
      schema: aggregationResultSchema,
      instructions: "Aggregate facts.",
      input: { facts: [] },
      model: "deepseek-v4-flash:cloud",
    });
    const rejection = expect(request).rejects.toMatchObject({
      name: "ModelRequestTimeoutError",
      code: "MODEL_REQUEST_TIMEOUT",
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});
