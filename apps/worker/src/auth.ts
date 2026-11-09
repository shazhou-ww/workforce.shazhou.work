import type { AuthConfig, AuthUser } from "@hono/auth-js";
import type { Provider } from "@auth/core/providers";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import MicrosoftEntraID from "@auth/core/providers/microsoft-entra-id";
import {
  getAuthProviderLabel,
  type AuthProviderDescriptor,
} from "@workspace/contracts";

import type { Bindings } from "./env.js";

export function createAuthConfig(env: Bindings): AuthConfig {
  return {
    providers: createAuthProviders(env),
    secret: env.AUTH_SECRET,
    basePath: "/api/auth",
    trustHost: true,
    callbacks: {
      jwt({ token, account }) {
        if (account) {
          token.githubAccountId =
            account.provider === "github" ? account.providerAccountId : null;
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
