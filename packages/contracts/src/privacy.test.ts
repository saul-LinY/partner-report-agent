import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HIDDEN,
  mentionsCredential,
  redactCredentials,
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

describe("redactCredentials", () => {
  it("hides access-granting values but leaves everything else untouched, whitespace included", () => {
    const text =
      "部署在 http://a.example.com/x ，邮箱 a@b.com，路径 /Users/saul/p\n\n  key sk-0123456789abcdef0123456789abcdef01234567 就这样";
    const out = redactCredentials(text);
    expect(out).not.toContain("sk-0123");
    expect(out).toContain("http://a.example.com/x");
    expect(out).toContain("a@b.com");
    expect(out).toContain("/Users/saul/p");
    expect(out).toContain("\n\n  key ");
  });

  it("hides a credential written as a sentence", () => {
    const out = redactCredentials(
      "审核口令:4321 上现在是 WebShell 擅自设的 `123456`",
    );
    expect(out).not.toMatch(/123456|WebShell/);
    expect(redactCredentials("用户可以设置口令保护自己的故事")).toBe(
      "用户可以设置口令保护自己的故事",
    );
  });

  it("stops hiding at the end of the clause so nearby addresses survive", () => {
    const out = redactCredentials(
      "密钥是 abcdef123456，地址 10.0.0.8:8080 保持原样",
    );
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain("10.0.0.8:8080");
  });

  it("leaves file names, paths and long identifiers alone", () => {
    const text =
      "见 codex-clipboard-97edf189-738e-413b-9f71-3afee88a9189.png 和 /Users/saul/Documents/ChatGPT/app_novel/.local/tts-provider.json 以及 some_very_long_snake_case_identifier_name_for_a_function";
    expect(redactCredentials(text)).toBe(text);
    expect(
      redactCredentials(
        "密码见 [成员凭据](/Users/saul/Documents/ChatGPT/app_novel/.local/accounts.json)",
      ),
    ).toBe(
      "密码见 [成员凭据](/Users/saul/Documents/ChatGPT/app_novel/.local/accounts.json)",
    );
  });

  it("still hides a long mixed-case key and a hex digest", () => {
    expect(
      redactCredentials("k=Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh"),
    ).not.toMatch(/Ab3dEf6/);
    expect(
      redactCredentials("sha 0123456789abcdef0123456789abcdef01234567"),
    ).not.toMatch(/0123456789abcdef/);
  });

  it("is a no-op on empty input", () => {
    expect(redactCredentials(null)).toBe("");
    expect(redactCredentials(undefined)).toBe("");
  });
});

describe("shared redaction vectors", () => {
  // The macOS app's SecretScrubber must produce exactly these outputs too.
  const vectors: Array<{ name: string; input: string; expected: string }> =
    JSON.parse(
      readFileSync(new URL("./privacy-vectors.json", import.meta.url), "utf8"),
    );
  it.each(vectors)("$name", ({ input, expected }) => {
    expect(redactCredentials(input)).toBe(expected);
  });
});
