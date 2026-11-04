import { describe, expect, it } from "vitest";
import { judgeSession } from "./session-judge.js";

const judge = (...prompts: Array<string | null>) =>
  judgeSession({ turnCount: prompts.length, prompts });

describe("judgeSession", () => {
  it("drops sessions whose prompts are all test messages", () => {
    expect(judge("test")).toEqual({ verdict: "drop", reason: "test" });
    expect(judge("Test!", "测试")).toEqual({ verdict: "drop", reason: "test" });
  });

  it("drops greeting-only and bare slash-command sessions", () => {
    expect(judge("你好。")).toEqual({ verdict: "drop", reason: "chitchat" });
    expect(judge("/language")).toEqual({ verdict: "drop", reason: "empty" });
    expect(judgeSession({ turnCount: 0, prompts: [] })).toEqual({
      verdict: "drop",
      reason: "empty",
    });
  });

  it("reports test over chitchat over empty when trivial kinds mix", () => {
    expect(judge("hi", "test", "/x")).toEqual({
      verdict: "drop",
      reason: "test",
    });
    expect(judge("hi", "/x")).toEqual({ verdict: "drop", reason: "chitchat" });
  });

  it("keeps a session as soon as one prompt carries a task", () => {
    expect(judge("test", "帮我看下这个报错")).toEqual({ verdict: "keep" });
    expect(judge("推送代码到github")).toEqual({ verdict: "keep" });
    expect(judge("constructor")).toEqual({ verdict: "keep" });
  });

  it("keeps sessions longer than the sampled prompts", () => {
    expect(
      judgeSession({ turnCount: 21, prompts: Array(20).fill("test") }),
    ).toEqual({ verdict: "keep" });
  });
});
