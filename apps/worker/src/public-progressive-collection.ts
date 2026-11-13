import type { Bindings } from "./env.js";
import type { CollectionParams, CollectionSteps } from "./collection.js";
import type { CollectionConfig } from "./collection-config.js";
import type { CollectionStore } from "./collection-store.js";
import type { GitHubClient } from "./github-client.js";
import {
  collectProgressively,
  type ProgressiveRepository,
  type RepositoryProgress,
  type MonthHistoryRequest,
} from "./progressive-collection.js";
import type { HistoryPage } from "./collection-github.js";
import {
  activityWindow,
  activityTotals,
} from "@shazhou-work/workforce-contracts";
import {
  assertPersonalCollectionActive,
  githubCredentialGeneration,
  githubConnection,
} from "./platform.js";

function batches<T>(items: readonly T[], owner: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = owner(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    Array.from({ length: Math.ceil(group.length / 100) }, (_, index) =>
      group.slice(index * 100, index * 100 + 100),
    ),
  );
}

async function seedLegacyHistory(
  store: CollectionStore,
  repository: ProgressiveRepository,
  until: string,
  logins: readonly string[],
  emails: ReadonlySet<string>,
): Promise<RepositoryProgress | null> {
  const previous = await store.syncState(repository.id);
  if (
    !previous ||
    previous.head_sha !== repository.metadata.head ||
    previous.default_branch !== repository.metadata.defaultBranch
  )
    return null;
  const year = activityWindow(new Date(until), 365);
  const month = activityWindow(new Date(until), 31);
  const matched = `FROM history_commits h JOIN commits c ON c.repository_id=h.repository_id AND c.sha=h.sha
    WHERE h.history_id=? AND h.repository_id=? AND julianday(c.committed_at)>=julianday(?) AND julianday(c.committed_at)<=julianday(?)
    AND (c.author_login IN (SELECT value FROM json_each(?)) OR c.author_email_hmac IN (SELECT value FROM json_each(?)))`;
  const values = [
    previous.history_id,
    repository.id,
    year.since,
    until,
    JSON.stringify(logins),
    JSON.stringify([...emails]),
  ];
  const daily = await store.rows<{
    date: string;
    commits: number;
    additions: number;
    deletions: number;
  }>(
    `SELECT date(c.committed_at,'+8 hours') AS date,count(*) AS commits,sum(c.additions) AS additions,sum(c.deletions) AS deletions ${matched} GROUP BY date`,
    ...values,
  );
  const hourly = await store.rows<{
    date: string;
    hour: string;
    commits: number;
    additions: number;
    deletions: number;
  }>(
    `SELECT date(c.committed_at,'+8 hours') AS date,
      strftime('%Y-%m-%dT%H:00:00.000Z',c.committed_at,
        CASE WHEN strftime('%M:%f',c.committed_at)='00:00.000' THEN '+0 hours' ELSE '+1 hours' END) AS hour,
      count(*) AS commits,sum(c.additions) AS additions,sum(c.deletions) AS deletions
      ${matched} GROUP BY date,hour`,
    previous.history_id,
    repository.id,
    month.since,
    until,
    JSON.stringify(logins),
    JSON.stringify([...emails]),
  );
  const rows = new Map(daily.map((day) => [day.date, day]));
  const days: RepositoryProgress["days"] = Object.fromEntries(
    year.dates.map((date) => [
      date,
      {
        date,
        ...activityTotals(rows.has(date) ? [rows.get(date)!] : []),
        until: new Date(
          Math.min(
            Date.parse(`${date}T00:00:00+08:00`) + 86_400_000 - 1,
            Date.parse(until),
          ),
        ).toISOString(),
        hours: Object.fromEntries(
          hourly
            .filter((hour) => hour.date === date)
            .map((hour) => [hour.hour, activityTotals([hour])]),
        ),
      },
    ]),
  );
  return {
    head: repository.metadata.head,
    branch: repository.metadata.defaultBranch,
    days,
  };
}

export async function collectPublicProgressively(
  env: Bindings,
  params: CollectionParams,
  steps: CollectionSteps,
  store: CollectionStore,
  config: CollectionConfig,
  clientForRepository: (name: string) => GitHubClient,
  hashEmail: (email: string) => Promise<string>,
  generation: string | null,
) {
  const repositories: ProgressiveRepository[] = [];
  const assertOwner = async () => {
    if (params.userId) {
      await assertPersonalCollectionActive(
        env,
        params.userId,
        params.runId,
        false,
      );
      if (
        !(await store.one(
          "SELECT id FROM personal_users WHERE id=? AND status='active'",
          params.userId,
        ))
      )
        throw new Error("Personal collection access was suspended.");
      if ((await githubCredentialGeneration(env, params.userId)) !== generation)
        throw new Error("Collection credential changed.");
    }
    if (!(await store.ownsRun(params.runId)))
      throw new Error("Collection publication ownership changed.");
  };
  const guard = async (repository?: ProgressiveRepository) => {
    await assertOwner();
    for (const group of batches(
      repository ? [repository] : repositories,
      (repo) => (params.userId ? "" : repo.metadata.name.split("/")[0]!),
    )) {
      const variables = Object.fromEntries(
        group.flatMap((repo, index) => {
          const [owner, name] = repo.metadata.name.split("/");
          return [
            [`owner${index}`, owner],
            [`name${index}`, name],
          ];
        }),
      );
      const response = await group[0]!.client.graphql<
        Record<
          string,
          {
            databaseId: number;
            isPrivate: boolean;
            nameWithOwner: string;
          } | null
        >
      >(
        `query ProgressiveAccess(${group.map((_, index) => `$owner${index}:String!,$name${index}:String!`).join(",")}){
          ${group.map((_, index) => `r${index}:repository(owner:$owner${index},name:$name${index}){databaseId isPrivate nameWithOwner}`).join("\n")}
        }`,
        variables,
      );
      await assertOwner();
      group.forEach((repo, index) => {
        const current = response[`r${index}`];
        if (
          !current ||
          current.isPrivate ||
          current.databaseId !== repo.id ||
          current.nameWithOwner.toLowerCase() !==
            repo.metadata.name.toLowerCase()
        )
          throw new Error("Repository is no longer available as public.");
      });
    }
    if (params.userId) {
      const connection = await githubConnection(env, params.userId);
      const identityClient =
        repository?.client ??
        repositories[0]?.client ??
        clientForRepository("");
      const viewer = await identityClient.github<{ id: number }>("/user");
      if (!connection || String(viewer.id) !== connection.id)
        throw new Error("GitHub collection identity changed.");
      await assertPersonalCollectionActive(
        env,
        params.userId,
        params.runId,
        false,
      );
      if ((await githubCredentialGeneration(env, params.userId)) !== generation)
        throw new Error("Collection credential changed.");
    }
    await assertOwner();
  };
  for (const repo of await store.repositories(params.runId)) {
    const metadata = await store.metadata(params.runId, repo.repository_id);
    if (!metadata) throw new Error("Pinned repository metadata is missing.");
    repositories.push({
      id: repo.repository_id,
      metadata,
      client: clientForRepository(repo.full_name),
    });
  }
  const emails = new Set(await Promise.all(config.authorEmails.map(hashEmail)));
  const initialized = new Set<number>();
  await collectProgressively({
    runId: params.runId,
    until: params.until,
    steps,
    private: false,
    repositories,
    accounts: config.accounts,
    authorFilter: {
      login: config.authorLogins.join(" / ") || "已配置邮箱",
      emailMatching: emails.size > 0,
    },
    authorize: guard,
    prefetchMonth: async (requests) => {
      const pages = new Map<number, HistoryPage>();
      for (const group of batches(requests, (entry) =>
        params.userId ? "" : entry.repository.metadata.name.split("/")[0]!,
      )) {
        await assertOwner();
        const variables = Object.fromEntries(
          group.flatMap((entry, index) => {
            const [owner, name] = entry.repository.metadata.name.split("/");
            return [
              [`owner${index}`, owner],
              [`name${index}`, name],
              [`head${index}`, entry.repository.metadata.head],
              [`since${index}`, entry.since],
              [`until${index}`, entry.until],
            ];
          }),
        );
        const response = await group[0]!.repository.client.graphql<
          Record<
            string,
            {
              databaseId: number;
              isPrivate: boolean;
              object: { history: HistoryPage } | null;
            } | null
          >
        >(
          `query ProgressiveMonthBatch(${group
            .map(
              (_, index) =>
                `$owner${index}:String!,$name${index}:String!,$head${index}:GitObjectID!,$since${index}:GitTimestamp!,$until${index}:GitTimestamp!`,
            )
            .join(",")}){
            ${group
              .map(
                (
                  _,
                  index,
                ) => `r${index}:repository(owner:$owner${index},name:$name${index}){
              databaseId isPrivate object(oid:$head${index}){... on Commit{
                history(first:100,since:$since${index},until:$until${index}){
                  nodes{oid committedDate additions deletions author{email user{login}}}
                  pageInfo{hasNextPage endCursor}
                }
              }}
            }`,
              )
              .join("\n")}
          }`,
          variables,
        );
        await assertOwner();
        group.forEach((entry: MonthHistoryRequest, index) => {
          const repo = response[`r${index}`];
          if (
            !repo ||
            repo.isPrivate ||
            repo.databaseId !== entry.repository.id ||
            !repo.object
          )
            throw new Error("Pinned repository history is unavailable.");
          pages.set(entry.repository.id, repo.object.history);
        });
      }
      return pages;
    },
    assertOwner,
    matches: async (commit) =>
      config.authorLogins.includes(
        commit.author?.user?.login.toLowerCase() ?? "",
      ) ||
      (!!commit.author?.email &&
        emails.has(await hashEmail(commit.author.email.toLowerCase()))),
    load: async (id) => {
      await assertOwner();
      const row = await store.one<{ progress_json: string }>(
        "SELECT progress_json FROM public_collection_progress WHERE scope_id=? AND revision_id=? AND repository_id=?",
        store.scopeId,
        params.revisionId,
        id,
      );
      await assertOwner();
      let progress = row
        ? (JSON.parse(row.progress_json) as RepositoryProgress)
        : null;
      if (!initialized.has(id)) {
        initialized.add(id);
        const repo = repositories.find((repo) => repo.id === id);
        if (!repo) throw new Error("Collection repository is missing.");
        const reusable = await store.one<{ progress_json: string }>(
          `SELECT p.progress_json FROM public_collection_progress p
           JOIN config_revisions c ON c.id=p.revision_id
           WHERE p.scope_id=? AND c.config_id=? AND p.repository_id=? AND p.revision_id!=?
           AND NOT EXISTS(
             SELECT identity_type,normalized_value FROM config_identities WHERE revision_id=p.revision_id
             EXCEPT SELECT identity_type,normalized_value FROM config_identities WHERE revision_id=?
           )
           AND NOT EXISTS(
             SELECT identity_type,normalized_value FROM config_identities WHERE revision_id=?
             EXCEPT SELECT identity_type,normalized_value FROM config_identities WHERE revision_id=p.revision_id
           )
           ORDER BY (json_extract(p.progress_json,'$.head') IS ?) DESC,
             (SELECT count(*) FROM json_each(p.progress_json,'$.days')) DESC,
             c.created_at DESC,p.revision_id LIMIT 1`,
          store.scopeId,
          store.scopeId,
          id,
          params.revisionId,
          params.revisionId,
          params.revisionId,
          repo.metadata.head,
        );
        await assertOwner();
        if (reusable) {
          const previous = JSON.parse(
            reusable.progress_json,
          ) as RepositoryProgress;
          if (!progress) progress = previous;
          else if (
            previous.head === progress.head &&
            previous.branch === progress.branch
          )
            progress.days = { ...previous.days, ...progress.days };
        }
        const today = activityWindow(new Date(params.until)).dates.at(-1)!;
        if (
          !progress ||
          progress.head !== repo.metadata.head ||
          progress.days[today]?.until !== params.until
        ) {
          const legacy = await seedLegacyHistory(
            store,
            repo,
            params.until,
            config.authorLogins,
            emails,
          );
          await assertOwner();
          if (legacy) {
            progress = { ...progress, ...legacy };
            delete progress.pending;
          }
        }
      }
      return progress;
    },
    save: async (id, progress) => {
      await assertOwner();
      const saved = await store.one(
        `INSERT INTO public_collection_progress(scope_id,revision_id,repository_id,progress_json)
         SELECT ?,?,?,? WHERE EXISTS(
           SELECT 1 FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id
           WHERE r.id=? AND c.config_id=? AND r.status IN ('collecting','ready','failed')
         ) AND EXISTS(SELECT 1 FROM ${params.userId ? "personal_state" : "collection_state"} WHERE id=? AND active_run_id=?)
         AND (?='default' OR EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active'))
         AND (?='default' OR COALESCE((
           SELECT sum(CAST(json_extract(progress_json,'$.received') AS INTEGER))
           FROM public_collection_progress WHERE scope_id=? AND revision_id=? AND repository_id!=?
           AND json_extract(progress_json,'$.runId')=?
         ),0)+?<=50000)
         ON CONFLICT(scope_id,revision_id,repository_id) DO UPDATE SET progress_json=excluded.progress_json
         RETURNING repository_id`,
        store.scopeId,
        params.revisionId,
        id,
        JSON.stringify(progress),
        params.runId,
        store.scopeId,
        params.userId ?? 1,
        params.runId,
        store.scopeId,
        store.scopeId,
        store.scopeId,
        store.scopeId,
        params.revisionId,
        id,
        params.runId,
        progress.received ?? 0,
      );
      if (!saved)
        throw new Error(
          "Collection cache write was stopped by authorization, run ownership, or the 50000-commit personal history budget.",
        );
      await assertOwner();
    },
    publish: async (snapshot, complete) => {
      await guard();
      await store.ready(params.runId);
      await assertOwner();
      if (params.userId) await store.publishPersonal(params.runId, snapshot);
      else {
        await env.STATS.put("activity:v1", JSON.stringify(snapshot));
        await assertOwner();
      }
      if (complete) {
        await assertOwner();
        await store
          .statement(
            "UPDATE run_repositories SET status='complete',completed_at=? WHERE run_id=?",
            new Date().toISOString(),
            params.runId,
          )
          .run();
        await assertOwner();
        await store.published(params.runId);
      }
    },
  });
}
