import {
  PLUGIN_VERSION,
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
const recoveries = new Map<string, Promise<PluginConfig>>();

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
}

async function recover(config: PluginConfig) {
  const tokens = await rawRequest<{
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    pluginInstanceId: string;
    verifiedAt: string;
  }>(config.serverUrl, "/v1/plugin-bindings/automatic-recovery", {
    method: "POST",
    body: JSON.stringify({
      pluginInstanceId: config.pluginInstanceId,
      deviceName: config.deviceName,
      pluginVersion: PLUGIN_VERSION,
    }),
  });
  if (tokens.pluginInstanceId !== config.pluginInstanceId)
    throw new Error("自动恢复响应的 Plugin Instance 不匹配。");
  saveSecret(config.pluginInstanceId, "access", tokens.accessToken);
  saveSecret(config.pluginInstanceId, "refresh", tokens.refreshToken);
  const {
    pendingAuthRecovery: _pendingRecovery,
    pendingConnectivityChallenge: _pendingChallenge,
    ...stableConfig
  } = config;
  const next: PluginConfig = {
    ...stableConfig,
    accessExpiresAt: tokens.expiresAt,
    connectivityStatus: "verified",
    connectivityVerifiedAt: tokens.verifiedAt,
  };
  saveConfig(next);
  return next;
}

function recoverOnce(config: PluginConfig) {
  const existing = recoveries.get(config.pluginInstanceId);
  if (existing) return existing;

  const pending = recover(config).finally(() => {
    if (recoveries.get(config.pluginInstanceId) === pending) {
      recoveries.delete(config.pluginInstanceId);
    }
  });
  recoveries.set(config.pluginInstanceId, pending);
  return pending;
}

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

async function refreshOrRecover(config: PluginConfig) {
  try {
    return await refreshOnce(config);
  } catch (error) {
    if (
      errorCode(error) !== "PLUGIN_TOKEN_MISSING" &&
      !(error instanceof HttpError && error.code === "REFRESH_TOKEN_INVALID")
    )
      throw error;
    return recoverOnce(config);
  }
}

async function accessTokenOrRecover(config: PluginConfig) {
  try {
    return {
      config,
      accessToken: loadSecret(config.pluginInstanceId, "access"),
    };
  } catch (error) {
    if (errorCode(error) !== "PLUGIN_TOKEN_MISSING") throw error;
    const recovered = await recoverOnce(config);
    return {
      config: recovered,
      accessToken: loadSecret(recovered.pluginInstanceId, "access"),
    };
  }
}

export async function authenticatedRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let config = loadConfig()!;
  if (new Date(config.accessExpiresAt).getTime() < Date.now() + 60_000)
    config = await refreshOrRecover(config);
  let credentials = await accessTokenOrRecover(config);
  config = credentials.config;
  try {
    return await rawRequest<T>(
      config.serverUrl,
      path,
      init,
      credentials.accessToken,
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error;
    config = await refreshOrRecover(config);
    credentials = await accessTokenOrRecover(config);
    return rawRequest<T>(config.serverUrl, path, init, credentials.accessToken);
  }
}
