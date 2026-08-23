const API_URL = import.meta.env.DEV
  ? ""
  : (import.meta.env.VITE_API_URL ??
    `${window.location.protocol}//${window.location.hostname}:4310`);

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const simulatedPartnerId = window.localStorage.getItem(
    "partner-report-simulated-partner",
  );
  if (simulatedPartnerId) headers.set("x-partner-id", simulatedPartnerId);
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ code: "REQUEST_FAILED", message: response.statusText }));
    throw new ApiClientError(
      body.code,
      body.message,
      response.status,
      body.details,
    );
  }
  if (response.headers.get("content-type")?.includes("application/json"))
    return response.json() as Promise<T>;
  return response.text() as Promise<T>;
}

export function apiUrl(path: string) {
  return `${API_URL}${path}`;
}
