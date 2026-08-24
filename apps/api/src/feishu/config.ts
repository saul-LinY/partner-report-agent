export const FEISHU_APP_ID_ENV = "FEISHU_APP_ID";
export const FEISHU_APP_SECRET_ENV = "FEISHU_APP_SECRET";

export type FeishuEnvironment = Readonly<
  Partial<
    Record<typeof FEISHU_APP_ID_ENV | typeof FEISHU_APP_SECRET_ENV, string>
  >
>;

export type FeishuConfig = Readonly<{
  appId: string;
  appSecret: string;
}>;

export class FeishuConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuConfigError";
  }
}

function configuredValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/** Returns null only when neither Feishu credential has been configured. */
export function loadFeishuConfig(
  environment: FeishuEnvironment = process.env,
): FeishuConfig | null {
  const appId = configuredValue(environment[FEISHU_APP_ID_ENV]);
  const appSecret = configuredValue(environment[FEISHU_APP_SECRET_ENV]);

  if (!appId && !appSecret) return null;
  if (!appId || !appSecret) {
    throw new FeishuConfigError(
      "Feishu configuration is incomplete; FEISHU_APP_ID and FEISHU_APP_SECRET are both required",
    );
  }

  return Object.freeze({ appId, appSecret });
}

export function requireFeishuConfig(
  environment: FeishuEnvironment = process.env,
): FeishuConfig {
  const config = loadFeishuConfig(environment);
  if (!config) {
    throw new FeishuConfigError(
      "Feishu integration is not configured; FEISHU_APP_ID and FEISHU_APP_SECRET are required",
    );
  }
  return config;
}
