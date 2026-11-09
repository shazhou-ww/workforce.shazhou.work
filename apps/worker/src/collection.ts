import { createEmailHasher } from "./collection-config.js";
import {
  readAccount,
  readMetadata,
  readHistory,
  readComparison,
  readCommitDetails,
  type GitHubAccount,
  type GitHubRepository,
  type Comparison,
} from "./collection-github.js";
import { CollectionStore } from "./collection-store.js";
import {
  createGitHubClient,
  createOwnerGitHubClient,
  createOrganizationGitHubClient,
  createPublicGitHubClient,
} from "./github-client.js";
import type { Bindings } from "./env.js";

export interface CollectionParams {
  readonly runId: string;
  readonly revisionId: string;
  readonly until: string;
}

export interface CollectionSteps {
  do(name: string, callback: () => Promise<void>): Promise<void>;
}

function comparisonIsForward(
  comparison: Comparison | null,
): comparison is Comparison {
  return (
    comparison !== null &&
    (comparison.status === "ahead" || comparison.status === "identical")
  );
}

export async function runCollection(
  env: Bindings,
  params: CollectionParams,
  steps: CollectionSteps,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!env.DB)
    throw new Error("The collection D1 binding DB is not configured.");
  const store = new CollectionStore(env.DB);
  const client = createGitHubClient(env.GH_TOKEN ?? "", request);
  const clientForRepository = (name: string) =>
    createOwnerGitHubClient(env, name.split("/")[0] ?? "", request);
  const publicClient = createPublicGitHubClient(request);
  const hashEmail = await createEmailHasher(env.COLLECTION_EMAIL_KEY ?? "");
  await steps.do("claim publication lock", async () => {
    await store.begin(
      params.runId,
      params.revisionId,
      params.until,
      await hashEmail("workforce:email-key-id:v1"),
    );
  });
  const run = await store.run(params.runId);
  if (run.status === "blocked" || run.status === "cancelled") {
    console.warn(`Collection ${params.runId} was blocked by an active run.`);
    return;
  }
  if (run.status === "published") return;
  if (!(await store.ownsRun(params.runId))) {
    throw new Error("Collection no longer owns its publication lock.");
  }
  const config = await store.config(run.revision_id);
  const excludedNames = new Set(config.excludeRepositories);
  // Resolve exclusion IDs too, so a GitHub redirect after a rename cannot bypass an exclusion.
  const excludedIds = new Set<number>();
  for (const name of config.excludeRepositories) {
    await steps.do(`exclude ${name}`, async () => {
      const repository = await clientForRepository(
        name,
      ).github<GitHubRepository>(`/repos/${name}`);
      await store
        .statement(
          "INSERT OR REPLACE INTO discovery_pages VALUES (?,?,0,?,NULL)",
          params.runId,
          `exclude:${name}`,
          repository.id,
        )
        .run();
    });
    const checkpoint = await store.one<{ item_count: number }>(
      "SELECT item_count FROM discovery_pages WHERE run_id=? AND scope=? AND page=0",
      params.runId,
      `exclude:${name}`,
    );
    if (!checkpoint) throw new Error("Exclusion checkpoint is missing.");
    excludedIds.add(checkpoint.item_count);
  }
  const included = (repository: GitHubRepository) =>
    !repository.private &&
    !excludedNames.has(repository.full_name.toLowerCase()) &&
    !excludedIds.has(repository.id);

  if (config.repositoryMode === "all_owned_public") {
    for (const login of config.accounts) {
      await steps.do(`resolve account ${login}`, async () => {
        const account =
          (await store.one<GitHubAccount>(
            "SELECT github_id AS id,login,account_type AS type FROM accounts WHERE login=? COLLATE NOCASE",
            login,
          )) ?? (await readAccount(publicClient, login));
        await store.discover(params.runId, account, []);
        await store
          .statement(
            "INSERT OR REPLACE INTO discovery_pages VALUES (?,?,0,0,?)",
            params.runId,
            `account:${login}`,
            JSON.stringify(account),
          )
          .run();
      });
      const resolved = await store.one<{ payload_json: string }>(
        "SELECT payload_json FROM discovery_pages WHERE run_id=? AND scope=? AND page=0",
        params.runId,
        `account:${login}`,
      );
      if (!resolved)
        throw new Error("Account discovery checkpoint is missing.");
      const account = JSON.parse(resolved.payload_json) as GitHubAccount;
      const repositoryClient =
        account.type === "Organization"
          ? createOrganizationGitHubClient(env, account.login, request)
          : client;
      for (let page = 1; ; page += 1) {
        await steps.do(`discover ${login} page ${page}`, async () => {
          const repositories = await repositoryClient.github<
            GitHubRepository[]
          >(
            account.type === "Organization"
              ? `/orgs/${account.login}/repos?type=public&per_page=100&page=${page}`
              : `/users/${account.login}/repos?type=owner&per_page=100&page=${page}`,
          );
          if (
            repositories.some(
              (repository) => repository.owner.id !== account.id,
            )
          ) {
            throw new Error(
              "Repository owner identity changed; refresh the configured account identity before collecting.",
            );
          }
          await store.discover(
            params.runId,
            account,
            repositories.filter(
              (repository) =>
                repository.owner.id === account.id && included(repository),
            ),
          );
          await store
            .statement(
              "INSERT OR REPLACE INTO discovery_pages(run_id,scope,page,item_count) VALUES (?,?,?,?)",
              params.runId,
              login,
              page,
              repositories.length,
            )
            .run();
        });
        const recorded = await store.one<{ item_count: number }>(
          "SELECT item_count FROM discovery_pages WHERE run_id=? AND scope=? AND page=?",
          params.runId,
          login,
          page,
        );
        if (!recorded)
          throw new Error("Repository discovery checkpoint is missing.");
        if (recorded.item_count < 100) break;
      }
    }
  }
  for (const name of config.includeRepositories) {
    await steps.do(`include ${name}`, async () => {
      const repository = await clientForRepository(
        name,
      ).github<GitHubRepository>(`/repos/${name}`);
      if (repository.private)
        throw new Error("Configured repository is not public.");
      await store.discover(
        params.runId,
        null,
        included(repository) ? [repository] : [],
      );
    });
  }

  for (const original of await store.repositories(params.runId)) {
    const label = `repository ${original.repository_id}`;
    const repositoryClient = clientForRepository(original.full_name);
    await steps.do(`${label} pin and plan`, async () => {
      const repo = await store.repository(params.runId, original.repository_id);
      if (repo.status !== "pending") return;
      const metadata = await readMetadata(repositoryClient, repo);
      const previous = await store.syncState(repo.repository_id);
      let mode: "full" | "incremental" | "reuse" = "full";
      let comparison: Comparison | null = null;
      if (previous && previous.default_branch === metadata.defaultBranch) {
        if (previous.head_sha === metadata.head) {
          mode = "reuse";
        } else if (previous.head_sha && metadata.head) {
          comparison = await readComparison(
            repositoryClient,
            metadata.name,
            previous.head_sha,
            metadata.head,
            1,
          );
          if (comparisonIsForward(comparison)) mode = "incremental";
          else
            console.warn(
              `${label}: history changed; rebuilding all reachable commits.`,
            );
        }
      }
      await store.plan(repo, metadata, mode, previous, comparison);
    });
    let repo = await store.repository(params.runId, original.repository_id);
    if (repo.status === "complete") continue;
    if (repo.sync_mode === "full" && repo.head_sha) {
      for (let page = 1; ; page += 1) {
        await steps.do(`${label} history page ${page}`, async () => {
          const current = await store.repository(
            params.runId,
            original.repository_id,
          );
          if (current.compare_page > page) return;
          if (!current.head_sha) throw new Error("Pinned head is missing.");
          const history = await readHistory(
            repositoryClient,
            current.full_name,
            current.head_sha,
            current.history_cursor,
          );
          await store.savePage(
            current,
            history.nodes,
            history.nodes.map((commit) => commit.oid),
            hashEmail,
            {
              cursor: history.pageInfo.hasNextPage
                ? history.pageInfo.endCursor
                : null,
              comparePage: page + 1,
              expected: history.pageInfo.hasNextPage ? null : 0,
              received: current.received_commits + history.nodes.length,
            },
          );
        });
        repo = await store.repository(params.runId, original.repository_id);
        if (repo.expected_commits === 0) break;
      }
    } else if (repo.sync_mode === "incremental") {
      for (let page = 1; ; page += 1) {
        await steps.do(`${label} comparison page ${page}`, async () => {
          const current = await store.repository(
            params.runId,
            original.repository_id,
          );
          if (current.compare_page > page) return;
          if (!current.base_sha || !current.head_sha)
            throw new Error("Comparison heads are missing.");
          const checkpoint =
            page === 1
              ? await store.one<{ payload_json: string }>(
                  "SELECT payload_json FROM discovery_pages WHERE run_id=? AND scope=? AND page=1",
                  params.runId,
                  `comparison:${current.repository_id}`,
                )
              : null;
          // Older runs have no saved planning response and still fetch page one.
          const comparison: Comparison | null = checkpoint
            ? (JSON.parse(checkpoint.payload_json) as Comparison)
            : await readComparison(
                repositoryClient,
                current.full_name,
                current.base_sha,
                current.head_sha,
                page,
              );
          if (
            !comparisonIsForward(comparison) ||
            (current.expected_commits !== null &&
              current.expected_commits !== comparison.total_commits)
          ) {
            throw new Error("Pinned comparison changed or became unavailable.");
          }
          const shas = comparison.commits.map((commit) => commit.sha);
          const duplicate = await store.one<{ count: number }>(
            "SELECT count(*) AS count FROM pending_history_commits WHERE run_id=? AND repository_id=? AND sha IN (SELECT value FROM json_each(?))",
            params.runId,
            current.repository_id,
            JSON.stringify(shas),
          );
          const received = current.received_commits + shas.length;
          if (
            new Set(shas).size !== shas.length ||
            duplicate?.count ||
            received > comparison.total_commits ||
            (received < comparison.total_commits && shas.length === 0)
          ) {
            throw new Error(
              "GitHub comparison pagination is incomplete or duplicated.",
            );
          }
          const missing = await store.missingCommits(
            current.repository_id,
            shas,
          );
          const commits = await readCommitDetails(
            repositoryClient,
            current.full_name,
            missing,
          );
          await store.savePage(current, commits, shas, hashEmail, {
            cursor: null,
            comparePage: page + 1,
            expected: comparison.total_commits,
            received,
          });
        });
        repo = await store.repository(params.runId, original.repository_id);
        if (repo.received_commits === repo.expected_commits) break;
      }
    }
    await steps.do(`${label} aggregate and advance watermark`, async () => {
      const current = await store.repository(
        params.runId,
        original.repository_id,
      );
      if (current.status !== "complete")
        await store.finishRepository(current, config, hashEmail);
    });
  }
  await steps.do("mark complete collection ready", async () => {
    await store.snapshot(params.runId);
    await store.ready(params.runId);
  });
  await steps.do("publish complete KV snapshot", async () => {
    if (!(await store.ownsRun(params.runId)))
      throw new Error("Publication lock was lost.");
    const snapshot = await store.snapshot(params.runId);
    await env.STATS.put("activity:v1", JSON.stringify(snapshot));
  });
  await steps.do("record publication and release lock", async () => {
    await store.published(params.runId);
  });
}
