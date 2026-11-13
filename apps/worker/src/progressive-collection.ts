import {
  activityTotals,
  activityWindow,
  beijingDate,
  combineDaily,
  dailyActivity,
  activityAnchors,
  type ActivitySnapshot,
  type CommitActivity,
  type DailyActivity,
  type ActivityTotals,
} from "@shazhou-work/workforce-contracts";
import type { CollectionSteps } from "./collection.js";
import type {
  HistoryPage,
  RawCommit,
  RepositoryMetadata,
} from "./collection-github.js";
import { GitHubError, type GitHubClient } from "./github-client.js";

const dayMs = 86_400_000;
const dayStart = (date: string) => Date.parse(`${date}T00:00:00+08:00`);
const dayEnd = (date: string) =>
  new Date(dayStart(date) + dayMs - 1).toISOString();

export interface RepositoryProgress {
  runId?: string;
  received?: number;
  head: string | null;
  branch: string | null;
  days: Record<
    string,
    DailyActivity & { until: string; hours: Record<string, ActivityTotals> }
  >;
  pending?: {
    since: string;
    until: string;
    cursor: string | null;
    received: number;
    days: RepositoryProgress["days"];
    previousOids: string[];
  };
}

export interface ProgressiveRepository {
  id: number;
  metadata: RepositoryMetadata;
  client: GitHubClient;
}

interface ProgressiveOptions {
  runId: string;
  until: string;
  repositories: readonly ProgressiveRepository[];
  accounts: readonly string[];
  authorFilter?: ActivitySnapshot["authorFilter"];
  steps: CollectionSteps;
  authorize(repository?: ProgressiveRepository): Promise<void>;
  prefetchMonth?(
    requests: readonly MonthHistoryRequest[],
  ): Promise<ReadonlyMap<number, HistoryPage>>;
  assertOwner(): Promise<void>;
  matches(commit: RawCommit): boolean | Promise<boolean>;
  load(id: number): Promise<RepositoryProgress | null>;
  save(id: number, progress: RepositoryProgress): Promise<void>;
  publish(snapshot: ActivitySnapshot, complete: boolean): Promise<void>;
  private: boolean;
}

export interface MonthHistoryRequest {
  repository: ProgressiveRepository;
  since: string;
  until: string;
}

// Only forward ancestry with a complete, small comparison can retain old days.
// Backdated new commits invalidate every potentially affected day; force pushes,
// branch changes and inconclusive comparisons rebuild rather than trust stale data.
async function validateCache(
  repo: ProgressiveRepository,
  cached: RepositoryProgress | null,
  authorize: () => Promise<void>,
): Promise<RepositoryProgress> {
  const fresh: RepositoryProgress = {
    head: repo.metadata.head,
    branch: repo.metadata.defaultBranch,
    days: {},
  };
  if (!cached || cached.branch !== fresh.branch) return fresh;
  if (cached.head === fresh.head) return cached;
  if (!cached.head || !fresh.head) return fresh;
  await authorize();
  let comparison: {
    status: string;
    ahead_by: number;
    total_commits: number;
    commits: { commit: { committer: { date: string } | null } }[];
  };
  try {
    comparison = await repo.client.github(
      `/repos/${repo.metadata.name}/compare/${cached.head}...${fresh.head}?per_page=100&page=1`,
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return fresh;
    throw error;
  }
  await authorize();
  if (
    comparison.status !== "ahead" ||
    comparison.total_commits !== comparison.ahead_by ||
    comparison.commits.length !== comparison.total_commits ||
    comparison.commits.length === 0 ||
    comparison.commits.some(
      (commit) =>
        !Number.isFinite(Date.parse(commit.commit.committer?.date ?? "")),
    )
  )
    return fresh;
  const earliest = Math.min(
    ...comparison.commits.map((commit) =>
      Date.parse(commit.commit.committer!.date),
    ),
  );
  fresh.days = Object.fromEntries(
    Object.entries(cached.days).filter(
      ([date]) => dayStart(date) + dayMs <= earliest,
    ),
  );
  return fresh;
}

export async function collectProgressively(
  options: ProgressiveOptions,
): Promise<void> {
  const month = activityWindow(new Date(options.until));
  const rollingSince = new Date(Date.parse(month.since) - dayMs).toISOString();
  const rollingDate = beijingDate(rollingSince);
  const year = activityWindow(new Date(options.until), 365);
  const states = new Map<number, RepositoryProgress>();
  const requiredUntil = (date: string) =>
    new Date(
      Math.min(Date.parse(dayEnd(date)), Date.parse(options.until)),
    ).toISOString();
  const known = (state: RepositoryProgress, date: string) =>
    !!state.days[date] && state.days[date].until === requiredUntil(date);

  await options.authorize();
  for (const [index, repo] of options.repositories.entries()) {
    await options.steps.do(`progressive validate ${index}`, async () => {
      await options.assertOwner();
      const state = await validateCache(repo, await options.load(repo.id), () =>
        options.authorize(repo),
      );
      if (state.runId !== options.runId) state.received = 0;
      state.runId = options.runId;
      // Partial current days cannot be reused for a later cutoff.
      state.days = Object.fromEntries(
        Object.entries(state.days).filter(
          ([date, day]) =>
            year.dates.includes(date) && day.until === requiredUntil(date),
        ),
      );
      for (const [date, day] of Object.entries(state.days))
        if (date < rollingDate) day.hours = {};
      await options.assertOwner();
      await options.save(repo.id, state);
    });
    await options.assertOwner();
    const state = await options.load(repo.id);
    if (
      !state ||
      state.head !== repo.metadata.head ||
      state.branch !== repo.metadata.defaultBranch
    )
      throw new Error("Collection progress no longer matches pinned metadata.");
    states.set(repo.id, state);
  }

  const monthRequests = options.repositories.flatMap((repository) => {
    const state = states.get(repository.id)!;
    const missing = month.dates.filter((date) => !known(state, date));
    if (
      !repository.metadata.head ||
      !missing.length ||
      missing.length > 2 ||
      state.pending?.cursor
    )
      return [];
    return [
      {
        repository,
        since: new Date(dayStart(missing[0]!)).toISOString(),
        until: requiredUntil(missing.at(-1)!),
      },
    ];
  });
  const prefetched =
    options.prefetchMonth && monthRequests.length > 1
      ? new Map(await options.prefetchMonth(monthRequests))
      : new Map<number, HistoryPage>();

  const fill = async (
    repo: ProgressiveRepository,
    dates: readonly string[],
    label: string,
  ) => {
    const state = states.get(repo.id)!;
    const missing = dates.filter((date) => !known(state, date));
    if (!missing.length) return;
    const since = new Date(dayStart(missing[0]!)).toISOString();
    const until = requiredUntil(missing.at(-1)!);
    if (state.pending?.since !== since || state.pending.until !== until)
      state.pending = {
        since,
        until,
        cursor: null,
        received: 0,
        days: {},
        previousOids: [],
      };
    for (let pageNumber = 0; ; pageNumber += 1) {
      await options.steps.do(`${label} page ${pageNumber}`, async () => {
        await options.assertOwner();
        const saved = await options.load(repo.id);
        if (!saved) throw new Error("Collection progress was removed.");
        // A replayed completed step is read from D1, never Workflow output.
        if (dates.every((date) => known(saved, date))) {
          states.set(repo.id, saved);
          return;
        }
        const pending =
          saved.pending?.since === since && saved.pending.until === until
            ? saved.pending
            : {
                since,
                until,
                cursor: null,
                received: 0,
                days: {},
                previousOids: [],
              };
        let history: HistoryPage = {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
        const prepared = monthRequests.find(
          (prepared) =>
            prepared.repository.id === repo.id &&
            prepared.since === since &&
            prepared.until === until,
        );
        const firstPage =
          !pending.cursor && prepared ? prefetched.get(repo.id) : undefined;
        if (firstPage) {
          prefetched.delete(repo.id);
          history = firstPage;
          await options.assertOwner();
        } else if (repo.metadata.head) {
          const [owner, name] = repo.metadata.name.split("/");
          const response = await repo.client.graphql<{
            repository: {
              isPrivate: boolean;
              databaseId: number;
              object: { history: HistoryPage } | null;
            } | null;
          }>(
            `query ProgressiveHistory($owner:String!,$name:String!,$head:GitObjectID!,$cursor:String,$since:GitTimestamp!,$until:GitTimestamp!){
              repository(owner:$owner,name:$name){isPrivate databaseId object(oid:$head){... on Commit{
                history(first:100,after:$cursor,since:$since,until:$until){
                  nodes{oid committedDate additions deletions author{email user{login}}}
                  pageInfo{hasNextPage endCursor}
                }
              }}}
            }`,
            {
              owner,
              name,
              head: repo.metadata.head,
              cursor: pending.cursor,
              since,
              until,
            },
          );
          await options.assertOwner();
          if (
            !response.repository ||
            response.repository.isPrivate !== options.private ||
            response.repository.databaseId !== repo.id ||
            !response.repository.object
          )
            throw new Error("Pinned repository history is unavailable.");
          // Each authenticated page independently verifies repository identity,
          // content access and visibility; publication also rechecks all scopes.
          history = response.repository.object.history;
        }
        pending.received += history.nodes.length;
        saved.received = (saved.received ?? 0) + history.nodes.length;
        if (pending.received > 50_000)
          throw new Error(
            "A collection interval exceeds the 50000 commit safety limit.",
          );
        const nodes = new Map(
          history.nodes.map((commit) => [commit.oid, commit]),
        );
        const commits: CommitActivity[] = [];
        for (const commit of nodes.values()) {
          if (await options.matches(commit)) {
            if (pending.previousOids.includes(commit.oid))
              throw new Error("Overlapping history pagination pages.");
            commits.push({
              sha: commit.oid,
              committedAt: commit.committedDate,
              additions: commit.additions,
              deletions: commit.deletions,
            });
          }
        }
        const interval = { since, until, dates: missing };
        for (const day of dailyActivity(commits, interval)) {
          const previous = pending.days[day.date];
          pending.days[day.date] = {
            date: day.date,
            ...activityTotals([day, ...(previous ? [previous] : [])]),
            until: requiredUntil(day.date),
            hours: previous?.hours ?? {},
          };
        }
        for (const commit of commits) {
          const date = beijingDate(commit.committedAt);
          const time = Date.parse(commit.committedAt);
          if (
            date < rollingDate ||
            time < Date.parse(since) ||
            time > Date.parse(until)
          )
            continue;
          const day = pending.days[date];
          if (!day) continue;
          const hour = new Date(
            Math.ceil(time / 3_600_000) * 3_600_000,
          ).toISOString();
          day.hours[hour] = activityTotals([
            {
              commits: 1,
              additions: commit.additions,
              deletions: commit.deletions,
            },
            ...(day.hours[hour] ? [day.hours[hour]] : []),
          ]);
        }
        pending.previousOids = commits.map((commit) => commit.sha);
        if (history.pageInfo.hasNextPage) {
          if (
            !history.pageInfo.endCursor ||
            history.pageInfo.endCursor === pending.cursor
          )
            throw new Error("Invalid history pagination cursor.");
          pending.cursor = history.pageInfo.endCursor;
          saved.pending = pending;
        } else {
          Object.assign(saved.days, pending.days);
          delete saved.pending;
        }
        await options.assertOwner();
        await options.save(repo.id, saved);
        states.set(repo.id, saved);
      });
      await options.assertOwner();
      const current = await options.load(repo.id);
      if (!current) throw new Error("Collection progress was removed.");
      states.set(repo.id, current);
      if (dates.every((date) => known(current, date))) break;
    }
  };
  const publish = async (complete: boolean) => {
    await options.assertOwner();
    const repositories = options.repositories.map((repo) => {
      const state = states.get(repo.id)!;
      const daily = month.dates.map((date) => {
        const day = state.days[date];
        if (!day || !known(state, date))
          throw new Error("Month is incomplete.");
        return { date, ...activityTotals([day]) };
      });
      return { ...repo.metadata, daily, ...activityTotals(daily) };
    });
    repositories.sort(
      (left, right) =>
        (right.latestCommit?.committedAt ?? "").localeCompare(
          left.latestCommit?.committedAt ?? "",
        ) || left.name.localeCompare(right.name),
    );
    const daily = combineDaily(repositories, month.dates);
    const hours = options.repositories.flatMap((repo) =>
      Object.entries(states.get(repo.id)!.days)
        .filter(([date]) => date >= rollingDate)
        .flatMap(([, day]) => Object.entries(day.hours)),
    );
    const sortedHours = hours
      .map(([at, totals]) => ({
        time: Date.parse(at),
        ...totals,
      }))
      .sort((left, right) => left.time - right.time);
    let left = 0;
    let right = 0;
    const running = { commits: 0, additions: 0, deletions: 0 };
    const rolling = activityAnchors(month).map((at) => {
      const end = Date.parse(at);
      while (right < sortedHours.length && sortedHours[right]!.time <= end) {
        const row = sortedHours[right++]!;
        running.commits += row.commits;
        running.additions += row.additions;
        running.deletions += row.deletions;
      }
      while (left < right && sortedHours[left]!.time <= end - dayMs) {
        const row = sortedHours[left++]!;
        running.commits -= row.commits;
        running.additions -= row.additions;
        running.deletions -= row.deletions;
      }
      return { at, ...activityTotals([running]) };
    });
    const yearly = year.dates.flatMap((date) =>
      options.repositories.every((repo) => known(states.get(repo.id)!, date))
        ? [
            {
              date,
              commits: options.repositories.reduce(
                (sum, repo) => sum + states.get(repo.id)!.days[date]!.commits,
                0,
              ),
            },
          ]
        : [],
    );
    await options.publish(
      {
        version: 1,
        accounts: options.accounts,
        ...(options.authorFilter ? { authorFilter: options.authorFilter } : {}),
        generatedAt: new Date().toISOString(),
        since: month.since,
        until: month.until,
        timezone: "Asia/Shanghai",
        days: 30,
        daily,
        totals: activityTotals(daily),
        repositories,
        yearly,
        ...(options.repositories.every((repo) =>
          known(states.get(repo.id)!, rollingDate),
        )
          ? { rolling }
          : {}),
      },
      complete,
    );
  };

  for (const [index, repo] of options.repositories.entries())
    await fill(repo, month.dates, `progressive month ${index}`);
  const completeYear = () =>
    year.dates.every((date) =>
      options.repositories.every((repo) => known(states.get(repo.id)!, date)),
    );
  if (completeYear()) {
    await options.steps.do("publish complete cached snapshot", () =>
      publish(true),
    );
    return;
  }
  await options.steps.do("publish complete month snapshot", () =>
    publish(false),
  );
  const older = year.dates.slice(0, -30).reverse();
  for (let offset = 0; offset < older.length; offset += 30) {
    const dates = older.slice(offset, offset + 30).reverse();
    if (
      dates.every((date) =>
        options.repositories.every((repo) => known(states.get(repo.id)!, date)),
      )
    )
      continue;
    for (const [index, repo] of options.repositories.entries())
      await fill(
        repo,
        dates,
        `progressive year ${offset / 30} repository ${index}`,
      );
    const complete = completeYear();
    await options.steps.do(`publish annual progress ${offset / 30}`, () =>
      publish(complete),
    );
    if (complete) return;
  }
}
