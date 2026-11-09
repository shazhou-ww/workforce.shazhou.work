export * from "./activity.js";

export const authProviderIds = [
  "github",
  "google",
  "microsoft-entra-id",
] as const;

export type AuthProviderId = (typeof authProviderIds)[number];

export interface AuthProviderDescriptor {
  readonly id: AuthProviderId;
  readonly label: string;
}

export interface BootstrapResponse {
  readonly appName: string;
  readonly providers: readonly AuthProviderDescriptor[];
}

export interface HealthResponse {
  readonly service: string;
  readonly status: "ok";
}

export interface SessionUser {
  readonly email?: string | null;
  readonly image?: string | null;
  readonly name?: string | null;
}

export interface SessionResponse {
  readonly expires?: string;
  readonly user?: SessionUser;
  readonly canCollect?: boolean;
}

export interface CollectionAccessResponse {
  readonly loginEnabled: boolean;
  readonly signedIn: boolean;
  readonly canCollect: boolean;
  readonly displayName: string | null;
  readonly activeRunId: string | null;
}

export interface CollectionTriggerResponse {
  readonly runId: string;
}

export interface CollectionProgressResponse {
  readonly runId: string;
  readonly status:
    | "queued"
    | "collecting"
    | "ready"
    | "published"
    | "failed"
    | "blocked"
    | "cancelled";
  readonly waiting: boolean;
  readonly completedRepositories: number;
  readonly totalRepositories: number;
  readonly until: string;
}

export function getAuthProviderLabel(id: AuthProviderId): string {
  switch (id) {
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    case "microsoft-entra-id":
      return "Microsoft";
  }
}
