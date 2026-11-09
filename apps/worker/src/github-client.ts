import { setTimeout as delay } from "node:timers/promises";

export interface GitHubCredentials {
  readonly GH_TOKEN?: string;
  readonly [key: `GH_TOKEN_${string}`]: string | undefined;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: number | null,
    path: string,
    reset: string | null,
    details = "",
  ) {
    super(
      `GitHub ${path}: HTTP ${status}; rate limit resets at ${reset ?? "unknown"}. Snapshot was not published.${details ? ` ${details}` : ""}`,
    );
  }
}

function rejectionReason(message: unknown): string {
  if (typeof message !== "string")
    return "No GitHub rejection reason supplied.";
  const reasons: readonly (readonly [string, string])[] = [
    ["bad credentials", "GitHub rejected the credential."],
    [
      "resource not accessible by personal access token",
      "Resource not accessible by personal access token.",
    ],
    [
      "resource not accessible by integration",
      "Resource not accessible by integration.",
    ],
    [
      "oauth app access restrictions",
      "Organization restricts OAuth application access.",
    ],
    ["saml", "Organization requires SAML authorization."],
    ["ip allow", "Organization IP allowlist denied the request."],
    [
      "fine-grained",
      "GitHub rejected fine-grained token access to this endpoint.",
    ],
    ["rate limit", "GitHub rate limit exceeded."],
  ];
  for (const [pattern, reason] of reasons) {
    if (message.toLowerCase().includes(pattern)) return reason;
  }
  return "Unrecognized GitHub rejection reason; consult GitHub endpoint permissions.";
}

function createGitHubRequest(token: string | null, request: typeof fetch) {
  async function github<T>(path: string, body?: object): Promise<T> {
    const send = () =>
      request(`https://api.github.com${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          accept: "application/vnd.github+json",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          "user-agent": "workforce-activity",
          "x-github-api-version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    let response = await send();
    for (
      let retry = 1;
      retry <= 2 && [500, 502, 503, 504].includes(response.status);
      retry += 1
    ) {
      const waitMs = 1000 * 2 ** (retry - 1);
      console.warn(
        `GitHub ${path}: HTTP ${response.status}; retry ${retry}/2 in ${waitMs}ms.`,
      );
      await response.body?.cancel();
      await delay(waitMs);
      response = await send();
    }
    if (!response.ok) {
      const reset = response.headers.get("x-ratelimit-reset");
      const retryAfter = response.headers.get("retry-after");
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (retryAfter !== null ||
            response.headers.get("x-ratelimit-remaining") === "0"));
      const retrySeconds = Number(retryAfter);
      const resetSeconds = Number(reset);
      const retryAt = limited
        ? Math.max(
            Date.now() + 60_000,
            Number.isFinite(retrySeconds)
              ? Date.now() + retrySeconds * 1000
              : 0,
            Number.isFinite(resetSeconds) ? resetSeconds * 1000 : 0,
          )
        : null;
      let details = "";
      if (response.headers.get("content-type")?.includes("application/json")) {
        const body = await response.json<{ message?: unknown }>();
        details = rejectionReason(body.message);
      }
      const permissions = response.headers.get("x-accepted-github-permissions");
      if (permissions && /^[a-z_ =,;]+$/.test(permissions)) {
        details += ` Required permissions: ${permissions}.`;
      }
      throw new GitHubError(response.status, retryAt, path, reset, details);
    }
    return response.json<T>();
  }
  return github;
}

export function createPublicGitHubClient(request: typeof fetch = fetch) {
  return { github: createGitHubRequest(null, request) };
}

export function createGitHubClient(
  token: string,
  request: typeof fetch = fetch,
) {
  if (!token.trim()) {
    throw new Error("GH_TOKEN is required to collect GitHub activity.");
  }
  const github = createGitHubRequest(token, request);
  async function graphql<T>(query: string, variables: object): Promise<T> {
    const result = await github<{
      data?: T;
      errors?: readonly { message: string; type?: string }[];
    }>("/graphql", { query, variables });
    if (result.errors?.length) {
      if (result.errors.some((error) => error.type === "RATE_LIMITED")) {
        throw new GitHubError(429, Date.now() + 3_600_000, "/graphql", null);
      }
      const knownTypes = [
        "FORBIDDEN",
        "NOT_FOUND",
        "UNPROCESSABLE",
        "INTERNAL",
        "SERVICE_UNAVAILABLE",
      ];
      const details = result.errors
        .map((error) => {
          const type =
            error.type && knownTypes.includes(error.type)
              ? error.type
              : "UNKNOWN";
          return `${type}: ${rejectionReason(error.message)}`;
        })
        .join("; ");
      if (result.errors.some((error) => error.type === "FORBIDDEN")) {
        throw new GitHubError(403, null, "/graphql", null, details);
      }
      throw new Error(
        `GitHub GraphQL returned errors. Snapshot was not published. ${details}`,
      );
    }
    if (!result.data) {
      throw new Error(
        "GitHub GraphQL returned no data. Snapshot was not published.",
      );
    }
    return result.data;
  }
  return { github, graphql };
}

export function createOwnerGitHubClient(
  credentials: GitHubCredentials,
  owner: string,
  request: typeof fetch = fetch,
) {
  return createGitHubClient(
    ownerToken(credentials, owner) ?? credentials.GH_TOKEN ?? "",
    request,
  );
}

export function createOrganizationGitHubClient(
  credentials: GitHubCredentials,
  owner: string,
  request: typeof fetch = fetch,
): PublicGitHubClient {
  return {
    github: createGitHubRequest(
      ownerToken(credentials, owner) ?? null,
      request,
    ),
  };
}

function ownerToken(credentials: GitHubCredentials, owner: string) {
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner)) {
    throw new Error(
      "Configure a valid GitHub owner before selecting collection credentials.",
    );
  }
  const key: `GH_TOKEN_${string}` = `GH_TOKEN_${owner.toUpperCase().replaceAll("-", "_")}`;
  const token = credentials[key];
  if (token !== undefined && !token.trim()) {
    throw new Error(
      `${key} is empty; omit unused overrides or configure a valid token.`,
    );
  }
  return token;
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
export type PublicGitHubClient = ReturnType<typeof createPublicGitHubClient>;
