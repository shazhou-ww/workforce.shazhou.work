export interface Bindings {
  readonly APP_NAME: string;
  readonly ASSETS: Fetcher;
  readonly STATS: KVNamespace;
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
