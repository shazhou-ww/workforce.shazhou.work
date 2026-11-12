import type {
  GitHubConnection,
  PlatformAccessResponse,
} from "@shazhou-work/workforce-contracts";
import { collectionAdminIds } from "./auth.js";
import type { Bindings } from "./env.js";
import { CollectionStore } from "./collection-store.js";

export const personalLimits = {
  repositories: 50,
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
    avatar_url: string;
    credential: string;
  }>(
    "SELECT github_id,login,avatar_url,credential FROM personal_github WHERE user_id=?",
    userId,
  );
  return row
    ? {
        id: row.github_id,
        login: row.login,
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
  const access = await platformAccess(env, { platformUserId: userId });
  if (access.status !== "active")
    throw new PersonalError(
      "access_stopped",
      "Personal access has been stopped. Previous results are retained.",
      403,
    );
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
  github: { id: string; login: string; avatarUrl: string },
  accessToken: string,
  scopes: string,
) {
  await database(env)
    .statement(
      `INSERT INTO personal_github VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    login=excluded.login,avatar_url=excluded.avatar_url,credential=excluded.credential,scopes=excluded.scopes,updated_at=excluded.updated_at
    WHERE personal_github.github_id=excluded.github_id`,
      userId,
      github.id,
      github.login,
      github.avatarUrl,
      await encryptCredential(env, userId, accessToken),
      scopes,
      new Date().toISOString(),
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
    avatar_url: string;
  }>();
  if (
    !Number.isSafeInteger(profile.id) ||
    profile.id <= 0 ||
    !/^[a-z\d-]+$/i.test(profile.login)
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
    avatarUrl: profile.avatar_url,
    verifiedEmails: rows
      .filter((row) => row.verified === true && typeof row.email === "string")
      .map((row) => row.email.trim().toLowerCase()),
    scopes: response.headers.get("x-oauth-scopes") ?? "",
  };
}
