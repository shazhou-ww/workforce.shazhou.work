import { createEmailHasher } from "./collection-config.js";
import {
  readAccount,
  readMetadata,
  readMetadataBatch,
  metadataBatchSize,
  readHistory,
  readComparison,
  readCommitDetails,
  type GitHubAccount,
  type GitHubRepository,
  type Comparison,
} from "./collection-github.js";
import { CollectionStore, type RunRepository } from "./collection-store.js";
import {
  createGitHubClient,
  createOwnerGitHubClient,
  createOrganizationGitHubClient,
  createPublicGitHubClient,
} from "./github-client.js";
import type { Bindings } from "./env.js";
import type { CollectionPhase } from "@shazhou-work/workforce-contracts";
import { assertPersonalActive } from "./platform.js";

export interface CollectionParams {
  readonly runId: string;
  readonly revisionId: string;
  readonly until: string;
  readonly userId?: string;
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
  const started = performance.now();
  const requests = { rest: 0, graphql: 0, httpErrors: 0, networkErrors: 0 };
  const metrics = env.DB ? new CollectionStore(env.DB, params.userId) : null;
  const phases: Record<string, { attempts: number; activeMs: number }> = {};
  let currentStep: string | null = null;
  let outcome: "failed" | "completed" = "failed";
  const measuredRequest: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const api = url.endsWith("/graphql") ? "graphql" : "rest";
    requests[api] += 1;
    const start = performance.now();
    let response: Response | undefined;
    try {
      response = await request(input, init);
      return response;
    } finally {
      if (!response) requests.networkErrors += 1;
      else if (!response.ok) requests.httpErrors += 1;
      console.info({
        event: "collection.github_request",
        runId: params.runId,
        step: currentStep,
        api,
        authenticated: new Headers(init?.headers).has("authorization"),
        status: response?.status ?? null,
        durationMs: performance.now() - start,
        rateLimit: {
          limit: rateLimitHeader(response, "x-ratelimit-limit"),
          remaining: rateLimitHeader(response, "x-ratelimit-remaining"),
          used: rateLimitHeader(response, "x-ratelimit-used"),
          reset: rateLimitHeader(response, "x-ratelimit-reset"),
        },
      });
    }
  };
  const measuredSteps: CollectionSteps = {
    do: (name, callback) =>
      steps.do(name, async () => {
        currentStep = name;
        const phase: CollectionPhase = name.startsWith("metadata ")
          ? "metadata"
          : name.includes("pin and plan")
            ? "planning"
            : name.includes("aggregate")
              ? "aggregation"
              : name.startsWith("repository ")
                ? "history"
                : name.includes("publication") ||
                    name.includes("snapshot") ||
                    name.includes("collection ready")
                  ? "publication"
                  : "discovery";
        const timing = (phases[phase] ??= { attempts: 0, activeMs: 0 });
        timing.attempts += 1;
        const start = performance.now();
        const before = { ...requests };
        const attemptId = crypto.randomUUID();
        let failure: unknown;
        let completed = false;
        try {
          if (params.userId) {
            await assertPersonalActive(env, params.userId);
            const existing = await metrics?.one<{ status: string }>(
              "SELECT status FROM collection_runs WHERE id=?",
              params.runId,
            );
            if (existing?.status === "cancelled")
              throw new Error("This personal run was cancelled.");
          }
          await callback();
          if (params.userId) await assertPersonalActive(env, params.userId);
          completed = true;
        } catch (error) {
          failure = error;
        }
        const activeMs = performance.now() - start;
        timing.activeMs += activeMs;
        currentStep = null;
        if (metrics) {
          try {
            await metrics.recordAttempt(params.runId, {
              id: attemptId,
              step: name,
              phase,
              finishedAt: new Date().toISOString(),
              activeMs,
              rest: requests.rest - before.rest,
              graphql: requests.graphql - before.graphql,
              httpErrors: requests.httpErrors - before.httpErrors,
              networkErrors: requests.networkErrors - before.networkErrors,
            });
          } catch (error) {
            console.error("Failed to persist collection performance.", error);
            if (!completed)
              throw new AggregateError(
                [failure, error],
                "Collection step and performance recording both failed.",
                { cause: error },
              );
            throw error;
          }
        }
        if (!completed) throw failure;
      }),
  };
  try {
    await collect(env, params, measuredSteps, measuredRequest);
    outcome = "completed";
  } finally {
    console.info({
      event: "collection.invocation",
      runId: params.runId,
      outcome,
      wallMs: performance.now() - started,
      requests,
      phases,
    });
  }
}

function rateLimitHeader(response: Response | undefined, name: string) {
  const value = response?.headers.get(name);
  if (!value) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function collect(
  env: Bindings,
  params: CollectionParams,
  steps: CollectionSteps,
  request: typeof fetch,
): Promise<void> {
  if (!env.DB)
    throw new Error("The collection D1 binding DB is not configured.");
  const store = new CollectionStore(env.DB, params.userId);
  if (params.userId) {
    await assertPersonalActive(env, params.userId);
    await store.config(params.revisionId);
  }
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

  const repositories = await store.repositories(params.runId);
  const byOwner = new Map<string, RunRepository[]>();
  for (const repository of repositories) {
    const owner = (repository.full_name.split("/")[0] ?? "").toLowerCase();
    const owned = byOwner.get(owner) ?? [];
    owned.push(repository);
    byOwner.set(owner, owned);
  }
  for (const [owner, owned] of byOwner) {
    for (let offset = 0; offset < owned.length; offset += metadataBatchSize) {
      const batch = owned.slice(offset, offset + metadataBatchSize);
      await steps.do(
        `metadata ${owner} batch ${offset / metadataBatchSize}`,
        async () => {
          const pending = await store.pendingMetadata(
            params.runId,
            batch.map((repository) => repository.repository_id),
          );
          const first = pending[0];
          if (!first) return;
          const metadata = await readMetadataBatch(
            clientForRepository(first.full_name),
            pending,
          );
          await store.saveMetadata(pending, metadata);
        },
      );
    }
  }
  for (const original of repositories) {
    const label = `repository ${original.repository_id}`;
    const repositoryClient = clientForRepository(original.full_name);
    await steps.do(`${label} pin and plan`, async () => {
      const repo = await store.repository(params.runId, original.repository_id);
      if (repo.status !== "pending") return;
      const metadata =
        (await store.metadata(params.runId, repo.repository_id)) ??
        (await readMetadata(repositoryClient, repo));
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
    await store.snapshot(params.runId, hashEmail);
    await store.ready(params.runId);
  });
  await steps.do("publish complete KV snapshot", async () => {
    if (!(await store.ownsRun(params.runId)))
      throw new Error("Publication lock was lost.");
    const snapshot = await store.snapshot(params.runId, hashEmail);
    if (params.userId) await store.publishPersonal(params.runId, snapshot);
    else await env.STATS.put("activity:v1", JSON.stringify(snapshot));
  });
  await steps.do("record publication and release lock", async () => {
    await store.published(params.runId);
  });
}
