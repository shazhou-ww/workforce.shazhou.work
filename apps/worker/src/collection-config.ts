import {
  isGitHubLogin,
  isGitHubRepository,
  personalRepositoryLimit,
} from "@shazhou-work/workforce-contracts";

export interface CollectionConfig {
  readonly enabled: boolean;
  readonly accounts: readonly string[];
  readonly authorLogins: readonly string[];
  readonly authorEmails: readonly string[];
  readonly repositoryMode: "all_owned_public" | "explicit";
  readonly includeRepositories: readonly string[];
  readonly excludeRepositories: readonly string[];
}

export class CollectionInputError extends Error {}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseConfig(value: unknown): CollectionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollectionInputError(
      "Expected a collection configuration object.",
    );
  }
  const object: Record<string, unknown> = { ...value };
  const fields = [
    "enabled",
    "accounts",
    "authorLogins",
    "authorEmails",
    "repositoryMode",
    "includeRepositories",
    "excludeRepositories",
  ];
  if (Object.keys(object).some((key) => !fields.includes(key))) {
    throw new CollectionInputError("Unknown collection configuration field.");
  }
  function list(
    field: string,
    validate: (value: string) => boolean,
    limit = 100,
  ): string[] {
    const input = object[field];
    if (!Array.isArray(input) || input.length > limit) {
      throw new CollectionInputError(
        `${field} must be an array of at most ${limit} values.`,
      );
    }
    const result = new Set<string>();
    const entries: readonly unknown[] = input;
    for (const entry of entries) {
      if (
        typeof entry !== "string" ||
        entry.length > 320 ||
        !validate(entry.trim())
      ) {
        throw new CollectionInputError(`Invalid ${field} value.`);
      }
      result.add(entry.trim().toLowerCase());
    }
    return [...result].sort();
  }
  if (
    typeof object.enabled !== "boolean" ||
    (object.repositoryMode !== "all_owned_public" &&
      object.repositoryMode !== "explicit")
  ) {
    throw new CollectionInputError(
      "Configure enabled and a valid repositoryMode.",
    );
  }
  const config: CollectionConfig = {
    enabled: object.enabled,
    repositoryMode: object.repositoryMode,
    accounts: list("accounts", isGitHubLogin),
    authorLogins: list("authorLogins", isGitHubLogin),
    authorEmails: list("authorEmails", (email) => emailPattern.test(email)),
    includeRepositories: list(
      "includeRepositories",
      isGitHubRepository,
      personalRepositoryLimit,
    ),
    excludeRepositories: list(
      "excludeRepositories",
      isGitHubRepository,
      personalRepositoryLimit,
    ),
  };
  if (config.authorLogins.length + config.authorEmails.length === 0) {
    throw new CollectionInputError(
      "Configure at least one primary author login or email.",
    );
  }
  if (
    (config.repositoryMode === "all_owned_public" &&
      config.accounts.length === 0) ||
    (config.repositoryMode === "explicit" &&
      config.includeRepositories.length === 0)
  ) {
    throw new CollectionInputError(
      "Configure a nonempty repository collection scope.",
    );
  }
  return config;
}

export async function createEmailHasher(secret: string) {
  if (secret.length < 32) {
    throw new Error(
      "COLLECTION_EMAIL_KEY must contain at least 32 characters.",
    );
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return async (email: string): Promise<string> => {
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(email.trim().toLowerCase()),
    );
    return Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
}
