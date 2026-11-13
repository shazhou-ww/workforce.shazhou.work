import type {
  GitHubConnection,
  PlatformAccessResponse,
} from "@shazhou-work/workforce-contracts";
import {
  isGitHubLogin,
  personalRepositoryLimit,
} from "@shazhou-work/workforce-contracts";
import { collectionAdminIds } from "./auth.js";
import type { Bindings } from "./env.js";
import { CollectionStore } from "./collection-store.js";
import { setTimeout as delay } from "node:timers/promises";

export const personalLimits = {
  repositories: personalRepositoryLimit,
  refreshCooldownSeconds: 900,
  historyCommits: 50_000,
} as const;

export class PersonalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

export function database(env: Bindings) {
  if (!env.DB)
    throw new PersonalError(
      "unavailable",
      "Personal storage is not configured.",
      503,
    );
  return new CollectionStore(env.DB);
}

export async function encryptCredential(
  env: Bindings,
  userId: string,
  token: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await credentialKey(env.AUTH_SECRET);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    key,
    new TextEncoder().encode(token),
  );
  return `${hex(iv)}.${hex(new Uint8Array(ciphertext))}`;
}

export async function decryptCredential(
  env: Bindings,
  userId: string,
  value: string,
): Promise<string> {
  const [iv, ciphertext] = value.split(".");
  if (!iv || !ciphertext)
    throw new PersonalError(
      "github_connection_required",
      "Reconnect GitHub.",
      409,
    );
  try {
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unhex(iv),
        additionalData: new TextEncoder().encode(userId),
      },
      await credentialKey(env.AUTH_SECRET),
      unhex(ciphertext),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    throw new PersonalError(
      "github_connection_required",
      "Reconnect GitHub; its stored credential is unavailable.",
      409,
    );
  }
}

interface GitHubCredentialRow {
  credential: string;
  refresh_credential: string | null;
  expires_at: number | null;
  refresh_expires_at: number | null;
  credential_generation: string;
  refresh_lock: string | null;
  refresh_lock_until: number | null;
}

export interface GitHubTokenMetadata {
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  refreshExpiresAt?: number | undefined;
}

function reconnectGitHub() {
  return new PersonalError(
    "github_connection_required",
    "GitHub authorization expired or was revoked. Reconnect GitHub in settings.",
    409,
  );
}

export async function githubCredentialGeneration(
  env: Bindings,
  userId: string,
) {
  const row = await database(env).one<{ credential_generation: string }>(
    "SELECT credential_generation FROM personal_github WHERE user_id=?",
    userId,
  );
  if (!row) throw reconnectGitHub();
  return row.credential_generation;
}

export async function githubCredential(
  env: Bindings,
  userId: string,
  request: typeof fetch = fetch,
  generation?: string,
) {
  const store = database(env);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = await store.one<GitHubCredentialRow>(
      `SELECT credential,refresh_credential,expires_at,refresh_expires_at,
        credential_generation,refresh_lock,refresh_lock_until FROM personal_github WHERE user_id=?`,
      userId,
    );
    if (!row?.credential) throw reconnectGitHub();
    if (generation !== undefined && row.credential_generation !== generation)
      throw new PersonalError(
        "github_connection_required",
        "Collection credential changed. Retry with the current GitHub connection.",
        409,
      );
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at === null || row.expires_at > now + 300)
      return decryptCredential(env, userId, row.credential);
    if (
      !row.refresh_credential ||
      (row.refresh_expires_at !== null && row.refresh_expires_at <= now)
    )
      throw reconnectGitHub();
    if (!env.AUTH_GITHUB_ID || !env.AUTH_GITHUB_SECRET)
      throw new PersonalError(
        "unavailable",
        "GitHub OAuth refresh is not configured.",
        503,
      );
    const lock = crypto.randomUUID();
    const claimed = await store.one<{ user_id: string }>(
      `UPDATE personal_github SET refresh_lock=?,refresh_lock_until=?
       WHERE user_id=? AND credential=? AND credential_generation=?
         AND (refresh_lock IS NULL OR refresh_lock_until<=?)
       RETURNING user_id`,
      lock,
      now + 60,
      userId,
      row.credential,
      row.credential_generation,
      now,
    );
    if (!claimed) {
      await delay(100);
      continue;
    }
    try {
      const refreshToken = await decryptCredential(
        env,
        userId,
        row.refresh_credential,
      );
      let response: Response;
      try {
        response = await request(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: env.AUTH_GITHUB_ID,
              client_secret: env.AUTH_GITHUB_SECRET,
              grant_type: "refresh_token",
              refresh_token: refreshToken,
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch {
        throw new PersonalError(
          "github_refresh_unavailable",
          "GitHub token renewal could not be completed. Retry shortly; reconnect GitHub if it continues to fail.",
          503,
        );
      }
      if (!response.ok && response.status !== 400 && response.status !== 401)
        throw new PersonalError(
          "github_refresh_unavailable",
          "GitHub token renewal is unavailable. Retry shortly.",
          503,
        );
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new PersonalError(
          "github_refresh_unavailable",
          "GitHub returned an invalid token renewal response.",
          502,
        );
      }
      if (!result || typeof result !== "object") throw reconnectGitHub();
      if ("error" in result) {
        if (
          result.error === "bad_refresh_token" ||
          result.error === "invalid_grant" ||
          result.error === "expired_token"
        )
          throw reconnectGitHub();
        throw new PersonalError(
          "github_refresh_unavailable",
          "GitHub rejected token renewal. Check OAuth configuration or reconnect GitHub.",
          502,
        );
      }
      if (!response.ok)
        throw new PersonalError(
          "github_refresh_unavailable",
          "GitHub rejected token renewal. Check OAuth configuration or reconnect GitHub.",
          502,
        );
      if (
        !("access_token" in result) ||
        typeof result.access_token !== "string" ||
        !result.access_token.trim() ||
        !("refresh_token" in result) ||
        typeof result.refresh_token !== "string" ||
        !result.refresh_token.trim() ||
        !("expires_in" in result) ||
        typeof result.expires_in !== "number" ||
        !Number.isSafeInteger(result.expires_in) ||
        result.expires_in <= 0 ||
        !("refresh_token_expires_in" in result) ||
        typeof result.refresh_token_expires_in !== "number" ||
        !Number.isSafeInteger(result.refresh_token_expires_in) ||
        result.refresh_token_expires_in <= 0
      )
        throw new PersonalError(
          "github_refresh_unavailable",
          "GitHub returned incomplete token renewal credentials. Reconnect GitHub.",
          502,
        );
      const issuedAt = Math.floor(Date.now() / 1000);
      const saved = await store.one<{ user_id: string }>(
        `UPDATE personal_github SET credential=?,refresh_credential=?,expires_at=?,refresh_expires_at=?,
          refresh_lock=NULL,refresh_lock_until=NULL
         WHERE user_id=? AND credential=? AND credential_generation=? AND refresh_lock=?
         RETURNING user_id`,
        await encryptCredential(env, userId, result.access_token),
        await encryptCredential(env, userId, result.refresh_token),
        issuedAt + result.expires_in,
        issuedAt + result.refresh_token_expires_in,
        userId,
        row.credential,
        row.credential_generation,
        lock,
      );
      if (!saved) throw reconnectGitHub();
      return result.access_token;
    } finally {
      await store
        .statement(
          "UPDATE personal_github SET refresh_lock=NULL,refresh_lock_until=NULL WHERE user_id=? AND refresh_lock=?",
          userId,
          lock,
        )
        .run();
    }
  }
  throw new PersonalError(
    "github_refresh_unavailable",
    "GitHub token renewal is already in progress. Retry shortly.",
    503,
  );
}

async function credentialKey(secret: string) {
  if (secret.length < 32)
    throw new PersonalError(
      "unavailable",
      "AUTH_SECRET must contain at least 32 characters.",
      503,
    );
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("workforce:personal:v1"),
      info: new TextEncoder().encode("github-credential:AES-GCM"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
function unhex(value: string) {
  if (!/^(?:[a-f\d]{2})+$/i.test(value))
    throw new Error("Invalid encrypted credential.");
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    parseInt(byte, 16),
  );
}

export interface PlatformToken {
  [key: string]: unknown;
  platformUserId?: unknown;
  verifiedEmail?: unknown;
  provider?: unknown;
  providerAccountId?: unknown;
}

export async function githubConnection(
  env: Bindings,
  userId: string,
): Promise<GitHubConnection | null> {
  const row = await database(env).one<{
    github_id: string;
    login: string;
    name: string | null;
    avatar_url: string;
    credential: string;
  }>(
    "SELECT github_id,login,name,avatar_url,credential FROM personal_github WHERE user_id=?",
    userId,
  );
  return row
    ? {
        id: row.github_id,
        login: row.login,
        name: row.name,
        avatarUrl: row.avatar_url,
        connected: !!row.credential,
      }
    : null;
}

export async function platformAccess(
  env: Bindings,
  token: PlatformToken | null,
): Promise<PlatformAccessResponse> {
  const userId =
    typeof token?.platformUserId === "string" ? token.platformUserId : null;
  const base = {
    signedIn: token !== null,
    userId: null,
    isAdmin: false,
    github: null,
    limits: personalLimits,
  } as const;
  if (!token) return { ...base, status: "signed_out" };
  if (!userId)
    return {
      ...base,
      status:
        token.verifiedEmail === true ? "uninvited" : "verification_required",
    };
  const store = database(env);
  const user = await store.one<{ status: "active" | "suspended" }>(
    "SELECT status FROM personal_users WHERE id=?",
    userId,
  );
  if (!user) return { ...base, status: "uninvited" };
  const identity = await store.one<{ provider_id: string }>(
    "SELECT provider_id FROM personal_identities WHERE user_id=? AND provider='github'",
    userId,
  );
  const isAdmin =
    !!identity && collectionAdminIds(env).includes(identity.provider_id);
  return {
    ...base,
    userId,
    isAdmin,
    github: await githubConnection(env, userId),
    status: isAdmin ? "active" : user.status,
  };
}

export async function assertPersonalActive(
  env: Bindings,
  userId: string,
): Promise<void> {
  const access = await database(env).one<{
    status: string;
    provider_id: string | null;
  }>(
    `SELECT u.status,i.provider_id FROM personal_users u
     LEFT JOIN personal_identities i ON i.user_id=u.id AND i.provider='github'
     WHERE u.id=?`,
    userId,
  );
  if (
    !access ||
    (access.status !== "active" &&
      !collectionAdminIds(env).includes(access.provider_id ?? ""))
  )
    throw new PersonalError(
      "access_stopped",
      "Personal access has been stopped. Previous results are retained.",
      403,
    );
}

export async function assertPersonalCollectionActive(
  env: Bindings,
  userId: string,
  runId: string,
  claiming: boolean,
): Promise<void> {
  // A fresh first-primary session observes revocation outside this Workflow's session.
  const access = await database(env).one<{
    status: string;
    provider_id: string | null;
    run_status: string | null;
    config_id: string | null;
    active_run_id: string | null;
  }>(
    `SELECT u.status,i.provider_id,r.status AS run_status,c.config_id,s.active_run_id
     FROM personal_users u
     LEFT JOIN personal_identities i ON i.user_id=u.id AND i.provider='github'
     LEFT JOIN collection_runs r ON r.id=?
     LEFT JOIN config_revisions c ON c.id=r.revision_id
     LEFT JOIN personal_state s ON s.id=u.id WHERE u.id=?`,
    runId,
    userId,
  );
  if (
    !access ||
    (access.status !== "active" &&
      !collectionAdminIds(env).includes(access.provider_id ?? ""))
  )
    throw new PersonalError(
      "access_stopped",
      "Personal access has been stopped. Previous results are retained.",
      403,
    );
  if (access.run_status === "cancelled")
    throw new Error("This personal run was cancelled.");
  if (
    (access.run_status === null && !claiming) ||
    (access.run_status !== null && access.config_id !== userId) ||
    (["collecting", "ready"].includes(access.run_status ?? "") &&
      access.active_run_id !== runId)
  )
    throw new Error("Collection no longer owns its publication lock.");
}

export async function registerIdentity(
  env: Bindings,
  provider: string,
  providerId: string,
  verifiedEmails: readonly string[],
): Promise<string | null> {
  if (!env.DB) return null;
  const store = database(env);
  const existing = await store.one<{ user_id: string }>(
    "SELECT user_id FROM personal_identities WHERE provider=? AND provider_id=?",
    provider,
    providerId,
  );
  if (existing) return existing.user_id;
  const admin =
    provider === "github" && collectionAdminIds(env).includes(providerId);
  const invitation = admin
    ? null
    : await store.one<{ id: string }>(
        "SELECT id FROM invitations WHERE status='pending' AND email IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 1",
        JSON.stringify(
          verifiedEmails.map((email) => email.trim().toLowerCase()),
        ),
      );
  if (!admin && !invitation) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await store.batch([
    store.statement(
      "INSERT INTO personal_users(id,status,created_at) SELECT ?,'active',? WHERE (?=1 OR EXISTS(SELECT 1 FROM invitations WHERE id=? AND status='pending')) AND NOT EXISTS(SELECT 1 FROM personal_identities WHERE provider=? AND provider_id=?)",
      id,
      now,
      Number(admin),
      invitation?.id ?? null,
      provider,
      providerId,
    ),
    store.statement(
      "INSERT INTO personal_identities SELECT ?,?,id FROM personal_users WHERE id=?",
      provider,
      providerId,
      id,
    ),
    store.statement(
      "UPDATE invitations SET status='claimed',user_id=?,updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM personal_users WHERE id=?)",
      id,
      now,
      invitation?.id ?? null,
      id,
    ),
    store.statement(
      "INSERT OR IGNORE INTO collection_configs(id) SELECT id FROM personal_users WHERE id=?",
      id,
    ),
    store.statement(
      "INSERT OR IGNORE INTO personal_state(id) SELECT id FROM personal_users WHERE id=?",
      id,
    ),
  ]);
  return (
    (
      await store.one<{ user_id: string }>(
        "SELECT user_id FROM personal_identities WHERE provider=? AND provider_id=?",
        provider,
        providerId,
      )
    )?.user_id ?? null
  );
}

export async function retainGitHub(
  env: Bindings,
  userId: string,
  github: {
    id: string;
    login: string;
    name?: string | null;
    avatarUrl: string;
  },
  accessToken: string,
  scopes: string,
  request: typeof fetch = fetch,
  tokens: GitHubTokenMetadata = {},
) {
  const store = database(env);
  let retained: GitHubCredentialRow | null = null;
  if (!scopes.split(/[, ]+/).includes("read:org")) {
    const previous = await store.one<
      GitHubCredentialRow & { github_id: string }
    >("SELECT * FROM personal_github WHERE user_id=?", userId);
    if (previous?.github_id === github.id && previous.credential) {
      try {
        const token = await decryptCredential(env, userId, previous.credential);
        const response = await request("https://api.github.com/user", {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "user-agent": "workforce-identity",
          },
          signal: AbortSignal.timeout(15_000),
        });
        const verifiedScopes = response.headers.get("x-oauth-scopes") ?? "";
        const profile = response.ok
          ? await response.json<{ id: number }>()
          : null;
        if (
          profile &&
          String(profile.id) === github.id &&
          verifiedScopes.split(/[, ]+/).includes("read:org")
        ) {
          retained = previous;
          scopes = verifiedScopes;
        } else {
          console.warn(
            "Existing GitHub organization credential could not be verified; organization reauthorization is required.",
          );
        }
        if (retained) {
          const saved = await store.one<{ user_id: string }>(
            `UPDATE personal_github SET login=?,name=?,avatar_url=?,scopes=?
             WHERE user_id=? AND github_id=? AND credential_generation=? RETURNING user_id`,
            github.login,
            github.name ?? null,
            github.avatarUrl,
            scopes,
            userId,
            github.id,
            retained.credential_generation,
          );
          if (!saved) throw reconnectGitHub();
          return;
        }
      } catch {
        console.warn(
          "Existing GitHub organization credential validation failed; organization reauthorization is required.",
        );
      }
    }
  }
  await store
    .statement(
      `INSERT INTO personal_github (user_id,github_id,login,avatar_url,credential,scopes,updated_at,name,
        refresh_credential,expires_at,refresh_expires_at,credential_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    login=excluded.login,name=excluded.name,avatar_url=excluded.avatar_url,credential=excluded.credential,scopes=excluded.scopes,updated_at=excluded.updated_at,
    refresh_credential=excluded.refresh_credential,expires_at=excluded.expires_at,refresh_expires_at=excluded.refresh_expires_at,
    credential_generation=excluded.credential_generation,refresh_lock=NULL,refresh_lock_until=NULL
    WHERE personal_github.github_id=excluded.github_id`,
      userId,
      github.id,
      github.login,
      github.avatarUrl,
      await encryptCredential(env, userId, accessToken),
      scopes,
      new Date().toISOString(),
      github.name ?? null,
      tokens.refreshToken
        ? await encryptCredential(env, userId, tokens.refreshToken)
        : null,
      tokens.expiresAt ?? null,
      tokens.refreshExpiresAt ?? null,
      crypto.randomUUID(),
    )
    .run();
}

export async function githubIdentity(
  accessToken: string,
  request: typeof fetch = fetch,
) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "workforce-identity",
  };
  const response = await request("https://api.github.com/user", {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new PersonalError(
      "github_identity_failed",
      "GitHub identity could not be verified.",
      403,
    );
  const profile = await response.json<{
    id: number;
    login: string;
    name?: string | null;
    avatar_url: string;
  }>();
  if (
    !Number.isSafeInteger(profile.id) ||
    profile.id <= 0 ||
    !isGitHubLogin(profile.login)
  )
    throw new PersonalError(
      "github_identity_failed",
      "GitHub returned an invalid identity.",
      403,
    );
  const emails = await request("https://api.github.com/user/emails", {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!emails.ok)
    throw new PersonalError(
      "verified_email_required",
      "GitHub verified email permission is required. Sign in again.",
      403,
    );
  const rows = await emails.json<{ email: string; verified: boolean }[]>();
  return {
    id: String(profile.id),
    login: profile.login,
    name: profile.name?.trim() || null,
    avatarUrl: profile.avatar_url,
    verifiedEmails: rows
      .filter((row) => row.verified === true && typeof row.email === "string")
      .map((row) => row.email.trim().toLowerCase()),
    scopes: response.headers.get("x-oauth-scopes") ?? "",
  };
}
