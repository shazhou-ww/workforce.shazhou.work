export * from "./activity.js";
export * from "./personal.js";

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
  readonly latestRunId?: string | null;
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
  readonly performance?: CollectionPerformance | null;
}

export const collectionPhases = [
  "discovery",
  "metadata",
  "planning",
  "history",
  "aggregation",
  "publication",
] as const;
export type CollectionPhase = (typeof collectionPhases)[number];

export interface CollectionPerformance {
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly activeMs: number;
  readonly restRequests: number;
  readonly graphqlRequests: number;
  readonly httpErrors: number;
  readonly networkErrors: number;
  readonly stepRetries: number;
  readonly rateLimitWaits: number;
  readonly rateLimitWaitMs: number;
  readonly phases: readonly {
    readonly phase: CollectionPhase;
    readonly attempts: number;
    readonly activeMs: number;
  }[];
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
