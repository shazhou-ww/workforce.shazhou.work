import { afterEach, describe, expect, it, vi } from "vitest";
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

const until = "2026-11-09T04:00:00.000Z";
const key = "email-key-with-at-least-thirty-two-characters";
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
      return Promise.resolve(Response.json(repos));
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
      variables: { name: string };
    };
    const repo =
      repos.find((value) =>
        value.full_name.endsWith(`/${body.variables.name}`),
      ) ?? repository;
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
    expect((await store.snapshot(run.runId)).totals.commits).toBe(2);
    expect(JSON.stringify(await store.snapshot(run.runId))).not.toContain(
      "organization-test-token",
    );
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

  it("collects all history but publishes only the 30-day filtered window, without private identities", async () => {
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
    const snapshot = await store.snapshot(run.runId);
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
    expect((await store.snapshot(run.runId)).totals.commits).toBe(0);
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
    expect((await store.snapshot(run.runId)).totals.commits).toBe(3);
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
      expect((await store.snapshot(run.runId)).totals.commits).toBe(2);
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
      expect((await store.snapshot(run.runId)).totals.commits).toBe(1);
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
      (await first.store.snapshot(run.runId)).repositories[0],
    ).toMatchObject({ latestCommit: null, commits: 0 });
    const second = await setup();
    const next = params(second.revisionId);
    await runCollection(second.env, next, steps(), github({ repos: [] }));
    expect((await second.store.snapshot(next.runId)).repositories).toEqual([]);
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
    expect((await store.snapshot(run.runId)).totals.commits).toBe(2);
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
    expect((await store.snapshot(run.runId)).totals.commits).toBe(102);
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
    const base = github();
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
      if (bodyText(init).includes("Metadata")) {
        const body = JSON.parse(bodyText(init)) as {
          variables: { name: string };
        };
        return Promise.resolve(
          Response.json({
            data: {
              repository: metadata(
                sha(1),
                body.variables.name === "new"
                  ? { ...repository, id: 3, full_name: "owner/new" }
                  : repository,
              ),
            },
          }),
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
    expect((await store.snapshot(run.runId)).totals.commits).toBe(1);
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
    expect((await store.snapshot(run.runId)).accounts).toContain(
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
    expect((await store.snapshot(run.runId)).authorFilter?.login).toBe(
      "已配置邮箱",
    );
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
    await expect(store.snapshot(run.runId)).rejects.toThrow("incomplete");
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
