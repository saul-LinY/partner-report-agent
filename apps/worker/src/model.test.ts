import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregationResultSchema } from "@partner-report/contracts";
import { generateStructured, retryAfterMs } from "./model.js";

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
    vi.restoreAllMocks();
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

  const generate = (timeoutMs?: number) =>
    generateStructured({
      name: "reliability_test",
      schema: aggregationResultSchema,
      instructions: "Aggregate facts.",
      input: { facts: [] },
      model: "deepseek-v4-flash:cloud",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  const success = () =>
    new Response(
      JSON.stringify({
        status: "completed",
        output_text: JSON.stringify(result),
      }),
    );

  it.each(["json", "html", "network"])(
    "recovers from a temporary %s failure within the request budget",
    async (kind) => {
      vi.useFakeTimers();
      process.env.MODEL_API_KEY = "test-only-key";
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => {
          if (kind === "network")
            return Promise.reject(new TypeError("fetch failed"));
          return Promise.resolve(
            new Response(
              kind === "html"
                ? "<html>unavailable</html>"
                : JSON.stringify({ error: { message: "unavailable" } }),
              { status: 503 },
            ),
          );
        })
        .mockImplementationOnce(success);
      vi.stubGlobal("fetch", fetchMock);
      const request = expect(generate()).resolves.toEqual(result);
      await vi.advanceTimersByTimeAsync(2000);
      await request;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds transport retries and preserves HTTP diagnostics without logging provider content", async () => {
    vi.useFakeTimers();
    process.env.MODEL_API_KEY = "test-only-key";
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>private upstream details</html>", {
          status: 503,
          headers: { "x-request-id": "request-test-503" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = generate().catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await error).toMatchObject({
      code: "MODEL_SERVICE_UNAVAILABLE",
      status: 503,
      retryable: true,
      requestId: "request-test-503",
    });
    expect(await error).not.toHaveProperty(
      "message",
      expect.stringContaining("private"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 400, 422])(
    "does not retry HTTP %s configuration failures",
    async (status) => {
      process.env.MODEL_API_KEY = "test-only-key";
      const fetchMock = vi.fn(async () => new Response("denied", { status }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(generate()).rejects.toMatchObject({
        status,
        retryable: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry exhausted quota as a temporary rate limit", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "insufficient_quota" } }),
          { status: 429 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate()).rejects.toMatchObject({
      code: "MODEL_QUOTA_EXHAUSTED",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After before a short retry", async () => {
    vi.useFakeTimers();
    process.env.MODEL_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "5" } }),
      )
      .mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetchMock);
    const request = expect(generate()).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["120", "Mon, 07 Sep 2026 04:02:00 GMT"])(
    "defers long Retry-After %s to the job queue",
    async (header) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-07T04:00:00Z"));
      process.env.MODEL_API_KEY = "test-only-key";
      const fetchMock = vi.fn(
        async () =>
          new Response("busy", {
            status: 503,
            headers: { "retry-after": header },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(generate()).rejects.toMatchObject({
        retryAfterMs: 120_000,
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("shares one deadline across retries and generation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    process.env.MODEL_API_KEY = "test-only-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const request = expect(generate(3000)).rejects.toMatchObject({
      code: "MODEL_REQUEST_TIMEOUT",
      timeoutMs: 3000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    await request;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not accept valid-looking JSON from an incomplete response", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output_text: JSON.stringify(result),
            }),
          ),
      ),
    );
    await expect(generate()).rejects.toMatchObject({
      code: "MODEL_OUTPUT_TOKEN_LIMIT",
      retryable: false,
    });
  });

  it("joins text fragments before validating structured output", async () => {
    process.env.MODEL_API_KEY = "test-only-key";
    const json = JSON.stringify(result);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output: [
                {
                  type: "message",
                  content: [
                    { type: "output_text", text: json.slice(0, 20) },
                    { type: "output_text", text: json.slice(20) },
                  ],
                },
              ],
            }),
          ),
      ),
    );
    await expect(generate()).resolves.toEqual(result);
  });

  it.each([
    ["null", "MODEL_INVALID_RESPONSE"],
    ["not JSON", "MODEL_INVALID_RESPONSE"],
    [JSON.stringify({ output_text: "{}" }), "MODEL_OUTPUT_SCHEMA_INVALID"],
    [
      JSON.stringify({
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "no" }] },
        ],
      }),
      "MODEL_OUTPUT_REFUSED",
    ],
  ])("classifies malformed or refused responses (%s)", async (body, code) => {
    process.env.MODEL_API_KEY = "test-only-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(generate()).rejects.toMatchObject({ code });
  });

  it("ignores malformed Retry-After and accepts an elapsed HTTP date", () => {
    expect(retryAfterMs("nonsense")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect(
      retryAfterMs(
        "Mon, 07 Sep 2026 04:00:00 GMT",
        Date.parse("2026-09-07T04:01:00Z"),
      ),
    ).toBe(0);
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
