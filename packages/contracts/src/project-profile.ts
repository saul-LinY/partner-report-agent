import { z } from "zod";
import { mentionsCredential } from "./privacy.js";

// The project profile is read by managers with no technical background, so its
// wording is checked mechanically instead of trusting the model.

export const profileClaimSchema = z.object({
  text: z.string(),
  refs: z.array(z.string()),
});
export type ProfileClaim = z.infer<typeof profileClaimSchema>;

export const projectProfileNoteSchema = z.object({
  oneLine: profileClaimSchema,
  intro: profileClaimSchema,
  features: z.array(profileClaimSchema),
  status: profileClaimSchema,
  openIssues: z.array(profileClaimSchema),
});
export type ProjectProfileNote = z.infer<typeof projectProfileNoteSchema>;

export const emptyProfileNote: ProjectProfileNote = {
  oneLine: { text: "", refs: [] },
  intro: { text: "", refs: [] },
  features: [],
  status: { text: "", refs: [] },
  openIssues: [],
};

export const PROFILE_LIMITS = {
  oneLine: 30,
  intro: 120,
  feature: 25,
  status: 120,
  openIssue: 60,
} as const;
export const PROFILE_MAX_FEATURES = 5;
export const PROFILE_MAX_ISSUES = 3;

export type ProfileField = {
  label: string;
  claim: ProfileClaim;
  limit: number;
  banStyle: boolean;
};

/** Every claim with its length limit; features may name a visual option, the rest may not. */
export function profileFields(note: ProjectProfileNote): ProfileField[] {
  return [
    { label: "一句话", claim: note.oneLine, limit: PROFILE_LIMITS.oneLine, banStyle: true },
    { label: "简介", claim: note.intro, limit: PROFILE_LIMITS.intro, banStyle: true },
    ...note.features.map((claim, i) => ({
      label: `功能${i + 1}`,
      claim,
      limit: PROFILE_LIMITS.feature,
      banStyle: false,
    })),
    { label: "现状", claim: note.status, limit: PROFILE_LIMITS.status, banStyle: true },
    ...note.openIssues.map((claim, i) => ({
      label: `待解决${i + 1}`,
      claim,
      limit: PROFILE_LIMITS.openIssue,
      banStyle: true,
    })),
  ];
}

const JARGON =
  /API|接口|端口|代码|仓库|框架|数据库|前端|后端|服务器|部署|重启|进程|单元测试|测试用例|\bnpm\b|localhost|HTTP|JSON|SQL|\bgit\b|commit|\bbug\b|缓存|上下文|算法|SDK|CLI|提示词|工作流|管道|架构|依赖|版本\s*v?\d|\d+\s*项测试|\bPi\b|\bTTS\b|\.(?:js|ts|py|json|md)\b|`/i;
// Visual style and screen details say nothing about what a project is for.
const STYLE_WORDS =
  /风格|配色|底色|深色|浅色|像素|界面|排版|字号|行距|动效|动态效果|中性|雅致|主题色|真机|模拟器/;
const ALLOWED_LATIN = new Set(["ai", "app", "web", "pdf", "mvp"]);

/** Reasons a manager-facing sentence must be rewritten; empty means it is acceptable. */
export function profileProblems(text: string, limit: number, banStyle: boolean) {
  const found: string[] = [];
  const length = [...text].length;
  if (length > limit) found.push(`过长(${length}字，上限${limit}字)`);
  if (mentionsCredential(text)) found.push("涉及密钥或口令");
  const jargon = text.match(JARGON);
  if (jargon) found.push(`技术词「${jargon[0]}」`);
  const style = banStyle ? text.match(STYLE_WORDS) : null;
  if (style) found.push(`界面样式词「${style[0]}」`);
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [])
    if (!ALLOWED_LATIN.has(word.toLowerCase())) found.push(`英文词「${word}」`);
  return found;
}

/** Drops claims that still break the rules and trims lists to their maximum size. */
export function dropInvalidClaims(note: ProjectProfileNote) {
  let removed = 0;
  const keep = (claim: ProfileClaim, limit: number, banStyle: boolean) => {
    if (claim.text && profileProblems(claim.text, limit, banStyle).length) {
      removed += 1;
      return { text: "", refs: [] };
    }
    return claim;
  };
  const cleaned: ProjectProfileNote = {
    oneLine: keep(note.oneLine, PROFILE_LIMITS.oneLine, true),
    intro: keep(note.intro, PROFILE_LIMITS.intro, true),
    features: note.features
      .map((claim) => keep(claim, PROFILE_LIMITS.feature, false))
      .filter((claim) => claim.text)
      .slice(0, PROFILE_MAX_FEATURES),
    status: keep(note.status, PROFILE_LIMITS.status, true),
    openIssues: note.openIssues
      .map((claim) => keep(claim, PROFILE_LIMITS.openIssue, true))
      .filter((claim) => claim.text)
      .slice(0, PROFILE_MAX_ISSUES),
  };
  return { note: cleaned, removed };
}

/** Keeps only references that exist; a claim whose every reference vanished is dropped. */
export function keepKnownRefs(
  note: ProjectProfileNote,
  known: (ref: string) => boolean,
) {
  const fix = (claim: ProfileClaim): ProfileClaim => {
    const refs = [...new Set(claim.refs.filter(known))];
    return claim.text && refs.length ? { text: claim.text, refs } : { text: "", refs: [] };
  };
  return {
    oneLine: fix(note.oneLine),
    intro: fix(note.intro),
    features: note.features.map(fix).filter((claim) => claim.text),
    status: fix(note.status),
    openIssues: note.openIssues.map(fix).filter((claim) => claim.text),
  } satisfies ProjectProfileNote;
}

export const PROFILE_REF = /^S(\d+)T(\d+)$/;
