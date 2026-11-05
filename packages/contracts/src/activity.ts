export interface CommitActivity {
  readonly sha: string;
  readonly committedAt: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ActivityTotals {
  readonly commits: number;
  readonly additions: number;
  readonly deletions: number;
  readonly averageLines: number;
}

export interface DailyActivity extends ActivityTotals {
  readonly date: string;
}

export interface RepositoryActivity extends ActivityTotals {
  readonly name: string;
  readonly url: string;
  readonly description: string | null;
  readonly defaultBranch: string | null;
  readonly fork: boolean;
  readonly archived: boolean;
  readonly latestCommit: {
    readonly committedAt: string;
    readonly message: string;
    readonly url: string;
  } | null;
  readonly daily: readonly DailyActivity[];
}

export interface ActivitySnapshot {
  readonly version: 1;
  readonly accounts: readonly string[];
  readonly generatedAt: string;
  readonly since: string;
  readonly until: string;
  readonly timezone: "Asia/Shanghai";
  readonly days: 30;
  readonly totals: ActivityTotals;
  readonly daily: readonly DailyActivity[];
  readonly repositories: readonly RepositoryActivity[];
}

const dayMs = 86_400_000;
const beijingOffset = 8 * 60 * 60 * 1000;

export function beijingDate(instant: string | number): string {
  return new Date(new Date(instant).getTime() + beijingOffset)
    .toISOString()
    .slice(0, 10);
}

export function activityWindow(now: Date): {
  since: string;
  until: string;
  dates: string[];
} {
  const today = Date.parse(`${beijingDate(now.getTime())}T00:00:00+08:00`);
  const start = today - 29 * dayMs;
  return {
    since: new Date(start).toISOString(),
    until: now.toISOString(),
    dates: Array.from({ length: 30 }, (_, index) =>
      beijingDate(start + index * dayMs),
    ),
  };
}

export function activityTotals(
  rows: readonly Pick<ActivityTotals, "commits" | "additions" | "deletions">[],
): ActivityTotals {
  const sum = rows.reduce(
    (total, row) => ({
      commits: total.commits + row.commits,
      additions: total.additions + row.additions,
      deletions: total.deletions + row.deletions,
    }),
    { commits: 0, additions: 0, deletions: 0 },
  );
  return {
    ...sum,
    averageLines: sum.commits
      ? (sum.additions + sum.deletions) / sum.commits
      : 0,
  };
}

export function dailyActivity(
  commits: readonly CommitActivity[],
  window: ReturnType<typeof activityWindow>,
): DailyActivity[] {
  const buckets = new Map(
    window.dates.map((date) => [
      date,
      { date, commits: 0, additions: 0, deletions: 0 },
    ]),
  );
  const seen = new Set<string>();
  for (const commit of commits) {
    const time = Date.parse(commit.committedAt);
    if (
      seen.has(commit.sha) ||
      time < Date.parse(window.since) ||
      time > Date.parse(window.until)
    ) {
      continue;
    }
    seen.add(commit.sha);
    const bucket = buckets.get(beijingDate(commit.committedAt));
    if (bucket) {
      bucket.commits += 1;
      bucket.additions += commit.additions;
      bucket.deletions += commit.deletions;
    }
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    averageLines: activityTotals([bucket]).averageLines,
  }));
}

export function combineDaily(
  repositories: readonly Pick<RepositoryActivity, "daily">[],
  dates: readonly string[],
): DailyActivity[] {
  return dates.map((date) => ({
    date,
    ...activityTotals(
      repositories.flatMap((repository) =>
        repository.daily.filter((day) => day.date === date),
      ),
    ),
  }));
}
