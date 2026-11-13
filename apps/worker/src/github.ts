import {
  activityTotals,
  activityWindow,
  combineDaily,
  dailyActivity,
  isGitHubLogin,
  rollingActivity,
  type ActivitySnapshot,
  type CommitActivity,
  type RepositoryActivity,
} from "@shazhou-work/workforce-contracts";
import { createGitHubClient } from "./github-client.js";

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
    readonly author: {
      readonly email: string;
      readonly user: { readonly login: string } | null;
    } | null;
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
    nodes { oid committedDate additions deletions author { email user { login } } }
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
  authorLogin = "shazhou-ww",
  authorEmails = [],
  token,
  now = new Date(),
  request = fetch,
}: {
  readonly accounts: readonly string[];
  readonly authorLogin?: string;
  readonly authorEmails?: readonly string[];
  readonly token: string;
  readonly now?: Date;
  readonly request?: typeof fetch;
}): Promise<ActivitySnapshot> {
  if (!token.trim()) {
    throw new Error("GH_TOKEN is required to collect GitHub activity.");
  }
  if (
    accounts.length === 0 ||
    accounts.some((account) => !isGitHubLogin(account))
  ) {
    throw new Error("Configure at least one valid GitHub account.");
  }
  if (!isGitHubLogin(authorLogin)) {
    throw new Error("Configure a valid GITHUB_AUTHOR_LOGIN.");
  }
  const emails = new Set(
    authorEmails.map((email) => email.trim().toLowerCase()),
  );
  if ([...emails].some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("Configure valid comma-separated GITHUB_AUTHOR_EMAILS.");
  }
  const { github, graphql } = createGitHubClient(token, request);

  const window = activityWindow(now);
  const yearlyWindow = activityWindow(now, 365);
  const yearlyCounts = new Map(yearlyWindow.dates.map((date) => [date, 0]));
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
  const rolling = rollingActivity([], window);
  for (const repository of discovered.values()) {
    const commits: CommitActivity[] = [];
    const variables = {
      owner: repository.owner.login,
      name: repository.name,
      since: yearlyWindow.since,
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
        const author = commit.author;
        if (
          !author ||
          (author.user?.login.toLowerCase() !== authorLogin.toLowerCase() &&
            !emails.has(author.email.trim().toLowerCase()))
        ) {
          continue;
        }
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
    for (const day of dailyActivity(commits, yearlyWindow)) {
      yearlyCounts.set(
        day.date,
        (yearlyCounts.get(day.date) ?? 0) + day.commits,
      );
    }
    for (const [index, point] of rollingActivity(commits, window).entries()) {
      const combined = rolling[index]!;
      rolling[index] = {
        at: point.at,
        ...activityTotals([combined, point]),
      };
    }
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
    authorFilter: {
      login: authorLogin,
      emailMatching: emails.size > 0,
    },
    generatedAt: new Date().toISOString(),
    since: window.since,
    until: window.until,
    timezone: "Asia/Shanghai",
    days: 30,
    totals: activityTotals(daily),
    daily,
    rolling,
    repositories,
    yearly: yearlyWindow.dates.map((date) => ({
      date,
      commits: yearlyCounts.get(date) ?? 0,
    })),
  };
}
