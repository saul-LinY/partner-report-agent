import {
  loadConfig,
  loadSecret,
  saveConfig,
  saveSecret,
  type PluginConfig,
} from "./config.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

async function rawRequest<T>(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => null)) as any;
  if (!response.ok)
    throw new HttpError(
      response.status,
      body?.code ?? "HTTP_ERROR",
      body?.message ?? response.statusText,
      body?.details,
      body?.requestId,
    );
  return body as T;
}

export async function publicRequest<T>(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
) {
  return rawRequest<T>(serverUrl, path, init);
}

async function refresh(config: PluginConfig) {
  const refreshToken = loadSecret(config.pluginInstanceId, "refresh");
  const tokens = await rawRequest<{
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    pluginInstanceId: string;
  }>(config.serverUrl, "/v1/plugin-bindings/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
  if (tokens.pluginInstanceId !== config.pluginInstanceId)
    throw new Error("刷新响应的 Plugin Instance 不匹配。");
  saveSecret(config.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(config.pluginInstanceId, "refresh", tokens.refreshToken);
  const next = { ...config, accessExpiresAt: tokens.expiresAt };
  saveConfig(next);
  return next;
}

const refreshes = new Map<string, Promise<PluginConfig>>();

function refreshOnce(config: PluginConfig) {
  const existing = refreshes.get(config.pluginInstanceId);
  if (existing) return existing;

  const pending = refresh(config).finally(() => {
    if (refreshes.get(config.pluginInstanceId) === pending) {
      refreshes.delete(config.pluginInstanceId);
    }
  });
  refreshes.set(config.pluginInstanceId, pending);
  return pending;
}

export async function authenticatedRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let config = loadConfig()!;
  if (new Date(config.accessExpiresAt).getTime() < Date.now() + 60_000)
    config = await refreshOnce(config);
  try {
    return await rawRequest<T>(
      config.serverUrl,
      path,
      init,
      loadSecret(config.pluginInstanceId, "access"),
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    config = await refreshOnce(config);
    return rawRequest<T>(
      config.serverUrl,
      path,
      init,
      loadSecret(config.pluginInstanceId, "access"),
    );
  }
}
