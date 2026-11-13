import type { ActivitySnapshot } from "./activity.js";

export interface PrivateRepositorySelection {
  readonly id: number;
  readonly name: string;
}

export interface PrivateActivityResponse {
  readonly connected: boolean;
  readonly repositories: readonly PrivateRepositorySelection[];
  readonly snapshot:
    (ActivitySnapshot & { readonly visibility: "private" }) | null;
  readonly activeRunId: string | null;
  readonly nextRefreshAt: string | null;
  readonly error: string | null;
}
