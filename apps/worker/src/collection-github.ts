import type { RepositoryActivity } from "@shazhou-work/workforce-contracts";
import {
  GitHubError,
  type GitHubClient,
  type PublicGitHubClient,
} from "./github-client.js";

export interface GitHubAccount {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

export interface GitHubRepository {
  readonly id: number;
  readonly full_name: string;
  readonly private: boolean;
  readonly owner: GitHubAccount;
}

export type RepositoryMetadata = Pick<
  RepositoryActivity,
  | "name"
  | "url"
  | "description"
  | "fork"
  | "archived"
  | "defaultBranch"
  | "latestCommit"
> & { readonly head: string | null };

export interface RawCommit {
  readonly oid: string;
  readonly committedDate: string;
  readonly additions: number;
  readonly deletions: number;
  readonly author: {
    readonly email: string;
    readonly user: { readonly login: string } | null;
  } | null;
}

export interface HistoryPage {
  readonly nodes: readonly RawCommit[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface Comparison {
  readonly status: "ahead" | "identical" | "behind" | "diverged";
  readonly ahead_by: number;
  readonly total_commits: number;
  readonly commits: readonly { readonly sha: string }[];
}

const commitFields =
  "oid committedDate additions deletions author { email user { login } }";

function parts(fullName: string) {
  const [owner, name] = fullName.split("/");
  return { owner, name };
}

export async function readAccount(
  client: PublicGitHubClient,
  login: string,
): Promise<GitHubAccount> {
  const owner = await client.github<GitHubAccount | null>(`/users/${login}`);
  if (
    !owner ||
    typeof owner.id !== "number" ||
    !Number.isSafeInteger(owner.id) ||
    owner.id <= 0 ||
    (owner.type !== "User" && owner.type !== "Organization")
  ) {
    throw new Error(
      "GitHub account is unavailable or has an invalid public identity.",
    );
  }
  return { id: owner.id, login: owner.login, type: owner.type };
}

export async function readMetadata(
  client: GitHubClient,
  repository: { readonly repository_id: number; readonly full_name: string },
): Promise<RepositoryMetadata> {
  const result = await client.graphql<{
    repository: {
      databaseId: number;
      isPrivate: boolean;
      nameWithOwner: string;
      url: string;
      description: string | null;
      isFork: boolean;
      isArchived: boolean;
      defaultBranchRef: {
        name: string;
        target: {
          oid: string;
          committedDate: string;
          messageHeadline: string;
          url: string;
        };
      } | null;
    } | null;
  }>(
    `query Metadata($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        databaseId isPrivate nameWithOwner url description isFork isArchived
        defaultBranchRef { name target { ... on Commit { oid committedDate messageHeadline url } } }
      }
    }`,
    parts(repository.full_name),
  );
  const repo = result.repository;
  if (!repo || repo.isPrivate || repo.databaseId !== repository.repository_id) {
    throw new Error(
      "Repository is unavailable, replaced, or no longer public.",
    );
  }
  const target = repo.defaultBranchRef?.target;
  return {
    name: repo.nameWithOwner,
    url: repo.url,
    description: repo.description,
    fork: repo.isFork,
    archived: repo.isArchived,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    head: target?.oid ?? null,
    latestCommit: target
      ? {
          committedAt: target.committedDate,
          message: target.messageHeadline,
          url: target.url,
        }
      : null,
  };
}

export async function readHistory(
  client: GitHubClient,
  fullName: string,
  head: string,
  cursor: string | null,
): Promise<HistoryPage> {
  const result = await client.graphql<{
    repository: {
      isPrivate: boolean;
      object: { history: HistoryPage } | null;
    } | null;
  }>(
    `query FullHistory($owner: String!, $name: String!, $head: GitObjectID!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        isPrivate object(oid: $head) { ... on Commit {
          history(first: 100, after: $cursor) {
            nodes { ${commitFields} } pageInfo { hasNextPage endCursor }
          }
        } }
      }
    }`,
    { ...parts(fullName), head, cursor },
  );
  if (
    !result.repository ||
    result.repository.isPrivate ||
    !result.repository.object
  ) {
    throw new Error("Pinned history is unavailable or no longer public.");
  }
  const history = result.repository.object.history;
  if (
    history.pageInfo.hasNextPage &&
    (!history.pageInfo.endCursor || history.pageInfo.endCursor === cursor)
  ) {
    throw new Error("GitHub returned an invalid history pagination cursor.");
  }
  return history;
}

export async function readComparison(
  client: GitHubClient,
  fullName: string,
  base: string,
  head: string,
  page: number,
): Promise<Comparison | null> {
  try {
    const result = await client.github<Comparison>(
      `/repos/${fullName}/compare/${base}...${head}?per_page=100&page=${page}`,
    );
    if (
      !["ahead", "identical", "behind", "diverged"].includes(result.status) ||
      !Number.isSafeInteger(result.total_commits) ||
      result.total_commits < 0 ||
      result.total_commits !== result.ahead_by
    ) {
      throw new Error("GitHub returned an incomplete or invalid comparison.");
    }
    return result;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      console.warn(
        "Previous head cannot be compared; rebuilding repository history.",
      );
      return null;
    }
    throw error;
  }
}

export async function readCommitDetails(
  client: GitHubClient,
  fullName: string,
  shas: readonly string[],
): Promise<RawCommit[]> {
  if (shas.length === 0) return [];
  if (shas.length > 100 || shas.some((sha) => !/^[a-f\d]{40}$/i.test(sha))) {
    throw new Error("GitHub returned invalid comparison commit IDs.");
  }
  const result = await client.graphql<{
    repository:
      | ({ isPrivate: boolean } & Record<string, RawCommit | boolean | null>)
      | null;
  }>(
    `query CommitDetails($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        isPrivate
        ${shas.map((sha, index) => `c${index}: object(oid: "${sha}") { ... on Commit { ${commitFields} } }`).join("\n")}
      }
    }`,
    parts(fullName),
  );
  const repo = result.repository;
  if (!repo || repo.isPrivate) {
    throw new Error("Commit details are unavailable or no longer public.");
  }
  return shas.map((sha, index) => {
    const commit = repo[`c${index}`];
    if (!commit || typeof commit === "boolean" || commit.oid !== sha) {
      throw new Error("GitHub returned incomplete commit details.");
    }
    return commit;
  });
}
