export const CLIENT_ID = "toolstile-cli";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  personal: boolean;
}

export interface Account {
  email: string;
  name: string;
  expiresAt: string;
  workspaces: Workspace[];
  /** The device named when this sign-in was approved. */
  device?: { id: string; label: string } | null;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type Fetch = typeof fetch;

async function request<T>(fetcher: Fetch, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      // Never follow a redirect with a session token to another address.
      redirect: "error",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError(0, `Could not reach ${new URL(url).origin}. Check your connection.`);
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message = body?.error_description ?? body?.message;
    throw new ApiError(
      response.status,
      typeof message === "string" ? message : `Request failed (${response.status})`,
      typeof body?.error === "string" ? body.error : undefined,
    );
  }
  return body as T;
}

/** The Toolstile endpoints the CLI uses. Session calls carry the device-flow session token. */
export function createApi(server: string, fetcher: Fetch = fetch) {
  const base = server.replace(/\/+$/, "");
  const session = (token: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  return {
    deviceCode: () =>
      request<DeviceCode>(fetcher, `${base}/api/auth/device/code`, {
        method: "POST",
        body: JSON.stringify({ client_id: CLIENT_ID }),
      }),
    deviceToken: (deviceCode: string) =>
      request<{ access_token: string; expires_in: number }>(fetcher, `${base}/api/auth/device/token`, {
        method: "POST",
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: CLIENT_ID,
        }),
      }),
    account: (token: string) => request<Account>(fetcher, `${base}/api/cli/account`, session(token)),
    signOut: (token: string) => request<void>(fetcher, `${base}/api/cli/sign-out`, session(token, { method: "POST" })),
    device: (token: string, input: { workspaceId: string; id?: string; label: string; rename?: boolean }) =>
      request<{ id: string; label: string }>(
        fetcher,
        `${base}/api/cli/device`,
        session(token, { method: "POST", body: JSON.stringify(input) }),
      ),
    agents: (token: string, workspaceId: string, deviceId: string) =>
      request<{ agents: { id: string; label: string }[] }>(
        fetcher,
        `${base}/api/cli/agents?${new URLSearchParams({ workspaceId, deviceId })}`,
        session(token),
      ),
    addAgent: (token: string, input: { workspaceId: string; deviceId: string; label: string }) =>
      request<{ id: string; label: string; token: string }>(
        fetcher,
        `${base}/api/cli/agents`,
        session(token, { method: "POST", body: JSON.stringify(input) }),
      ),
    removeAgent: (token: string, workspaceId: string, id: string) =>
      request<void>(
        fetcher,
        `${base}/api/cli/agents/${encodeURIComponent(id)}?${new URLSearchParams({ workspaceId })}`,
        session(token, { method: "DELETE" }),
      ),
  };
}

export type Api = ReturnType<typeof createApi>;
