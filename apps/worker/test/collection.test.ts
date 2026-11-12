import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionStore } from "../src/collection-store.js";
import { createEmailHasher, parseConfig } from "../src/collection-config.js";
import {
  runCollection,
  type CollectionParams,
  type CollectionSteps,
} from "../src/collection.js";
import type { Bindings } from "../src/env.js";
import type { GitHubRepository, RawCommit } from "../src/collection-github.js";
import { TestD1 } from "./d1.js";
import { GitHubError } from "../src/github-client.js";
import { activityWindow } from "@shazhou-work/workforce-contracts";

const until = "2026-11-09T04:00:00.000Z";
const key = "email-key-with-at-least-thirty-two-characters";
const hashEmail = await createEmailHasher(key);
const baseConfig = {
  enabled: false,
  accounts: ["owner"],
  authorLogins: ["shazhou-ww"],
  authorEmails: ["author@example.test"],
  repositoryMode: "all_owned_public",
  includeRepositories: [],
  excludeRepositories: [],
};
const owner = { id: 1, login: "owner", type: "Organization" };
const repository: GitHubRepository = {
  id: 2,
  full_name: "owner/project",
  private: false,
  owner,
};
const sha = (index: number) => index.toString(16).padStart(40, "0");
const commit = (index: number, date = until): RawCommit => ({
  oid: sha(index),
  committedDate: date,
  additions: 10,
  deletions: 5,
  author: { email: "author@example.test", user: { login: "shazhou-ww" } },
});
const databases: TestD1[] = [];
const bodyText = (init?: RequestInit) =>
  typeof init?.body === "string" ? init.body : "";
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks();
});

function metadata(
  head = sha(1),
  repo = repository,
  branch: string | null = "main",
) {
  return {
    databaseId: repo.id,
    isPrivate: repo.private,
    nameWithOwner: repo.full_name,
    url: `https://github.com/${repo.full_name}`,
    description: null,
    isFork: true,
    isArchived: false,
    defaultBranchRef:
      branch === null
        ? null
        : {
            name: branch,
            target: {
              oid: head,
              committedDate: until,
              messageHeadline: "Latest by any author",
              url: `https://github.com/${repo.full_name}/commit/${head}`,
            },
          },
  };
}

function github({
  head = sha(1),
  commits = [commit(1)],
  repos = [repository],
  status = "ahead",
  comparisonShas = [sha(2)],
  branch = "main",
}: {
  head?: string;
  commits?: RawCommit[];
  repos?: GitHubRepository[];
  status?: string;
  comparisonShas?: string[];
  branch?: string | null;
} = {}) {
  return vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith("/users/owner")) {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Promise.resolve(Response.json(owner));
    }
    if (url.includes("/orgs/owner/repos"))
      return Promise.resolve(
        Response.json(
          repos.filter((repo) => repo.full_name.startsWith("owner/")),
        ),
      );
    if (url.includes("/compare/"))
      return Promise.resolve(
        Response.json({
          status,
          ahead_by: comparisonShas.length,
          total_commits: comparisonShas.length,
          commits: comparisonShas.map((value) => ({ sha: value })),
        }),
      );
    if (url.includes("/repos/"))
      return Promise.resolve(Response.json(repository));
    const body = JSON.parse(bodyText(init)) as {
      query: string;
      variables: { name: string; owner: string; [name: string]: string };
    };
    const repo =
      repos.find((value) =>
        value.full_name.endsWith(`/${body.variables.name}`),
      ) ?? repository;
    if (body.query.includes("query MetadataBatch")) {
      return Promise.resolve(
        Response.json({
          data: Object.fromEntries(
            Object.entries(body.variables)
              .filter(([key]) => key.startsWith("name"))
              .map(([key, name]) => {
                const repo = repos.find(
                  (value) =>
                    value.full_name === `${body.variables.owner}/${name}`,
                );
                if (!repo) throw new Error("Missing metadata fixture");
                return [`r${key.slice(4)}`, metadata(head, repo, branch)];
              }),
          ),
        }),
      );
    }
    if (body.query.includes("query Metadata"))
      return Promise.resolve(
        Response.json({ data: { repository: metadata(head, repo, branch) } }),
      );
    if (body.query.includes("query FullHistory"))
      return Promise.resolve(
        Response.json({
          data: {
            repository: {
              isPrivate: false,
              object: {
                history: {
                  nodes: commits,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    return Promise.resolve(
      Response.json({
        data: {
          repository: {
            isPrivate: false,
            ...Object.fromEntries(
              comparisonShas
                .filter((value) => body.query.includes(value))
                .map((value, index) => [
                  `c${index}`,
                  { ...commit(2, "2026-10-20T00:00:00Z"), oid: value },
                ]),
            ),
          },
        },
      }),
    );
  });
}

async function setup(config: unknown = baseConfig) {
  const db = new TestD1();
  databases.push(db);
  const store = new CollectionStore(db);
  const revisionId = await store.saveConfig(parseConfig(config));
  const put = vi.fn<KVNamespace["put"]>().mockResolvedValue();
  const env: Bindings = {
    APP_NAME: "Workforce",
    AUTH_SECRET: "test-auth-secret",
    ASSETS: {
      fetch: vi.fn<Fetcher["fetch"]>(),
      connect: vi.fn<Fetcher["connect"]>(),
    },
    DB: db,
    GH_TOKEN: "test-token",
    COLLECTION_EMAIL_KEY: key,
    STATS: {
      put,
      get: vi.fn(),
      getWithMetadata: vi.fn(),
      list: vi.fn(),
      delete: vi.fn<KVNamespace["delete"]>(),
    },
  };
  return { db, store, revisionId, put, env };
}

function steps(): CollectionSteps {
  const completed = new Set<string>();
  return {
    async do(name, callback) {
      if (!completed.has(name)) {
        await callback();
        completed.add(name);
      }
    },
  };
}

function params(
  revisionId: string,
  runId = crypto.randomUUID(),
): CollectionParams {
  return { revisionId, runId, until };
}

describe("D1 collection", () => {
  it("reduces 69 unchanged repositories from 69 metadata requests to 8 with identical snapshots", async () => {
    const { env, store, revisionId } = await setup({
      ...baseConfig,
      accounts: ["owner", "second"],
    });
    const second = { id: 1000, login: "second", type: "Organization" };
    const repos = [
      ...Array.from({ length: 68 }, (_, index) => ({
        ...repository,
        id: index + 2,
        full_name: `owner/project-${index}`,
      })),
      { ...repository, id: 1001, full_name: "second/project", owner: second },
    ];
    function request() {
      const base = github({ repos });
      return vi.fn<typeof fetch>().mockImplementation((input, init) => {
        if (typeof input === "string" && input.endsWith("/users/second"))
          return Promise.resolve(Response.json(second));
        if (typeof input === "string" && input.includes("/orgs/second/repos"))
          return Promise.resolve(
            Response.json(repos.filter((repo) => repo.owner.id === second.id)),
          );
        return base(input, init);
      });
    }
    const scoped = {
      ...env,
      GH_TOKEN_OWNER: "owner-token",
      GH_TOKEN_SECOND: "second-token",
    };
    await runCollection(scoped, params(revisionId), steps(), request());
    const baseline = params(revisionId);
    const before = request();
    await runCollection(
      scoped,
      baseline,
      {
        do: async (name, callback) => {
          if (!name.startsWith("metadata ")) await callback();
        },
      },
      before,
    );
    const optimized = params(revisionId);
    const after = request();
    await runCollection(scoped, optimized, steps(), after);
    const metadataCalls = (calls: typeof after.mock.calls) =>
      calls.filter(([, init]) => bodyText(init).includes("query Metadata"));
    expect(metadataCalls(before.mock.calls)).toHaveLength(69);
    expect(metadataCalls(after.mock.calls)).toHaveLength(8);
    expect(after).toHaveBeenCalledTimes(10);
    for (const [, init] of metadataCalls(after.mock.calls)) {
      const body = JSON.parse(bodyText(init)) as {
        variables: { owner: string };
      };
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${body.variables.owner === "owner" ? "owner-token" : "second-token"}`,
      );
    }
    const oldSnapshot = await store.snapshot(baseline.runId, hashEmail);
    const newSnapshot = await store.snapshot(optimized.runId, hashEmail);
    expect({ ...newSnapshot, generatedAt: oldSnapshot.generatedAt }).toEqual(
      oldSnapshot,
    );
    expect(await store.performance(optimized.runId, true)).toMatchObject({
      restRequests: 2,
      graphqlRequests: 8,
      httpErrors: 0,
      networkErrors: 0,
    });
    expect(
      (await store.repositories(optimized.runId)).every(
        (repo) => repo.sync_mode === "reuse",
      ),
    ).toBe(true);
    const summaries = vi
      .mocked(console.info)
      .mock.calls.map(([record]) => record as unknown);
    const activeMs: unknown = expect.any(Number);
    const phases: unknown = expect.objectContaining({
      metadata: { attempts: 8, activeMs },
    });
    expect(summaries).toContainEqual(
      expect.objectContaining({
        event: "collection.invocation",
        runId: optimized.runId,
        requests: { graphql: 8, rest: 2, httpErrors: 0, networkErrors: 0 },
        phases,
      }),
    );
  });

  it("resumes atomically saved metadata without fetching changed heads again", async () => {
    const { env, store, revisionId } = await setup();
    const repos = [
      repository,
      { ...repository, id: 3, full_name: "owner/other" },
    ];
    const request = github({ repos });
    const checkpoint = steps();
    let interrupt = true;
    const durable: CollectionSteps = {
      do: (name, callback) =>
        checkpoint.do(name, async () => {
          await callback();
          if (name.startsWith("metadata ") && interrupt) {
            interrupt = false;
            throw new Error("Interrupted after metadata write");
          }
        }),
    };
    const run = params(revisionId);
    await expect(runCollection(env, run, durable, request)).rejects.toThrow(
      "metadata write",
    );
    expect(await store.pendingMetadata(run.runId, [2, 3])).toEqual([]);
    const changed = github({ repos, head: sha(2) });
    await runCollection(env, run, steps(), changed);
    expect(
      changed.mock.calls.some(([, init]) =>
        bodyText(init).includes("Metadata"),
      ),
    ).toBe(false);
    expect(
      (await store.repositories(run.runId)).map((repo) => repo.head_sha),
    ).toEqual([sha(1), sha(1)]);
    expect((await store.run(run.runId)).status).toBe("published");
    expect(await store.performance(run.runId, true)).toMatchObject({
      graphqlRequests: 3,
    });
    await expect(
      store.saveMetadata(await store.repositories(run.runId), []),
    ).rejects.toThrow("every repository");
  });

  it.each([null, "private", "replaced"])(
    "rejects an invalid metadata alias (%s) without checkpointing partial results or publishing",
    async (invalid) => {
      const { env, store, revisionId, put } = await setup();
      const repos = [
        repository,
        { ...repository, id: 3, full_name: "owner/other" },
      ];
      await runCollection(env, params(revisionId), steps(), github({ repos }));
      const base = github({ repos });
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation((input, init) => {
          if (bodyText(init).includes("MetadataBatch")) {
            return Promise.resolve(
              Response.json({
                data: {
                  r0: metadata(),
                  r1:
                    invalid === null
                      ? null
                      : {
                          ...metadata(sha(1), repos[1]),
                          isPrivate: invalid === "private",
                          databaseId: invalid === "replaced" ? 99 : 3,
                        },
                },
              }),
            );
          }
          return base(input, init);
        });
      const run = params(revisionId);
      await expect(runCollection(env, run, steps(), request)).rejects.toThrow(
        "Repository",
      );
      expect(await store.pendingMetadata(run.runId, [2, 3])).toHaveLength(2);
      expect(put).toHaveBeenCalledOnce();
      expect(await store.ownsRun(run.runId)).toBe(true);
    },
  );

  it("records each rate-limited attempt and numeric headers without logging secrets", async () => {
    const { env, revisionId } = await setup();
    const base = github();
    let limited = true;
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (typeof input === "string" && input.includes("/orgs/owner/repos")) {
        if (limited) {
          limited = false;
          return Promise.resolve(
            Response.json(
              { message: "rate limit exceeded" },
              {
                status: 429,
                headers: {
                  "x-ratelimit-limit": "60",
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-used": "60",
                  "x-ratelimit-reset": "2000000000",
                },
              },
            ),
          );
        }
        return Promise.resolve(
          Response.json([repository], {
            headers: { "x-ratelimit-limit": "private-response-text" },
          }),
        );
      }
      return base(input, init);
    });
    const retry: CollectionSteps = {
      async do(_name, callback) {
        try {
          await callback();
        } catch (error) {
          if (!(error instanceof GitHubError) || error.retryAt === null)
            throw error;
          await callback();
        }
      },
    };
    const run = params(revisionId);
    await runCollection(env, run, retry, request);
    const records = vi
      .mocked(console.info)
      .mock.calls.map(([record]) => record as unknown);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "collection.github_request",
        status: 429,
        api: "rest",
        authenticated: false,
        rateLimit: { limit: 60, remaining: 0, used: 60, reset: 2000000000 },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "collection.github_request",
        status: 200,
        rateLimit: { limit: null, remaining: null, used: null, reset: null },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "collection.invocation",
        outcome: "completed",
        requests: { rest: 3, graphql: 2, httpErrors: 1, networkErrors: 0 },
      }),
    );
    const logged = JSON.stringify(records);
    expect(logged).not.toContain("private-response-text");
    expect(logged).not.toContain("test-token");
    expect(logged).not.toContain("author@example.test");
    expect(logged).not.toContain("Authorization");
  });

  it("reports network failures and callback timing while preserving the error", async () => {
    const { env, revisionId } = await setup();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));
    const run = params(revisionId);
    await expect(runCollection(env, run, steps(), request)).rejects.toThrow(
      "network unavailable",
    );
    const activeMs: unknown = expect.any(Number);
    const phases: unknown = expect.objectContaining({
      discovery: { attempts: 1, activeMs },
    });

    expect(
      vi.mocked(console.info).mock.calls.map(([record]) => record as unknown),
    ).toContainEqual(
      expect.objectContaining({
        event: "collection.invocation",
        outcome: "failed",
        requests: { rest: 1, graphql: 0, httpErrors: 0, networkErrors: 1 },
        phases,
      }),
    );
  });

  it("surfaces metric persistence errors without hiding a simultaneous collection failure", async () => {
    const { env, store, revisionId } = await setup();
    const record = store.recordAttempt.bind(store);
    vi.spyOn(CollectionStore.prototype, "recordAttempt").mockImplementation(
      (runId, attempt) =>
        attempt.step.startsWith("resolve account")
          ? Promise.reject(new Error("metrics unavailable"))
          : record(runId, attempt),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));
    const run = params(revisionId);
    await expect(
      runCollection(env, run, steps(), request),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "network unavailable" }),
        expect.objectContaining({ message: "metrics unavailable" }),
      ],
    });
  });

  it("uses the owner's credential for discovery, metadata, full history, comparisons and missing commit details", async () => {
    const { env, store, revisionId } = await setup();
    const scoped: Bindings = {
      ...env,
      GH_TOKEN_OWNER: "organization-test-token",
    };
    const first = github();
    await runCollection(scoped, params(revisionId), steps(), first);
    const second = github({ head: sha(2), comparisonShas: [sha(2)] });
    const run = params(revisionId);
    await runCollection(scoped, run, steps(), second);
    const calls = [...first.mock.calls, ...second.mock.calls].filter(
      ([input]) =>
        typeof input === "string" &&
        (input.endsWith("/graphql") ||
          input.includes("/compare/") ||
          input.includes("/orgs/owner/repos")),
    );
    expect(calls.length).toBeGreaterThan(4);
    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer organization-test-token",
      );
    }
    expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(2);
    expect(
      JSON.stringify(await store.snapshot(run.runId, hashEmail)),
    ).not.toContain("organization-test-token");
  });

  it("uses the owner's credential for explicit inclusion and exclusion lookups", async () => {
    const { env, revisionId } = await setup({
      ...baseConfig,
      repositoryMode: "explicit",
      includeRepositories: ["owner/project"],
      excludeRepositories: ["owner/excluded"],
    });
    const request = github();
    await runCollection(
      { ...env, GH_TOKEN_OWNER: "organization-test-token" },
      params(revisionId),
      steps(),
      request,
    );
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer organization-test-token",
      );
    }
  });

  it("collects all history with 30-day metrics, without private identities", async () => {
    const { env, store, revisionId, put } = await setup();
    const request = github({
      commits: [
        commit(1),
        commit(1),
        commit(3, "2020-01-01T00:00:00Z"),
        {
          ...commit(4),
          author: { email: "other@example.test", user: { login: "upstream" } },
        },
        { ...commit(5), author: null },
        { ...commit(6), author: { email: "AUTHOR@example.test", user: null } },
        commit(7, "2026-11-10T00:00:00Z"),
      ],
    });

    const run = params(revisionId);
    await runCollection(env, run, steps(), request);
    expect((await store.rows("SELECT * FROM commits")).length).toBe(6);
    expect((await store.rows("SELECT * FROM history_commits")).length).toBe(6);
    const snapshot = await store.snapshot(run.runId, hashEmail);
    expect(snapshot.daily).toHaveLength(30);
    expect(snapshot.totals).toEqual({
      commits: 2,
      additions: 20,
      deletions: 10,
      averageLines: 15,
    });
    expect(snapshot.repositories[0]?.latestCommit?.message).toBe(
      "Latest by any author",
    );
    expect(JSON.stringify(snapshot)).not.toContain("@example.test");
    expect(
      JSON.stringify(await store.rows("SELECT * FROM commits")),
    ).not.toContain("@example.test");
    expect(put).toHaveBeenCalledOnce();
    expect((await store.run(run.runId)).status).toBe("published");
    expect(await store.ownsRun(run.runId)).toBe(false);
    const historyBody = request.mock.calls.find((call) =>
      bodyText(call[1]).includes("FullHistory"),
    )?.[1]?.body;
    expect(historyBody).not.toContain("since");
    expect(historyBody).not.toContain("until");
  });

  it("aggregates a complete filtered year from cached reachable history without expanding 30-day totals", async () => {
    const { env, store, revisionId } = await setup();
    const year = activityWindow(new Date(until), 365);
    const first = commit(1, year.since);
    const run = params(revisionId);
    await runCollection(
      env,
      run,
      steps(),
      github({
        repos: [repository, { ...repository, id: 3, full_name: "owner/fork" }],
        commits: [
          first,
          first,
          commit(2, new Date(Date.parse(year.since) - 1).toISOString()),
          commit(3, "2026-03-01T16:00:00Z"),
          commit(4),
          commit(5, new Date(Date.parse(until) + 1).toISOString()),
          {
            ...commit(6, "2026-04-01T00:00:00Z"),
            author: {
              email: "other@example.test",
              user: { login: "upstream" },
            },
          },
          {
            ...commit(7, "2026-06-01T16:00:00Z"),
            author: { email: "AUTHOR@example.test", user: null },
          },
          {
            ...commit(8, "2026-03-01T16:00:00Z"),
            author: {
              email: "other@example.test",
              user: { login: "SHAZHOU-WW" },
            },
          },
          { ...commit(9), author: null },
        ],
      }),
    );
    const snapshot = await store.snapshot(run.runId, hashEmail);
    expect(snapshot.daily).toHaveLength(30);
    expect(snapshot.totals.commits).toBe(2);
    expect(snapshot.yearly).toHaveLength(365);
    expect(snapshot.yearly?.[0]).toEqual({ date: year.dates[0], commits: 2 });
    expect(
      snapshot.yearly?.find((day) => day.date === "2026-03-02")?.commits,
    ).toBe(4);
    expect(
      snapshot.yearly?.find((day) => day.date === "2026-06-02")?.commits,
    ).toBe(2);
    expect(snapshot.yearly?.at(-1)?.commits).toBe(2);
    expect(snapshot.yearly?.reduce((sum, day) => sum + day.commits, 0)).toBe(
      10,
    );
    expect(snapshot.yearly?.[1]?.commits).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain("@example.test");
  });

  it("reuses an unchanged head and re-filters cached history for a new configuration", async () => {
    const { env, store, revisionId, put } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    const next = await store.saveConfig(
      parseConfig({
        ...baseConfig,
        authorLogins: ["another-user"],
        authorEmails: [],
      }),
    );
    const request = github();
    const run = params(next);
    await runCollection(env, run, steps(), request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.some((call) =>
        bodyText(call[1]).includes("FullHistory"),
      ),
    ).toBe(false);
    expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(0);
    expect((await store.rows("SELECT * FROM commits")).length).toBe(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect((await store.config(revisionId)).authorEmails).toEqual([
      "author@example.test",
    ]);
  });

  it("adds only new commits, including backdated merged history, and supports shared SHAs in forks", async () => {
    const { env, store, revisionId } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    const request = github({
      head: sha(2),
      comparisonShas: [sha(1), sha(2)],
      repos: [repository, { ...repository, id: 3, full_name: "owner/fork" }],
    });
    const run = params(revisionId);
    await runCollection(env, run, steps(), request);
    expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(3);
    expect(
      (await store.rows("SELECT * FROM commits WHERE repository_id=2")).length,
    ).toBe(2);
    const details = request.mock.calls.find((call) =>
      bodyText(call[1]).includes("CommitDetails"),
    );
    expect(details?.[1]?.body).not.toContain(sha(1));
    expect(
      (await store.repositories(run.runId)).map((repo) => repo.sync_mode),
    ).toEqual(["incremental", "full"]);
    expect(
      request.mock.calls.filter(
        ([input]) => typeof input === "string" && input.includes("/compare/"),
      ),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "resumes the planning checkpoint with legacy fallback=%s",
    async (legacy) => {
      const { env, store, revisionId } = await setup();
      await runCollection(env, params(revisionId), steps(), github());
      const request = github({ head: sha(2) });
      const run = params(revisionId);
      const interrupted: CollectionSteps = {
        async do(name, callback) {
          if (name.endsWith("comparison page 1"))
            throw new Error("Interrupted before comparison");
          await callback();
        },
      };
      await expect(
        runCollection(env, run, interrupted, request),
      ).rejects.toThrow("Interrupted before comparison");
      if (legacy) {
        await store
          .statement(
            "DELETE FROM discovery_pages WHERE run_id=? AND scope=?",
            run.runId,
            "comparison:2",
          )
          .run();
      }
      await runCollection(env, run, steps(), request);
      expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(
        2,
      );
      expect(
        request.mock.calls.filter(
          ([input]) => typeof input === "string" && input.includes("/compare/"),
        ),
      ).toHaveLength(legacy ? 2 : 1);
    },
  );

  it.each(["diverged", "behind"])(
    "rebuilds reachable membership after %s, without deleting old commit records",
    async (status) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { env, store, revisionId } = await setup();
      await runCollection(env, params(revisionId), steps(), github());
      const run = params(revisionId);
      await runCollection(
        env,
        run,
        steps(),
        github({ head: sha(2), status, commits: [commit(2)] }),
      );
      expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(
        1,
      );
      expect((await store.rows("SELECT * FROM commits")).length).toBe(2);
      expect((await store.repositories(run.runId))[0]?.sync_mode).toBe("full");
    },
  );

  it("keeps failed incremental membership staged and never contaminates the old head", async () => {
    const { env, store, revisionId, put } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    const request = github({ head: sha(2) });
    const run = params(revisionId);
    const checkpoint = steps();
    const failing: CollectionSteps = {
      async do(name, callback) {
        if (name.endsWith("aggregate and advance watermark"))
          throw new Error("Interrupted");
        await checkpoint.do(name, callback);
      },
    };
    await expect(runCollection(env, run, failing, request)).rejects.toThrow(
      "Interrupted",
    );
    expect(await store.ownsRun(run.runId)).toBe(true);
    expect((await store.syncState(2))?.head_sha).toBe(sha(1));
    expect((await store.rows("SELECT * FROM history_commits")).length).toBe(1);
    expect(
      (await store.rows("SELECT * FROM pending_history_commits")).length,
    ).toBe(1);
    expect(put).toHaveBeenCalledOnce();
    await runCollection(env, run, checkpoint, request);
    expect((await store.syncState(2))?.head_sha).toBe(sha(2));
    expect(
      (await store.rows("SELECT * FROM pending_history_commits")).length,
    ).toBe(0);
  });

  it("retains the publication lock and ready data when KV fails, then retries safely", async () => {
    const { env, store, revisionId, put } = await setup();
    const run = params(revisionId);
    const checkpoint = steps();
    put.mockRejectedValueOnce(new Error("KV unavailable"));
    await expect(runCollection(env, run, checkpoint, github())).rejects.toThrow(
      "KV unavailable",
    );
    await store.failed(run.runId, "Publication failed.");
    expect((await store.run(run.runId)).status).toBe("ready");
    expect(await store.ownsRun(run.runId)).toBe(true);
    const second = params(revisionId);
    const request = github();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCollection(env, second, steps(), request);
    expect((await store.run(second.runId)).status).toBe("blocked");
    expect(request).not.toHaveBeenCalled();
    await runCollection(env, run, checkpoint, github());
    expect((await store.run(run.runId)).status).toBe("published");
    await runCollection(env, run, checkpoint, github());
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("handles empty repositories and an empty public account without fake commits", async () => {
    const first = await setup();
    const run = params(first.revisionId);
    await runCollection(first.env, run, steps(), github({ branch: null }));
    expect(
      (await first.store.snapshot(run.runId, hashEmail)).repositories[0],
    ).toMatchObject({ latestCommit: null, commits: 0 });
    const second = await setup();
    const next = params(second.revisionId);
    await runCollection(second.env, next, steps(), github({ repos: [] }));
    expect(
      (await second.store.snapshot(next.runId, hashEmail)).repositories,
    ).toEqual([]);
  });

  it("preserves a publication cutoff fence after cancelling an ambiguous KV write", async () => {
    const { env, store, revisionId, put } = await setup();
    const run = params(revisionId);
    put.mockRejectedValueOnce(new Error("KV write outcome unknown"));
    await expect(runCollection(env, run, steps(), github())).rejects.toThrow(
      "unknown",
    );
    await store.cancel(run.runId);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const older = { ...params(revisionId), until: "2026-11-08T00:00:00Z" };
    await runCollection(env, older, steps(), github());
    expect((await store.run(older.runId)).status).toBe("blocked");
    expect(put).toHaveBeenCalledOnce();
  });

  it("supports explicit scope, exclusion precedence and renamed repository exclusions", async () => {
    const { env, store, revisionId } = await setup({
      ...baseConfig,
      repositoryMode: "explicit",
      accounts: [],
      includeRepositories: ["owner/project"],
      excludeRepositories: ["owner/old-name"],
    });
    const run = params(revisionId);
    await runCollection(env, run, steps(), github());
    expect(await store.repositories(run.runId)).toEqual([]);
    const request = github();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects rotating the email key instead of silently losing email matches", async () => {
    const { env, store, revisionId } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    await expect(
      runCollection(
        { ...env, COLLECTION_EMAIL_KEY: `${key}-rotated` },
        params(revisionId),
        steps(),
        github(),
      ),
    ).rejects.toThrow("changed");
    const hash = await createEmailHasher(key);
    expect(await hash(" AUTHOR@example.test ")).toBe(
      await hash("author@example.test"),
    );
    expect(await hash("author@example.test")).toHaveLength(64);
    expect((await store.config(revisionId)).authorEmails).toEqual([
      "author@example.test",
    ]);
  });

  it("resumes a full-history page committed before the Workflow checkpoint without requesting it twice", async () => {
    const { env, store, revisionId } = await setup();
    const base = github();
    const historyCalls: (string | null)[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (!bodyText(init).includes("FullHistory")) return base(input, init);
      const body = JSON.parse(bodyText(init)) as {
        variables: { cursor: string | null };
      };
      historyCalls.push(body.variables.cursor);
      return Promise.resolve(
        Response.json({
          data: {
            repository: {
              isPrivate: false,
              object: {
                history: {
                  nodes: [commit(body.variables.cursor === null ? 1 : 2)],
                  pageInfo: {
                    hasNextPage: body.variables.cursor === null,
                    endCursor: body.variables.cursor === null ? "next" : null,
                  },
                },
              },
            },
          },
        }),
      );
    });
    const checkpoint = steps();
    let interrupt = true;
    const durable: CollectionSteps = {
      async do(name, callback) {
        await checkpoint.do(name, async () => {
          await callback();
          if (name.endsWith("history page 1") && interrupt) {
            interrupt = false;
            throw new Error("Checkpoint interrupted");
          }
        });
      },
    };
    const run = params(revisionId);
    await expect(runCollection(env, run, durable, request)).rejects.toThrow(
      "Checkpoint",
    );
    await runCollection(env, run, durable, request);
    expect(historyCalls).toEqual([null, "next"]);
    expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(2);
  });

  it("fully paginates comparisons beyond 100 commits and resumes a committed incremental page", async () => {
    const { env, store, revisionId } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    const ids = Array.from({ length: 101 }, (_, index) => sha(index + 2));
    const base = github({ head: sha(102), comparisonShas: ids });
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (typeof input === "string" && input.includes("/compare/")) {
        const page = new URL(input).searchParams.get("page");
        return Promise.resolve(
          Response.json({
            status: "ahead",
            ahead_by: 101,
            total_commits: 101,
            commits: (page === "2" ? ids.slice(100) : ids.slice(0, 100)).map(
              (value) => ({ sha: value }),
            ),
          }),
        );
      }
      return base(input, init);
    });
    const checkpoint = steps();
    let interrupt = true;
    const durable: CollectionSteps = {
      async do(name, callback) {
        await checkpoint.do(name, async () => {
          await callback();
          if (name.endsWith("comparison page 1") && interrupt) {
            interrupt = false;
            throw new Error("Checkpoint interrupted");
          }
        });
      },
    };
    const run = params(revisionId);
    await expect(runCollection(env, run, durable, request)).rejects.toThrow(
      "Checkpoint",
    );
    await runCollection(env, run, durable, request);
    expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(
      102,
    );
    expect((await store.rows("SELECT * FROM commits")).length).toBe(102);
    expect(
      request.mock.calls.flatMap(([input]) =>
        typeof input === "string" && input.includes("/compare/")
          ? [new URL(input).searchParams.get("page")]
          : [],
      ),
    ).toEqual(["1", "2"]);
  });

  it("keeps authenticated organization discovery public-only", async () => {
    const { env, store, revisionId } = await setup();
    const request = github({
      repos: [
        repository,
        { ...repository, id: 3, full_name: "owner/private", private: true },
      ],
    });
    const run = params(revisionId);
    await runCollection(
      { ...env, GH_TOKEN_OWNER: "organization-test-token" },
      run,
      steps(),
      request,
    );
    expect(
      (await store.repositories(run.runId)).map((repo) => repo.full_name),
    ).toEqual(["owner/project"]);
    const discovery = request.mock.calls.find(
      ([input]) =>
        typeof input === "string" && input.includes("/orgs/owner/repos"),
    );
    expect(discovery?.[0]).toContain("type=public");
    expect(new Headers(discovery?.[1]?.headers).has("Authorization")).toBe(
      true,
    );
  });

  it("discovers additional account pages without resetting existing repository watermarks", async () => {
    const { env, store, revisionId } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    const base = github({
      repos: [repository, { ...repository, id: 3, full_name: "owner/new" }],
    });
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (typeof input === "string" && input.includes("/orgs/owner/repos")) {
        return Promise.resolve(
          Response.json(
            new URL(input).searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, () => repository)
              : [{ ...repository, id: 3, full_name: "owner/new" }],
          ),
        );
      }
      return base(input, init);
    });
    const run = params(revisionId);
    await runCollection(env, run, steps(), request);
    expect(
      (await store.repositories(run.runId)).map((repo) => repo.sync_mode),
    ).toEqual(["reuse", "full"]);
  });

  it("rejects private explicit includes and missing collection credentials", async () => {
    const { env, revisionId } = await setup({
      ...baseConfig,
      repositoryMode: "explicit",
      includeRepositories: ["owner/project"],
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...repository, private: true }));
    await expect(
      runCollection(env, params(revisionId), steps(), request),
    ).rejects.toThrow("not public");
    const noDb = { ...env };
    delete noDb.DB;
    await expect(
      runCollection(noDb, params(revisionId), steps(), github()),
    ).rejects.toThrow("binding");
    await expect(
      runCollection(
        { ...env, GH_TOKEN: "" },
        params(revisionId),
        steps(),
        github(),
      ),
    ).rejects.toThrow("GH_TOKEN");
    await expect(
      runCollection(
        { ...env, COLLECTION_EMAIL_KEY: "" },
        params(revisionId),
        steps(),
        github(),
      ),
    ).rejects.toThrow("32");
  });

  it("initializes a new account's repositories from their earliest commits without resetting old repositories", async () => {
    const { env, store, revisionId } = await setup();
    await runCollection(env, params(revisionId), steps(), github());
    const nextRevision = await store.saveConfig(
      parseConfig({
        ...baseConfig,
        accounts: ["owner", "second"],
      }),
    );
    const second = { id: 4, login: "second", type: "User" };
    const newRepo = {
      ...repository,
      id: 5,
      full_name: "second/new",
      owner: second,
    };
    const base = github();
    const historyRequests = vi.fn();
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (typeof input === "string" && input.endsWith("/users/second")) {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Promise.resolve(Response.json(second));
      }
      if (typeof input === "string" && input.includes("/users/second/repos")) {
        return Promise.resolve(Response.json([newRepo]));
      }
      if (bodyText(init).includes("Metadata")) {
        const body = JSON.parse(bodyText(init)) as {
          variables: { owner: string };
        };
        if (body.variables.owner === "second") {
          return Promise.resolve(
            Response.json({ data: { repository: metadata(sha(3), newRepo) } }),
          );
        }
      }
      if (bodyText(init).includes("FullHistory")) {
        historyRequests();
        return Promise.resolve(
          Response.json({
            data: {
              repository: {
                isPrivate: false,
                object: {
                  history: {
                    nodes: [commit(3, "2000-01-01T00:00:00Z")],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
      }
      return base(input, init);
    });
    const run = params(nextRevision);
    await runCollection(env, run, steps(), request);
    expect(
      (await store.repositories(run.runId)).map((repo) => repo.sync_mode),
    ).toEqual(["reuse", "full"]);
    expect(
      await store.one("SELECT committed_at FROM commits WHERE repository_id=5"),
    ).toEqual({ committed_at: "2000-01-01T00:00:00.000Z" });
    expect(historyRequests).toHaveBeenCalledOnce();
    expect((await store.snapshot(run.runId, hashEmail)).totals.commits).toBe(1);
  });

  it("uses public account identities and unauthenticated public repository listing for an empty organization", async () => {
    const { env, store, revisionId } = await setup({
      ...baseConfig,
      accounts: ["owner", "silvermoon-work"],
    });
    const base = github();
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (
        typeof input === "string" &&
        input.includes("/users/silvermoon-work")
      ) {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Promise.resolve(
          Response.json({
            id: 354036529,
            login: "silvermoon-work",
            type: "Organization",
          }),
        );
      }
      if (
        typeof input === "string" &&
        input.includes("/orgs/silvermoon-work/repos")
      ) {
        expect(input).toContain("type=public");
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return Promise.resolve(Response.json([]));
      }
      return base(input, init);
    });
    const run = params(revisionId);
    await runCollection(env, run, steps(), request);
    expect((await store.run(run.runId)).status).toBe("published");
    expect((await store.snapshot(run.runId, hashEmail)).accounts).toContain(
      "silvermoon-work",
    );
  });
  it("rebuilds when the default branch changes and counts email-only configurations", async () => {
    const { env, store, revisionId } = await setup({
      ...baseConfig,
      authorLogins: [],
    });
    await runCollection(env, params(revisionId), steps(), github());
    const run = params(revisionId);
    await runCollection(
      env,
      run,
      steps(),
      github({ branch: "trunk", head: sha(2), commits: [commit(2)] }),
    );
    expect((await store.repositories(run.runId))[0]?.sync_mode).toBe("full");
    expect(
      (await store.snapshot(run.runId, hashEmail)).authorFilter?.login,
    ).toBe("已配置邮箱");
  });

  it("guards missing state, invalid pages and out-of-order publication", async () => {
    const { env, store, revisionId } = await setup();
    await expect(store.config("missing")).rejects.toThrow("revision");
    await expect(store.run("missing")).rejects.toThrow("does not exist");
    await expect(store.repository("missing", 2)).rejects.toThrow("outside");
    await expect(store.ready("missing")).rejects.toThrow("lock");
    expect(await store.missingCommits(2, [])).toEqual([]);
    const run = params(revisionId);
    await runCollection(env, run, steps(), github());
    const old = { ...params(revisionId), until: "2026-11-08T00:00:00Z" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCollection(env, old, steps(), github());
    expect((await store.run(old.runId)).status).toBe("blocked");
    expect(await store.begin(run.runId, revisionId, until, "anything")).toBe(
      false,
    );
    const repo = (await store.repositories(run.runId))[0];
    if (!repo) throw new Error("Missing test repository");
    await expect(
      store.plan(repo, metadataForStore(), "reuse", null),
    ).rejects.toThrow("history");
    await expect(
      store.finishRepository(
        { ...repo, history_id: null },
        parseConfig(baseConfig),
        () => Promise.resolve(""),
      ),
    ).rejects.toThrow("initialized");
    const next = { cursor: null, comparePage: 2, expected: 0, received: 1 };
    await expect(
      store.savePage(
        { ...repo, history_id: null },
        [],
        [],
        () => Promise.resolve(""),
        next,
      ),
    ).rejects.toThrow("initialized");
    await expect(
      store.savePage(
        repo,
        [{ ...commit(1), additions: -1 }],
        [],
        () => Promise.resolve(""),
        next,
      ),
    ).rejects.toThrow("invalid commit");
    await store
      .statement(
        "UPDATE run_repositories SET status='collecting' WHERE run_id=?",
        run.runId,
      )
      .run();
    await expect(store.snapshot(run.runId, hashEmail)).rejects.toThrow(
      "incomplete",
    );
    await store.statement("DELETE FROM collection_state").run();
    await expect(
      store.begin(crypto.randomUUID(), revisionId, until, "key"),
    ).rejects.toThrow("uninitialized");
    const emptyDatabase = new TestD1();
    databases.push(emptyDatabase);
    const emptyStore = new CollectionStore(emptyDatabase);
    await emptyStore.statement("DELETE FROM collection_configs").run();
    await expect(emptyStore.activeConfig()).rejects.toThrow("migrations");
  });

  it("fails explicitly if an account name resolves to repositories with a different owner ID", async () => {
    const { env, revisionId } = await setup();
    await expect(
      runCollection(
        env,
        params(revisionId),
        steps(),
        github({
          repos: [{ ...repository, owner: { ...owner, id: 99 } }],
        }),
      ),
    ).rejects.toThrow("owner identity changed");
  });
});

function metadataForStore() {
  return {
    name: repository.full_name,
    url: "https://github.com/owner/project",
    description: null,
    fork: false,
    archived: false,
    defaultBranch: "main",
    latestCommit: null,
    head: sha(1),
  };
}
