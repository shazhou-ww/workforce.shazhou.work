import type { ActivitySnapshot } from "./activity.js";
import type { CollectionProgressResponse } from "./index.js";

export const personalRepositoryLimit = 200;

export interface PersonalConfig {
  readonly enabled: boolean;
  readonly accounts: readonly string[];
  readonly authorLogins: readonly string[];
  readonly authorEmails: readonly string[];
  readonly repositoryMode: "all_owned_public" | "explicit";
  readonly includeRepositories: readonly string[];
  readonly excludeRepositories: readonly string[];
}

export interface GitHubConnection {
  readonly id: string;
  readonly login: string;
  readonly avatarUrl: string;
  readonly connected: boolean;
}

export interface GitHubConnectResponse {
  readonly url: string;
}

export interface PlatformAccessResponse {
  readonly signedIn: boolean;
  readonly status:
    | "signed_out"
    | "uninvited"
    | "verification_required"
    | "active"
    | "suspended";
  readonly isAdmin: boolean;
  readonly userId: string | null;
  readonly github: GitHubConnection | null;
  readonly limits: {
    readonly repositories: number;
    readonly refreshCooldownSeconds: number;
    readonly historyCommits: number;
  };
}

export interface PersonalConfigResponse {
  readonly config: PersonalConfig | null;
  readonly revisionId: string | null;
  readonly github: GitHubConnection | null;
}

export interface PersonalActivityResponse {
  readonly snapshot: ActivitySnapshot | null;
  readonly revisionId: string | null;
  readonly currentRevisionId: string | null;
  readonly stale: boolean;
}

export interface PersonalProfileResponse {
  readonly publicPath: string | null;
}

export interface PublicProfileResponse {
  readonly login: string;
  readonly snapshot: ActivitySnapshot | null;
}

export interface PersonalCollectionResponse {
  readonly activeRunId: string | null;
  readonly latestRun:
    | (CollectionProgressResponse & {
        readonly error: string | null;
        readonly revisionId: string;
      })
    | null;
  readonly nextRefreshAt: string | null;
}

export interface GitHubOrganization {
  readonly id: number;
  readonly login: string;
  readonly avatarUrl: string;
}

export interface PublicRepository {
  readonly id: number;
  readonly fullName: string;
  readonly url: string;
}

export interface GitHubDiscoveryResponse {
  readonly github: GitHubConnection | null;
  readonly organizations: readonly GitHubOrganization[];
  readonly repositories: readonly PublicRepository[];
  readonly organizationAccessUrl?: string;
}

export interface InvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly status: "pending" | "revoked" | "active" | "suspended";
  readonly userId: string | null;
  readonly createdAt: string;
}

export interface InvitationsResponse {
  readonly invitations: readonly InvitationRecord[];
}
export interface PersonalApiError {
  readonly error: string;
  readonly code: string;
  readonly field?: string;
  readonly retryAt?: string;
}
