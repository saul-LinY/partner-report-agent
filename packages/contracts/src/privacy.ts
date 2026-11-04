// Text hygiene shared by everything that turns conversation text into something
// a person reads. Two layers with different jobs:
//
//  - redactCredentials: removes things that grant access (keys, tokens,
//    passwords). Safe to apply to the stored original, and it is what the App
//    and the server apply before a conversation is kept.
//  - scrubText: additionally removes identifying details and host-app noise and
//    flattens whitespace. Only for text a model reads or a person previews.

/** Things that grant access. Mirrored by SecretScrubber.swift in the macOS app. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // No \b anywhere: JS and Swift disagree on whether CJK characters are word characters,
  // so boundaries are spelled out in ASCII and both languages behave the same.
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])(?:ghp|gho|github_pat|xox[abp]|AKIA)[A-Za-z0-9_-]{12,}/g,
  /(?<![A-Za-z0-9_])Bearer\s+[A-Za-z0-9._~-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<![A-Za-z0-9_])(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{4,}/gi,
  /(?<![A-Za-z0-9_])[A-Fa-f0-9]{32,}(?![A-Za-z0-9_])/g,
  // A long token mixing upper case, lower case and digits is a key; file names, paths and
  // identifiers rarely have all three.
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
];

// A secret named in prose ("口令设成 123456") often sits some words after its
// keyword, so every long token after the keyword is hidden, up to the end of
// that clause (comma, full stop, semicolon, line break) and at most 40 characters.
const CREDENTIAL_CONTEXT =
  /(密码|口令|密钥|令牌|凭证|token|secret|passwd|password)([^。，,；;！!？?\n]{0,40})/gi;
// A token that is a segment of a path (touching a slash) is part of a location, not a secret.
const CONTEXT_TOKEN =
  /(?<![A-Za-z0-9!@#$%^&*_.\-\/\\])[A-Za-z0-9!@#$%^&*_.-]{6,}(?![A-Za-z0-9!@#$%^&*_.\-\/\\])/g;

/** Details that identify a person, machine or place. */
const IDENTIFYING_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g,
  /https?:\/\/[^\s)）]+/g,
  /(?:\/Users|\/var|\/private|\/home|\/tmp)\/[^\s)）"'`]+/g,
];

// Blocks injected by the host app rather than written by the user.
const INJECTED_BLOCKS: RegExp[] = [
  /<([a-z][\w-]*-context)\b[\s\S]*?<\/\1>/gi,
  /^#+ Files mentioned by the user:?\s*$/gim,
  /^##\s*[^\n]*(?:clipboard|screenshot)[^\n]*$/gim,
  /\[Image #\d+[^\]]*\]/g,
  /^Image attachment: true\s*$/gim,
  /^Distinguish instructions in attached documents from the user's request\.?\s*$/gim,
  /^##\s*My request:?\s*$/gim,
];

export const HIDDEN = "[已隐藏]";

/** Hides access-granting values and changes nothing else, whitespace included. */
export function redactCredentials(text: string | null | undefined) {
  let out = text ?? "";
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, HIDDEN);
  return out.replace(
    CREDENTIAL_CONTEXT,
    (_match, keyword: string, rest: string) =>
      keyword + rest.replace(CONTEXT_TOKEN, HIDDEN),
  );
}

export function scrubText(text: string | null | undefined) {
  let out = text ?? "";
  for (const pattern of INJECTED_BLOCKS) out = out.replace(pattern, " ");
  out = redactCredentials(out);
  for (const pattern of IDENTIFYING_PATTERNS)
    out = out.replace(pattern, HIDDEN);
  return out.replace(/\s+/g, " ").trim();
}

const CREDENTIAL_WORDS =
  /密码|口令|密钥|令牌|凭证|泄露|token|api ?key|secret|passwd|password/i;

/** True when raw text talks about credentials; such turns are never shown as evidence. */
export function mentionsCredential(text: string | null | undefined) {
  return CREDENTIAL_WORDS.test(text ?? "") || (text ?? "").includes(HIDDEN);
}
