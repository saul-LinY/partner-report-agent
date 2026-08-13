import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { ApiError } from "./api-error.js";

export const SESSION_COOKIE_NAME = "pra_session";
export const OAUTH_TRANSACTION_COOKIE_NAME = "pra_google_oauth";
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const OAUTH_TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

export type GoogleAuthConfig = {
  clientId: string;
  redirectUri: string;
  sessionSecret: string;
  allowedDomains: Set<string>;
  allowedEmails: Set<string>;
};

export type OAuthTransaction = {
  state: string;
  nonce: string;
  next: string;
  expiresAt: number;
};

export type GoogleIdentity = {
  subject: string;
  email: string;
  displayName: string;
  hostedDomain: string | null;
};

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function csvSet(
  value: string | undefined,
  normalize: (item: string) => string,
) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => normalize(item.trim()))
      .filter(Boolean),
  );
}

export function loadSessionSecret(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new ApiError(
      503,
      "SESSION_SECRET_MISSING",
      "SESSION_SECRET 尚未配置。",
    );
  }
  if (secret.length < 32) {
    throw new ApiError(
      503,
      "SESSION_SECRET_TOO_SHORT",
      "SESSION_SECRET 至少需要 32 个字符。",
    );
  }
  return secret;
}

export function loadGoogleAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleAuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  const sessionSecret = env.SESSION_SECRET?.trim();
  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !redirectUri && "GOOGLE_REDIRECT_URI",
    !sessionSecret && "SESSION_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new ApiError(
      503,
      "GOOGLE_AUTH_NOT_CONFIGURED",
      `Google 登录尚未正确配置：缺少 ${missing.join(", ")}。`,
    );
  }
  loadSessionSecret(env);
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri!);
  } catch {
    throw new ApiError(
      503,
      "GOOGLE_REDIRECT_URI_INVALID",
      "GOOGLE_REDIRECT_URI 必须是完整的 http(s) URL。",
    );
  }
  if (!["http:", "https:"].includes(parsedRedirect.protocol)) {
    throw new ApiError(
      503,
      "GOOGLE_REDIRECT_URI_INVALID",
      "GOOGLE_REDIRECT_URI 必须使用 http 或 https。",
    );
  }
  if (
    parsedRedirect.protocol !== "https:" &&
    parsedRedirect.hostname !== "localhost"
  ) {
    throw new ApiError(
      503,
      "GOOGLE_REDIRECT_URI_INSECURE",
      "Google 登录回调必须使用 HTTPS；本地开发仅允许 http://localhost。",
    );
  }
  return {
    clientId: clientId!,
    redirectUri: parsedRedirect.toString(),
    sessionSecret: sessionSecret!,
    allowedDomains: csvSet(env.GOOGLE_ALLOWED_DOMAIN, (item) =>
      item.replace(/^@/, "").toLowerCase(),
    ),
    allowedEmails: csvSet(env.GOOGLE_ALLOWED_EMAILS, (item) =>
      item.toLowerCase(),
    ),
  };
}

export function safeNext(value: unknown, fallback = "/admin") {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const parsed = new URL(value, "https://local.invalid");
    if (parsed.origin !== "https://local.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signaturesMatch(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSessionToken(token: string, secret?: string) {
  if (!secret) return token;
  const value = `v1.${token}`;
  return `${value}.${signature(value, secret)}`;
}

export function readSessionToken(cookie: string | undefined, secret?: string) {
  if (!cookie) return null;
  if (!cookie.startsWith("v1.")) return cookie;
  if (!secret) return null;
  const splitAt = cookie.lastIndexOf(".");
  if (splitAt <= 3) return null;
  const value = cookie.slice(0, splitAt);
  const supplied = cookie.slice(splitAt + 1);
  if (!signaturesMatch(supplied, signature(value, secret))) return null;
  return value.slice(3);
}

function cookieSecure(request: FastifyRequest) {
  const configured =
    process.env.AUTH_COOKIE_SECURE ?? process.env.SESSION_COOKIE_SECURE;
  if (configured === "true") return true;
  if (configured === "false") return false;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const externalProto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",")[0]?.trim();
  return externalProto === "https" || request.protocol === "https";
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
) {
  const sessionSecret = loadSessionSecret();
  reply.setCookie(SESSION_COOKIE_NAME, signSessionToken(token, sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(request),
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(request),
    path: "/",
  });
}

export function newOAuthTransaction(next: unknown): OAuthTransaction {
  return {
    state: randomToken(),
    nonce: randomToken(),
    next: safeNext(next),
    expiresAt: Date.now() + OAUTH_TRANSACTION_MAX_AGE_MS,
  };
}

export function encodeOAuthTransaction(
  transaction: OAuthTransaction,
  secret: string,
) {
  const payload = Buffer.from(JSON.stringify(transaction)).toString(
    "base64url",
  );
  return `${payload}.${signature(payload, secret)}`;
}

export function decodeOAuthTransaction(
  cookie: string | undefined,
  secret: string,
  now = Date.now(),
) {
  if (!cookie) return null;
  const splitAt = cookie.lastIndexOf(".");
  if (splitAt < 1) return null;
  const payload = cookie.slice(0, splitAt);
  const supplied = cookie.slice(splitAt + 1);
  if (!signaturesMatch(supplied, signature(payload, secret))) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<OAuthTransaction>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.next !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= now
    ) {
      return null;
    }
    return parsed as OAuthTransaction;
  } catch {
    return null;
  }
}

export function setOAuthTransactionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  transaction: OAuthTransaction,
  secret: string,
) {
  reply.setCookie(
    OAUTH_TRANSACTION_COOKIE_NAME,
    encodeOAuthTransaction(transaction, secret),
    {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/auth/google",
      maxAge: Math.floor(OAUTH_TRANSACTION_MAX_AGE_MS / 1000),
    },
  );
}

export function clearOAuthTransactionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.clearCookie(OAUTH_TRANSACTION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    path: "/auth/google",
  });
}

export function createGoogleClient(config: GoogleAuthConfig) {
  return new OAuth2Client({
    clientId: config.clientId,
  });
}

export async function verifyGoogleIdentity(
  client: Pick<OAuth2Client, "verifyIdToken">,
  idToken: string,
  config: GoogleAuthConfig,
  expectedNonce: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<GoogleIdentity> {
  let payload: TokenPayload | undefined;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.clientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw new ApiError(
      401,
      "GOOGLE_TOKEN_INVALID",
      "Google 身份令牌无效、已过期或不属于当前应用。",
    );
  }
  if (!payload) {
    throw new ApiError(
      401,
      "GOOGLE_TOKEN_INVALID",
      "Google 身份令牌缺少声明。",
    );
  }
  if (
    !["accounts.google.com", "https://accounts.google.com"].includes(
      payload.iss ?? "",
    ) ||
    payload.aud !== config.clientId ||
    typeof payload.exp !== "number" ||
    payload.exp <= nowSeconds ||
    typeof payload.iat !== "number" ||
    payload.iat > nowSeconds + 60 ||
    payload.iat < nowSeconds - 2 * 60 * 60 ||
    payload.iat >= payload.exp
  ) {
    throw new ApiError(
      401,
      "GOOGLE_TOKEN_INVALID",
      "Google 身份令牌声明无效。",
    );
  }
  if (payload.nonce !== expectedNonce) {
    throw new ApiError(401, "GOOGLE_NONCE_INVALID", "Google 登录 nonce 无效。");
  }
  if (payload.email_verified !== true) {
    throw new ApiError(
      403,
      "GOOGLE_EMAIL_UNVERIFIED",
      "Google 邮箱尚未通过验证。",
    );
  }
  const email = payload.email?.trim().toLowerCase();
  if (!email || !payload.sub) {
    throw new ApiError(
      401,
      "GOOGLE_IDENTITY_INCOMPLETE",
      "Google 身份缺少 email 或 sub。",
    );
  }
  const emailDomain = email.split("@")[1] ?? "";
  const hostedDomain = payload.hd?.toLowerCase() ?? null;
  const emailAllowed = config.allowedEmails.has(email);
  const domainAllowed = [...config.allowedDomains].some(
    (domain) => domain === emailDomain && domain === hostedDomain,
  );
  if (
    (config.allowedEmails.size > 0 || config.allowedDomains.size > 0) &&
    !emailAllowed &&
    !domainAllowed
  ) {
    throw new ApiError(
      403,
      "GOOGLE_ACCOUNT_NOT_ALLOWED",
      "该 Google 账号不在允许的域名或邮箱列表中。",
    );
  }
  return {
    subject: payload.sub,
    email,
    displayName: payload.name?.trim() || email,
    hostedDomain,
  };
}
