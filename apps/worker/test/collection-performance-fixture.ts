import { vi } from "vitest";
import { CollectionStore } from "../src/collection-store.js";
import { parseConfig } from "../src/collection-config.js";
import { runCollection, type CollectionSteps } from "../src/collection.js";
import type { Bindings } from "../src/env.js";
import type { GitHubRepository, RawCommit } from "../src/collection-github.js";
import { TestD1 } from "./d1.js";

export const cutoff = "2026-11-12T12:00:00.000Z";
export const fixtureUser = "00000000-0000-4000-8000-000000000001";
const secret = "synthetic-performance-secret-not-a-real-credential";
const owner = { id: 100, login: "perf-owner", type: "Organization" };
const sha = (index: number) => index.toString(16).padStart(40, "0");

export function replaySteps(): CollectionSteps {
  const completed = new Set<string>();
  return {
    async do(name, callback) {
      if (completed.has(name)) return;
      await callback();
      completed.add(name);
    },
  };
}

export async function performanceFixture(size = 70, initialize = true) {
  const db = new TestD1();
  const store = new CollectionStore(db, fixtureUser);
  db.sqlite.exec(`
    INSERT INTO personal_users VALUES ('${fixtureUser}','active','2026-01-01',NULL,NULL);
    INSERT INTO personal_identities VALUES ('github','100','${fixtureUser}');
    INSERT INTO personal_state(id) VALUES ('${fixtureUser}');
    INSERT INTO collection_configs(id) VALUES ('${fixtureUser}');
  `);
  const revisionId = await store.saveConfig(
    parseConfig({
      enabled: true,
      accounts: [owner.login],
      authorLogins: ["fixture-author"],
      authorEmails: ["fixture-author@example.invalid"],
      repositoryMode: "all_owned_public",
      includeRepositories: [],
      excludeRepositories: [],
    }),
  );
  const env: Bindings = {
    APP_NAME: "Workforce",
    AUTH_SECRET: secret,
    DB: db,
    GH_TOKEN: "synthetic-github-token",
    COLLECTION_EMAIL_KEY: secret,
    ASSETS: { fetch: vi.fn(), connect: vi.fn() },
    STATS: {
      put: vi.fn(),
      get: vi.fn(),
      getWithMetadata: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    },
  };
  const repositories: GitHubRepository[] = Array.from(
    { length: size },
    (_, index) => ({
      id: index + 1000,
      full_name: `${owner.login}/repository-${index}`,
      private: false,
      owner,
    }),
  );
  const commits: RawCommit[] = [
    0, 1, 23, 24, 24.000001, 48, 696, 720, 744, 8736, 8760, 8784,
  ].map((hours, index) => ({
    oid: sha(index + 10),
    committedDate: new Date(
      Date.parse(cutoff) - hours * 3_600_000,
    ).toISOString(),
    additions: index + 1,
    deletions: index,
    author: {
      email:
        index % 3 === 0
          ? "fixture-author@example.invalid"
          : "unmatched@example.invalid",
      user: { login: index % 3 === 1 ? "fixture-author" : "unmatched" },
    },
  }));
  const request = (changed = false) =>
    vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith(`/users/${owner.login}`))
        return Promise.resolve(Response.json(owner));
      if (url.includes(`/orgs/${owner.login}/repos`))
        return Promise.resolve(Response.json(repositories));
      const changedCommits = (name: string) =>
        Array.from(
          { length: name.endsWith(`-${size - 1}`) ? 6 : 7 },
          (_, index) => ({
            ...commits[0]!,
            oid: sha(index + 100),
          }),
        );
      if (url.includes("/compare/")) {
        const values = changedCommits(url.split("/compare/")[0] ?? "");
        return Promise.resolve(
          Response.json({
            status: "ahead",
            total_commits: values.length,
            ahead_by: values.length,
            commits: values.map((value) => ({ sha: value.oid })),
          }),
        );
      }
      if (typeof init?.body !== "string")
        throw new Error("Missing synthetic request body.");
      const body = JSON.parse(init.body) as {
        query: string;
        variables: Record<string, string>;
      };
      const metadata = (name: string) => {
        const repo = repositories.find(
          (repo) => repo.full_name === `${owner.login}/${name}`,
        );
        if (!repo) throw new Error("Missing synthetic repository.");
        const hasChanged =
          changed &&
          (name.endsWith(`-${size - 1}`) || name.endsWith(`-${size - 2}`));
        return {
          databaseId: repo.id,
          isPrivate: false,
          nameWithOwner: repo.full_name,
          url: `https://github.com/${repo.full_name}`,
          description: null,
          isFork: true,
          isArchived: false,
          defaultBranchRef: {
            name: "main",
            target: {
              oid: sha(hasChanged ? 2 : 1),
              committedDate: cutoff,
              messageHeadline: "Synthetic fixture",
              url: `https://github.com/${repo.full_name}/commit/${sha(1)}`,
            },
          },
        };
      };
      if (body.query.includes("query MetadataBatch"))
        return Promise.resolve(
          Response.json({
            data: Object.fromEntries(
              Object.entries(body.variables)
                .filter(([name]) => name.startsWith("name"))
                .map(([name, value]) => [`r${name.slice(4)}`, metadata(value)]),
            ),
          }),
        );
      if (body.query.includes("query Metadata"))
        return Promise.resolve(
          Response.json({
            data: { repository: metadata(body.variables.name ?? "") },
          }),
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
      if (body.query.includes("query CommitDetails"))
        return Promise.resolve(
          Response.json({
            data: {
              repository: {
                isPrivate: false,
                ...Object.fromEntries(
                  changedCommits(body.variables.name ?? "").map(
                    (value, index) => [`c${index}`, value],
                  ),
                ),
              },
            },
          }),
        );
      throw new Error("Unexpected synthetic GitHub request.");
    });
  const params = {
    userId: fixtureUser,
    revisionId,
    runId: "fixture-measured",
    until: cutoff,
  };
  if (initialize)
    await runCollection(
      env,
      { ...params, runId: "fixture-seed", until: "2026-11-11T12:00:00.000Z" },
      replaySteps(),
      request(),
    );
  db.resetCounts();
  return { db, store, env, params, request };
}
