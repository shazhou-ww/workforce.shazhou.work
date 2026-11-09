import type { CollectionParams } from "./collection.js";
import type { GitHubCredentials } from "./github-client.js";

export interface Bindings extends GitHubCredentials {
  readonly APP_NAME: string;
  readonly ASSETS: Fetcher;
  readonly STATS: KVNamespace;
  readonly DB?: D1Database;
  readonly COLLECTION?: Workflow<CollectionParams>;
  readonly COLLECTION_ENABLED?: string;
  readonly COLLECTION_ADMIN_TOKEN?: string;
  readonly COLLECTION_EMAIL_KEY?: string;
  readonly COLLECTION_ADMIN_GITHUB_IDS?: string;
  readonly AUTH_GITHUB_ID?: string;
  readonly AUTH_GITHUB_SECRET?: string;
  readonly AUTH_GOOGLE_ID?: string;
  readonly AUTH_GOOGLE_SECRET?: string;
  readonly AUTH_MICROSOFT_ENTRA_ID_ID?: string;
  readonly AUTH_MICROSOFT_ENTRA_ID_ISSUER?: string;
  readonly AUTH_MICROSOFT_ENTRA_ID_SECRET?: string;
  readonly AUTH_SECRET: string;
  readonly AUTH_URL?: string;
}
