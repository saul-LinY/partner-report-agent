import { describe, expect, it, vi } from "vitest";
import {
  emptyProfileNote,
  type ProjectProfileNote,
} from "@partner-report/contracts/project-profile";
import { allowedRefs, enforceProfile, segmentTurns } from "./project-profile.js";

const claim = (text: string, refs = ["S1T1"]) => ({ text, refs });

describe("segmentTurns", () => {
  it("numbers turns by session sequence and hides secrets before any model sees them", () => {
    const [segment] = segmentTurns(4, [
      { prompt: "把书架分成在读和收藏", answer: "好的" },
      { prompt: "审核口令:4321 上现在是 WebShell 擅自设的 `123456`", answer: null },
    ]);
    expect(segment!.map((turn) => turn.ref)).toEqual(["S4T1", "S4T2"]);
    expect(JSON.stringify(segment)).not.toMatch(/123456|WebShell/);
  });

  it("splits a long session into several slices without renumbering turns", () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      prompt: `第${i}轮 ${"字".repeat(500)}`,
      answer: "字".repeat(500),
    }));
    const segments = segmentTurns(2, turns, 2_500);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.flat().map((turn) => turn.ref)).toEqual(
      turns.map((_, i) => `S2T${i + 1}`),
    );
  });
});

describe("allowedRefs", () => {
  it("allows this session's turns and refs already in the note but never a credential turn", () => {
    const previous: ProjectProfileNote = {
      ...emptyProfileNote,
      oneLine: claim("互动阅读应用", ["S1T2"]),
    };
    const known = allowedRefs(
      2,
      [{ prompt: "加一个收藏夹" }, { prompt: "把口令改成别的", answer: "已改" }],
      previous,
    );
    expect(known("S2T1")).toBe(true);
    expect(known("S1T2")).toBe(true);
    expect(known("S2T2")).toBe(false);
    expect(known("S2T9")).toBe(false);
    expect(known("not-a-ref")).toBe(false);
  });
});

describe("enforceProfile", () => {
  const bad: ProjectProfileNote = {
    ...emptyProfileNote,
    oneLine: claim("调用接口生成故事"),
    intro: claim("读者挑故事、参与剧情的互动阅读应用"),
  };

  it("leaves a clean note alone without calling the model", async () => {
    const call = vi.fn();
    const clean = { ...bad, oneLine: claim("互动故事阅读应用") };
    expect(await enforceProfile(clean, "p", call)).toEqual(clean);
    expect(call).not.toHaveBeenCalled();
  });

  it("uses the rewrite when it fixes the problem", async () => {
    const call = vi.fn(async () => ({ ...bad, oneLine: claim("让读者参与剧情的故事应用") }));
    const result = await enforceProfile(bad, "p", call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.oneLine.text).toBe("让读者参与剧情的故事应用");
  });

  it("drops the claim when the rewrite still breaks the rules or the call fails", async () => {
    const still = await enforceProfile(bad, "p", async () => bad);
    expect(still.oneLine.text).toBe("");
    expect(still.intro.text).not.toBe("");
    const failed = await enforceProfile(bad, "p", async () => {
      throw new Error("gateway down");
    });
    expect(failed.oneLine.text).toBe("");
  });
});
