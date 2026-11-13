import type { AuthConfig, AuthUser } from "@hono/auth-js";
import type { Provider } from "@auth/core/providers";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import MicrosoftEntraID from "@auth/core/providers/microsoft-entra-id";
import { getToken } from "@auth/core/jwt";
import {
  getAuthProviderLabel,
  type AuthProviderDescriptor,
} from "@shazhou-work/workforce-contracts";

import type { Bindings } from "./env.js";
import {
  assertPersonalActive,
  database,
  githubIdentity,
  registerIdentity,
  retainGitHub,
  PersonalError,
  platformAccess,
} from "./platform.js";

export const githubOAuthScope = "read:user user:email read:org";

export function linkCookieName(request: Request) {
  return new URL(request.url).protocol === "https:"
    ? "__Host-workforce-link"
    : "workforce-link";
}

export function linkIntentId(request?: Request): string | null {
  if (!request) return null;
  const name = linkCookieName(request);
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}

export async function requestToken(request: Request, env: Bindings) {
  return getToken({
    req: request,
    secret: env.AUTH_SECRET,
    secureCookie: new URL(request.url).protocol === "https:",
  });
}

export function createAuthConfig(env: Bindings, request?: Request): AuthConfig {
  return {
    providers: createAuthProviders(env),
    secret: env.AUTH_SECRET,
    basePath: "/api/auth",
    trustHost: true,
    logger: {
      error() {
        console.error(
          "Authentication failed; sensitive OAuth details omitted.",
        );
      },
      warn(code) {
        console.warn("Authentication warning:", code);
      },
      debug() {},
    },
    pages: {
      signIn: "/signin",
      signOut: "/signout",
      error: "/signin",
    },
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account) {
          token.githubAccountId =
            account.provider === "github" ? account.providerAccountId : null;
          token.provider = account.provider;
          token.providerAccountId = account.providerAccountId;
          token.platformSessionId = crypto.randomUUID();
          token.platformUserId = null;
          token.verifiedEmail = false;
          if (!env.DB) return token;
          const github =
            account.provider === "github" && account.access_token
              ? await githubIdentity(account.access_token)
              : null;
          if (github && github.id !== account.providerAccountId)
            throw new PersonalError(
              "identity_mismatch",
              "GitHub identity did not match OAuth.",
              403,
            );
          const emails =
            github?.verifiedEmails ??
            (account.provider === "google" &&
            profile?.email_verified === true &&
            typeof profile.email === "string"
              ? [profile.email]
              : []);
          token.verifiedEmail = emails.length > 0;
          const intentId = linkIntentId(request);
          let userId: string | null;
          if (intentId && account.provider === "github" && request && github) {
            const previous = await requestToken(request, env);
            if (
              typeof previous?.platformUserId !== "string" ||
              typeof previous.platformSessionId !== "string"
            )
              throw new PersonalError(
                "link_expired",
                "Sign in again before linking GitHub.",
                403,
              );
            userId = previous.platformUserId;
            await assertPersonalActive(env, userId);
            const store = database(env);
            const conflicting = await store.one<{ user_id: string }>(
              "SELECT user_id FROM personal_identities WHERE provider='github' AND provider_id=?",
              github.id,
            );
            const owned = await store.one<{ provider_id: string }>(
              "SELECT provider_id FROM personal_identities WHERE provider='github' AND user_id=?",
              userId,
            );
            if (
              (conflicting && conflicting.user_id !== userId) ||
              (owned && owned.provider_id !== github.id)
            )
              throw new PersonalError(
                "identity_conflict",
                "This GitHub identity is already linked or differs from your primary account.",
                409,
              );
            const consumed = await store.one<{ id: string }>(
              "UPDATE github_link_intents SET consumed_at=? WHERE id=? AND user_id=? AND session_binding=? AND consumed_at IS NULL AND expires_at>? RETURNING id",
              new Date().toISOString(),
              intentId,
              userId,
              previous.platformSessionId,
              new Date().toISOString(),
            );
            if (!consumed)
              throw new PersonalError(
                "link_expired",
                "The GitHub connection request expired or was already used.",
                403,
              );
            await store
              .statement(
                "INSERT OR IGNORE INTO personal_identities VALUES ('github',?,?)",
                github.id,
                userId,
              )
              .run();
            const linked = await store.one<{ provider_id: string }>(
              "SELECT provider_id FROM personal_identities WHERE provider='github' AND user_id=?",
              userId,
            );
            if (linked?.provider_id !== github.id)
              throw new PersonalError(
                "identity_conflict",
                "This primary GitHub account cannot be replaced.",
                409,
              );
          } else {
            userId = await registerIdentity(
              env,
              account.provider,
              account.providerAccountId,
              emails,
            );
          }
          token.platformUserId = userId;
          if (
            github &&
            userId &&
            account.access_token &&
            (await platformAccess(env, { platformUserId: userId })).status ===
              "active"
          )
            await retainGitHub(
              env,
              userId,
              github,
              account.access_token,
              github.scopes || account.scope || "",
              fetch,
              {
                refreshToken: account.refresh_token,
                expiresAt: account.expires_at,
                refreshExpiresAt:
                  typeof account.refresh_token_expires_in === "number"
                    ? Math.floor(Date.now() / 1000) +
                      account.refresh_token_expires_in
                    : undefined,
              },
            );
        }
        return token;
      },
    },
  };
}

export function collectionAdminIds(env: Bindings): readonly string[] {
  const ids = (env.COLLECTION_ADMIN_GITHUB_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error(
      "COLLECTION_ADMIN_GITHUB_IDS must contain comma-separated numeric GitHub user IDs.",
    );
  }
  return ids;
}

export function canCollectActivity(
  user: AuthUser | null,
  env: Bindings,
): boolean {
  const id = user?.token?.githubAccountId;
  return typeof id === "string" && collectionAdminIds(env).includes(id);
}

export function getConfiguredProviders(
  env: Bindings,
): readonly AuthProviderDescriptor[] {
  const providers: AuthProviderDescriptor[] = [];

  if (getCredentials(env.AUTH_GITHUB_ID, env.AUTH_GITHUB_SECRET)) {
    providers.push({
      id: "github",
      label: getAuthProviderLabel("github"),
    });
  }

  if (getCredentials(env.AUTH_GOOGLE_ID, env.AUTH_GOOGLE_SECRET)) {
    providers.push({
      id: "google",
      label: getAuthProviderLabel("google"),
    });
  }

  if (
    getCredentials(
      env.AUTH_MICROSOFT_ENTRA_ID_ID,
      env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    )
  ) {
    providers.push({
      id: "microsoft-entra-id",
      label: getAuthProviderLabel("microsoft-entra-id"),
    });
  }

  return providers;
}

function createAuthProviders(env: Bindings): Provider[] {
  const providers: Provider[] = [];
  const github = getCredentials(env.AUTH_GITHUB_ID, env.AUTH_GITHUB_SECRET);
  const google = getCredentials(env.AUTH_GOOGLE_ID, env.AUTH_GOOGLE_SECRET);
  const microsoft = getCredentials(
    env.AUTH_MICROSOFT_ENTRA_ID_ID,
    env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
  );

  if (github) {
    providers.push(
      GitHub({
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        checks: ["state"],
        authorization: { params: { scope: githubOAuthScope } },
      }),
    );
  }

  if (google) {
    providers.push(
      Google({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
      }),
    );
  }

  if (microsoft) {
    providers.push(
      MicrosoftEntraID({
        clientId: microsoft.clientId,
        clientSecret: microsoft.clientSecret,
        ...(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER
          ? { issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER }
          : {}),
      }),
    );
  }

  return providers;
}

function getCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
): { readonly clientId: string; readonly clientSecret: string } | null {
  if (!clientId?.trim() || !clientSecret?.trim()) {
    return null;
  }

  return { clientId, clientSecret };
}
