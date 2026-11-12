import type {
  ActivitySnapshot,
  ActivityTotals,
} from "@shazhou-work/workforce-contracts";
import { CollectionStore } from "./collection-store.js";
import type { Bindings } from "./env.js";

export async function publicActivityOwner(
  env: Bindings,
): Promise<string | null> {
  const githubId = env.PUBLIC_ACTIVITY_GITHUB_ID;
  if (!githubId || !/^[1-9]\d*$/.test(githubId) || !env.DB)
    throw new Error("Public activity source is not configured.");
  const owner = await new CollectionStore(env.DB).one<{ id: string }>(
    `SELECT u.id FROM personal_users u
     JOIN personal_identities i ON i.user_id=u.id AND i.provider='github' AND i.provider_id=?
     JOIN personal_github g ON g.user_id=u.id AND g.github_id=i.provider_id
     WHERE u.status='active'`,
    githubId,
  );
  return owner?.id ?? null;
}

export async function publicPersonalSnapshot(
  env: Bindings,
): Promise<ActivitySnapshot | null> {
  const userId = await publicActivityOwner(env);
  if (!userId) return null;
  const row = await new CollectionStore(env.DB!, userId).one<{
    snapshot_json: string;
    until_at: string;
  }>(
    `SELECT s.snapshot_json,r.until_at FROM personal_state s
     JOIN collection_runs r ON r.id=s.published_run_id
     JOIN config_revisions c ON c.id=r.revision_id AND c.config_id=s.id
     WHERE s.id=? AND s.snapshot_json IS NOT NULL`,
    userId,
  );
  if (!row) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.snapshot_json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // JSON parser errors can embed private snapshot contents in their message.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Public activity snapshot is not valid JSON.");
  }
  const snapshot = publicSnapshotProjection(value);
  if (Date.parse(snapshot.until) !== Date.parse(row.until_at))
    throw new Error("Public activity cutoff does not match its complete run.");
  return snapshot;
}

// Reconstruct every level: personal scope/author settings and future private
// snapshot fields must never become public just because they were serialized.
export function publicSnapshotProjection(value: unknown): ActivitySnapshot {
  const snapshot = object(value);
  if (
    snapshot.version !== 1 ||
    snapshot.days !== 30 ||
    snapshot.timezone !== "Asia/Shanghai"
  )
    throw new Error("Invalid public activity snapshot.");
  const daily = (value: unknown) =>
    array(value).map((value) => {
      const row = object(value);
      return { date: date(row.date), ...totals(row) };
    });
  const repositories = array(snapshot.repositories).map((value) => {
    const repo = object(value);
    const name = text(repo.name);
    if (!/^[\w.-]+\/[\w.-]+$/.test(name))
      throw new Error("Invalid public repository name.");
    const latest =
      repo.latestCommit === null ? null : object(repo.latestCommit);
    return {
      name,
      url: githubUrl(repo.url, name),
      description: nullableText(repo.description),
      defaultBranch: nullableText(repo.defaultBranch),
      fork: boolean(repo.fork),
      archived: boolean(repo.archived),
      latestCommit: latest
        ? {
            committedAt: instant(latest.committedAt),
            message: text(latest.message),
            url: githubUrl(latest.url, `${name}/commit/`),
          }
        : null,
      daily: daily(repo.daily),
      ...totals(repo),
    };
  });
  const result: ActivitySnapshot = {
    version: 1,
    accounts: [
      ...new Set(repositories.map((repo) => repo.name.split("/")[0]!)),
    ].sort(),
    authorFilter: { login: "公开数据源", emailMatching: false },
    generatedAt: instant(snapshot.generatedAt),
    since: instant(snapshot.since),
    until: instant(snapshot.until),
    timezone: "Asia/Shanghai",
    days: 30,
    totals: totals(object(snapshot.totals)),
    daily: daily(snapshot.daily),
    repositories,
    ...(snapshot.yearly === undefined
      ? {}
      : {
          yearly: array(snapshot.yearly).map((value) => {
            const row = object(value);
            return { date: date(row.date), commits: number(row.commits) };
          }),
        }),
    ...(snapshot.rolling === undefined
      ? {}
      : {
          rolling: array(snapshot.rolling).map((value) => {
            const row = object(value);
            return { at: instant(row.at), ...totals(row) };
          }),
        }),
  };
  if (
    result.daily.length !== 30 ||
    repositories.some((repo) => repo.daily.length !== 30) ||
    Date.parse(result.since) > Date.parse(result.until)
  )
    throw new Error("Incomplete public activity snapshot.");
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid public activity object.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid public activity array.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid public activity text.");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error("Invalid public activity flag.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid public activity metric.");
  return value;
}
function totals(row: Record<string, unknown>): ActivityTotals {
  return {
    commits: number(row.commits),
    additions: number(row.additions),
    deletions: number(row.deletions),
    averageLines: number(row.averageLines),
  };
}
function date(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error("Invalid public activity date.");
  return result;
}
function instant(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("Invalid public activity time.");
  return result;
}
function githubUrl(value: unknown, path: string): string {
  const result = text(value);
  if (!URL.canParse(result)) throw new Error("Invalid public repository URL.");
  const url = new URL(result);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (path.endsWith("/")
      ? !url.pathname.startsWith(`/${path}`)
      : url.pathname !== `/${path}`)
  )
    throw new Error("Invalid public repository URL.");
  return result;
}
