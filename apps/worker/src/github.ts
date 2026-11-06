import { setTimeout as delay } from "node:timers/promises";

import {
  activityTotals,
  activityWindow,
  combineDaily,
  dailyActivity,
  type ActivitySnapshot,
  type CommitActivity,
  type RepositoryActivity,
} from "@workspace/contracts";

interface PublicRepository {
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly private: boolean;
}

interface CommitHistory {
  readonly nodes: readonly {
    readonly oid: string;
    readonly committedDate: string;
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

interface HistoryPage {
  readonly repository: {
    readonly isPrivate: boolean;
    readonly nameWithOwner: string;
    readonly url: string;
    readonly description: string | null;
    readonly isFork: boolean;
    readonly isArchived: boolean;
    readonly defaultBranchRef: {
      readonly name: string;
      readonly target: {
        readonly oid: string;
        readonly committedDate: string;
        readonly messageHeadline: string;
        readonly url: string;
        readonly history: CommitHistory;
      };
    } | null;
  } | null;
}

const historySelection = `
  history(first: 100, since: $since, until: $until, after: $cursor) {
    nodes { oid committedDate additions deletions }
    pageInfo { hasNextPage endCursor }
  }
`;

const historyQuery = `
  query Activity($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      isPrivate nameWithOwner url description isFork isArchived
      defaultBranchRef {
        name
        target {
          ... on Commit {
            oid committedDate messageHeadline url
            ${historySelection}
          }
        }
      }
    }
  }
`;

const pinnedHistoryQuery = `
  query ActivityPage($owner: String!, $name: String!, $head: GitObjectID!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      isPrivate
      object(oid: $head) {
        ... on Commit { ${historySelection} }
      }
    }
  }
`;

export async function collectActivity({
  accounts,
  token,
  now = new Date(),
  request = fetch,
}: {
  readonly accounts: readonly string[];
  readonly token: string;
  readonly now?: Date;
  readonly request?: typeof fetch;
}): Promise<ActivitySnapshot> {
  if (!token.trim()) {
    throw new Error("GH_TOKEN is required to collect GitHub activity.");
  }
  if (
    accounts.length === 0 ||
    accounts.some((account) => !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(account))
  ) {
    throw new Error("Configure at least one valid GitHub account.");
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "workforce-activity",
    "x-github-api-version": "2022-11-28",
  };
  async function github<T>(path: string, body?: object): Promise<T> {
    const send = () =>
      request(`https://api.github.com${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    let response = await send();
    for (
      let retry = 1;
      retry <= 2 && [500, 502, 503, 504].includes(response.status);
      retry += 1
    ) {
      const waitMs = 1000 * 2 ** (retry - 1);
      console.warn(
        `GitHub ${path}: HTTP ${response.status}; retry ${retry}/2 in ${waitMs}ms.`,
      );
      await response.body?.cancel();
      await delay(waitMs);
      response = await send();
    }
    if (!response.ok) {
      throw new Error(
        `GitHub ${path}: HTTP ${response.status}; rate limit resets at ${response.headers.get("x-ratelimit-reset") ?? "unknown"}. Snapshot was not published.`,
      );
    }
    return response.json<T>();
  }

  async function graphql<T>(query: string, variables: object): Promise<T> {
    const result = await github<{
      data?: T;
      errors?: readonly { message: string }[];
    }>("/graphql", { query, variables });
    if (result.errors?.length) {
      throw new Error(
        `GitHub GraphQL: ${result.errors.map((error) => error.message).join("; ")}`,
      );
    }
    if (!result.data) {
      throw new Error(
        "GitHub GraphQL returned no data. Snapshot was not published.",
      );
    }
    return result.data;
  }

  const window = activityWindow(now);
  const discovered = new Map<string, PublicRepository>();
  for (const account of new Set(accounts)) {
    for (let page = 1; ; page += 1) {
      // This endpoint lists public owned repositories for both users and organizations.
      const repositories = await github<PublicRepository[]>(
        `/users/${encodeURIComponent(account)}/repos?type=owner&per_page=100&page=${page}`,
      );
      for (const repository of repositories) {
        if (!repository.private) {
          discovered.set(
            `${repository.owner.login}/${repository.name}`.toLowerCase(),
            repository,
          );
        }
      }
      if (repositories.length < 100) break;
    }
  }

  const repositories: RepositoryActivity[] = [];
  for (const repository of discovered.values()) {
    const commits: CommitActivity[] = [];
    const variables = {
      owner: repository.owner.login,
      name: repository.name,
      since: window.since,
      until: window.until,
    };
    const first = await graphql<HistoryPage>(historyQuery, {
      ...variables,
      cursor: null,
    });
    const metadata = first.repository;
    if (!metadata || metadata.isPrivate) {
      throw new Error(
        `Repository ${repository.name} is unavailable or no longer public. Snapshot was not published.`,
      );
    }
    let cursor: string | null = null;
    let history = metadata.defaultBranchRef?.target.history;
    while (history) {
      for (const commit of history.nodes) {
        commits.push({
          sha: commit.oid,
          committedAt: commit.committedDate,
          additions: commit.additions,
          deletions: commit.deletions,
        });
      }
      if (!history.pageInfo.hasNextPage) break;
      const next = history.pageInfo.endCursor;
      if (!next || next === cursor) {
        throw new Error(
          `GitHub ${repository.name}: invalid pagination cursor.`,
        );
      }
      cursor = next;
      // Pin pagination to the first head so concurrent pushes cannot shift pages.
      const page = await graphql<{
        repository: {
          isPrivate: boolean;
          object: { history: CommitHistory } | null;
        } | null;
      }>(pinnedHistoryQuery, {
        ...variables,
        head: metadata.defaultBranchRef?.target.oid,
        cursor,
      });
      if (
        !page.repository ||
        page.repository.isPrivate ||
        !page.repository.object
      ) {
        throw new Error(
          `GitHub ${repository.name}: pinned history is unavailable or no longer public.`,
        );
      }
      history = page.repository.object.history;
    }

    const daily = dailyActivity(commits, window);
    const head = metadata.defaultBranchRef?.target;
    repositories.push({
      name: metadata.nameWithOwner,
      url: metadata.url,
      description: metadata.description,
      fork: metadata.isFork,
      archived: metadata.isArchived,
      defaultBranch: metadata.defaultBranchRef?.name ?? null,
      latestCommit: head
        ? {
            committedAt: head.committedDate,
            message: head.messageHeadline,
            url: head.url,
          }
        : null,
      daily,
      ...activityTotals(daily),
    });
  }
  repositories.sort(
    (left, right) =>
      (right.latestCommit?.committedAt ?? "").localeCompare(
        left.latestCommit?.committedAt ?? "",
      ) || left.name.localeCompare(right.name),
  );
  const daily = combineDaily(repositories, window.dates);
  return {
    version: 1,
    accounts: [...new Set(accounts)],
    generatedAt: new Date().toISOString(),
    since: window.since,
    until: window.until,
    timezone: "Asia/Shanghai",
    days: 30,
    totals: activityTotals(daily),
    daily,
    repositories,
  };
}
