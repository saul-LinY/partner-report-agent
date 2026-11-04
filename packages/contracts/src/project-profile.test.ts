import { describe, expect, it } from "vitest";
import {
  dropInvalidClaims,
  emptyProfileNote,
  keepKnownRefs,
  profileProblems,
  type ProjectProfileNote,
} from "./project-profile.js";

const claim = (text: string, refs = ["S1T1"]) => ({ text, refs });

describe("profileProblems", () => {
  it("accepts plain wording and AI/App", () => {
    expect(profileProblems("面向读者的互动故事 App，AI 陪你读", 30, true)).toEqual([]);
  });

  it("rejects over-long text, technical words, style words, credentials and English names", () => {
    expect(profileProblems("字".repeat(31), 30, true)[0]).toContain("过长");
    expect(profileProblems("调用接口读取数据库", 30, true).join()).toContain("技术词");
    expect(profileProblems("中性风格的阅读应用", 30, true).join()).toContain("界面样式词");
    expect(profileProblems("审核口令已改", 30, true).join()).toContain("密钥或口令");
    expect(profileProblems("基于 Pi 之外的 Humanizer", 30, true).join()).toContain("英文词");
  });

  it("lets a feature mention a visual option because it is something a user can do", () => {
    expect(profileProblems("切换夜读底色", 25, false)).toEqual([]);
    expect(profileProblems("切换夜读底色", 25, true).join()).toContain("界面样式词");
  });
});

describe("dropInvalidClaims", () => {
  it("removes violating claims, keeps good ones and caps list sizes", () => {
    const note: ProjectProfileNote = {
      ...emptyProfileNote,
      oneLine: claim("调用接口生成故事"),
      intro: claim("读者挑故事、参与剧情的互动阅读应用"),
      features: Array.from({ length: 8 }, (_, i) => claim(`读第${i}个故事`)),
      openIssues: [claim("用户是否愿意付费还没验证")],
    };
    const { note: cleaned, removed } = dropInvalidClaims(note);
    expect(removed).toBe(1);
    expect(cleaned.oneLine.text).toBe("");
    expect(cleaned.intro.text).not.toBe("");
    expect(cleaned.features).toHaveLength(5);
    expect(cleaned.openIssues).toHaveLength(1);
  });
});

describe("keepKnownRefs", () => {
  it("drops a claim whose every reference disappeared and de-duplicates the rest", () => {
    const note: ProjectProfileNote = {
      ...emptyProfileNote,
      oneLine: claim("互动阅读应用", ["S9T9"]),
      intro: claim("读者挑故事参与剧情", ["S1T1", "S1T1", "S9T9"]),
    };
    const result = keepKnownRefs(note, (ref) => ref === "S1T1");
    expect(result.oneLine).toEqual({ text: "", refs: [] });
    expect(result.intro.refs).toEqual(["S1T1"]);
  });
});
