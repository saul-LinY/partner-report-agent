import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HIDDEN,
  mentionsCredential,
  redactSensitive,
  scrubText,
} from "./privacy.js";

describe("scrubText", () => {
  it("hides a secret named in prose even when words sit between keyword and value", () => {
    const text = scrubText(
      "审核口令:4321 上现在是 WebShell 擅自设的 `123456`,而且它重启了服务",
    );
    expect(text).not.toContain("123456");
    expect(text).not.toContain("WebShell");
    expect(text).toContain(HIDDEN);
  });

  it("hides keys, addresses and local paths but keeps ordinary sentences", () => {
    const text = scrubText(
      "key sk-0123456789abcdef0123456789abcdef01234567 地址 http://203.0.113.7:8080/v1 文件 /Users/saul/a/b.ts 邮箱 a@b.com",
    );
    expect(text).not.toMatch(/sk-0123|203\.0\.113|\/Users|a@b\.com/);
    expect(scrubText("用户可以设置口令保护自己的故事")).toBe(
      "用户可以设置口令保护自己的故事",
    );
    expect(scrubText("token 过期了，重新生成一个")).toBe(
      "token 过期了，重新生成一个",
    );
  });

  it("removes blocks the host app injected into the user's message", () => {
    const text = scrubText(
      '# Files mentioned by the user:\n\n## codex-clipboard-1.png: /var/folders/x/a.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\n把页面改成三栏 <in-app-browser-context source="x">ambient</in-app-browser-context>',
    );
    expect(text).toBe("把页面改成三栏");
  });
});

describe("mentionsCredential", () => {
  it("flags credential talk, including text that was already redacted", () => {
    expect(mentionsCredential("这把 TTS 密钥已出现在聊天记录里")).toBe(true);
    expect(mentionsCredential(`key ${HIDDEN}`)).toBe(true);
    expect(mentionsCredential("把书架分成在读和收藏")).toBe(false);
  });
});

describe("redactSensitive", () => {
  it("hides credentials and identifying details but leaves every other word and the whitespace untouched", () => {
    const text =
      "部署在 http://a.example.com/x ，邮箱 a@b.com，路径 /Users/saul/p\n\n  key sk-0123456789abcdef0123456789abcdef01234567 就这样";
    const out = redactSensitive(text);
    expect(out).toBe(
      `部署在 ${HIDDEN} ，邮箱 ${HIDDEN}，路径 ${HIDDEN}\n\n  key ${HIDDEN} 就这样`,
    );
  });

  it("hides a credential written as a sentence", () => {
    const out = redactSensitive(
      "审核口令:4321 上现在是 WebShell 擅自设的 `123456`",
    );
    expect(out).not.toMatch(/123456|WebShell/);
    expect(redactSensitive("用户可以设置口令保护自己的故事")).toBe(
      "用户可以设置口令保护自己的故事",
    );
  });

  it("stops hiding a credential at the end of the clause, then hides the address on its own", () => {
    const out = redactSensitive(
      "密钥是 abcdef123456，地址 10.0.0.8:8080 保持原样",
    );
    expect(out).toBe(`密钥是 ${HIDDEN}，地址 ${HIDDEN} 保持原样`);
  });

  it("leaves file names, relative paths and long identifiers alone", () => {
    const text =
      "见 codex-clipboard-97edf189-738e-413b-9f71-3afee88a9189.png 和 apps/home/tts-provider.json 以及 some_very_long_snake_case_identifier_name_for_a_function";
    expect(redactSensitive(text)).toBe(text);
  });

  it("still hides a long mixed-case key and a hex digest", () => {
    expect(
      redactSensitive("k=Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh"),
    ).not.toMatch(/Ab3dEf6/);
    expect(
      redactSensitive("sha 0123456789abcdef0123456789abcdef01234567"),
    ).not.toMatch(/0123456789abcdef/);
  });

  it("is a no-op on empty input", () => {
    expect(redactSensitive(null)).toBe("");
    expect(redactSensitive(undefined)).toBe("");
  });
});

describe("shared redaction vectors", () => {
  // The macOS app's SecretScrubber must produce exactly these outputs too.
  const vectors: Array<{ name: string; input: string; expected: string }> =
    JSON.parse(
      readFileSync(new URL("./privacy-vectors.json", import.meta.url), "utf8"),
    );
  it.each(vectors)("$name", ({ input, expected }) => {
    expect(redactSensitive(input)).toBe(expected);
  });
});

describe("redactSensitive with texts the member let through", () => {
  it("keeps exactly those matches and hides the rest", () => {
    const text = "联系 a@b.com 或 c@d.com，服务器 10.0.0.8";
    expect(redactSensitive(text, ["a@b.com"])).toBe(
      `联系 a@b.com 或 ${HIDDEN}，服务器 ${HIDDEN}`,
    );
    // Exact text only: a longer address that merely contains it is still hidden.
    expect(redactSensitive("x a@b.com.cn y", ["a@b.com"])).toBe(
      `x ${HIDDEN} y`,
    );
  });
});
