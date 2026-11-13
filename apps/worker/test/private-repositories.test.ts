import { encode } from "@auth/core/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityWindow,
  type PrivateActivityResponse,
} from "@shazhou-work/workforce-contracts";
import app from "../src/index.js";
import type { Bindings } from "../src/env.js";
import { CollectionStore } from "../src/collection-store.js";
import { registerIdentity, retainGitHub } from "../src/platform.js";
import {
  collectPrivateRepositories,
  disconnectPrivateRepositories,
  failPrivateCollection,
  privateState,
  readPrivateActivity,
  savePrivateRepositories,
  startPrivateCollection,
} from "../src/private-repositories.js";
import { publicSnapshotProjection } from "../src/public-activity.js";
import { runCollection } from "../src/collection.js";
import { TestD1 } from "./d1.js";

const secret = "private-repository-test-secret-more-than-32-characters";
const pat = "github_pat_test_fine_grained";
const origin = "https://example.test";
const selected = {
  id: 501,
  private: true,
  visibility: "private",
  full_name: "primary/secret",
};
const until = "2026-11-13T04:00:00.000Z";
const window = activityWindow(new Date(until));
const graphMetadata = {
  databaseId: 501,
  isPrivate: true,
  nameWithOwner: "primary/secret",
  url: "https://github.com/primary/secret",
  description: "secret description",
  isFork: false,
  isArchived: false,
  defaultBranchRef: {
    name: "main",
    target: {
      oid: "a".repeat(40),
      committedDate: until,
      messageHeadline: "secret message",
      url: `https://github.com/primary/secret/commit/${"a".repeat(40)}`,
    },
  },
};

async function fixture() {
  const db = new TestD1();
  const create = vi.fn().mockResolvedValue({});
  const put = vi.fn();
  const env = {
    DB: db,
    AUTH_SECRET: secret,
    COLLECTION: {
      create,
      get: vi.fn().mockResolvedValue({
        status: () => Promise.resolve({ status: "running" }),
      }),
    },
    STATS: { get: vi.fn().mockResolvedValue(null), put },
  } as unknown as Bindings;
  const store = new CollectionStore(db);
  const now = new Date().toISOString();
  await store
    .statement(
      "INSERT INTO invitations VALUES (?,?,'pending',NULL,?,?)",
      crypto.randomUUID(),
      "private@example.invalid",
      now,
      now,
    )
    .run();
  const userId = (await registerIdentity(env, "github", "101", [
    "private@example.invalid",
  ]))!;
  await retainGitHub(
    env,
    userId,
    {
      id: "101",
      login: "primary",
      avatarUrl: "",
    },
    "oauth-token",
    "read:user,user:email",
  );
  return { db, env, userId, store, create, put };
}

function github(
  options: {
    id?: number;
    private?: boolean;
    visibility?: string;
    repoId?: number;
    denied?: number;
    page?: number;
    empty?: boolean;
    repeatCursor?: boolean;
  } = {},
) {
  let page = 0;
  function respond(input: RequestInfo | URL, init?: RequestInit): Response {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${pat}`,
    );
    const url = input instanceof Request ? input.url : input.toString();
    if (options.denied)
      return new Response("denied", { status: options.denied });
    if (url.endsWith("/user")) return Response.json({ id: options.id ?? 101 });
    if (url.includes("/commits?")) return Response.json([]);
    if (url.endsWith("/repos/primary/secret"))
      return Response.json({
        ...selected,
        id: options.repoId ?? 501,
        private: options.private ?? true,
        visibility: options.visibility ?? "private",
      });
    if (url.endsWith("/graphql")) {
      if (typeof init?.body !== "string")
        throw new Error("Missing GraphQL request body.");
      const body = JSON.parse(init.body) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("Metadata"))
        return Response.json({
          data: {
            repository: options.empty
              ? { ...graphMetadata, defaultBranchRef: null }
              : graphMetadata,
          },
        });
      page += 1;
      expect(body.variables.since).toBe(
        activityWindow(new Date(until), 365).since,
      );
      return Response.json({
        data: {
          repository: {
            isPrivate: true,
            databaseId: 501,
            object: {
              history: {
                nodes: [
                  {
                    oid: `${page}`,
                    committedDate: until,
                    additions: 3,
                    deletions: 1,
                    author: {
                      user: { login: "primary" },
                      email: "private@example.invalid",
                    },
                  },
                  {
                    oid: "other",
                    committedDate: until,
                    additions: 999,
                    deletions: 999,
                    author: { user: { login: "someone-else" }, email: "" },
                  },
                ],
                pageInfo: {
                  hasNextPage: page < (options.page ?? 1),
                  endCursor: options.repeatCursor ? null : `page-${page}`,
                },
              },
            },
          },
        },
      });
    }
    throw new Error("Unexpected GitHub request.");
  }
  return vi
    .fn<typeof fetch>()
    .mockImplementation((input, init) => Promise.resolve(respond(input, init)));
}

async function cookie(userId: string) {
  const name = "__Secure-authjs.session-token";
  return `${name}=${await encode({ token: { sub: "101", platformUserId: userId }, secret, salt: name })}`;
}
async function call(
  env: Bindings,
  userId: string | null,
  method = "GET",
  body?: unknown,
  path = "/api/personal/private-repositories",
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(userId ? { Cookie: await cookie(userId) } : {}),
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}
async function connect(env: Bindings, userId: string) {
  await savePrivateRepositories(env, userId, {
    token: pat,
    repositories: ["primary/secret"],
  });
}
async function run(
  env: Bindings,
  userId: string,
  generation: string,
  runId: string,
) {
  await runCollection(
    env,
    {
      userId,
      runId,
      revisionId: generation,
      privateGeneration: generation,
      until,
    },
    {
      do: async (_name, callback) => callback(),
    },
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("isolated private repository statistics", () => {
  it("saves encrypted selected credentials, verifies identity and contents, and never returns a token", async () => {
    const { env, userId } = await fixture();
    const request = github();
    vi.stubGlobal("fetch", request);
    expect(
      (
        await call(env, userId, "PUT", {
          token: pat,
          repositories: ["PRIMARY/SECRET", "primary/secret"],
        })
      ).status,
    ).toBe(200);
    const stored = await privateState(env, userId);
    expect(stored?.credential).not.toContain(pat);
    expect(JSON.parse(stored!.repositories_json)).toEqual([
      { id: 501, name: "primary/secret" },
    ]);
    const result = await call(env, userId);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    const text = await result.text();
    expect(text).toContain("primary/secret");
    expect(text).not.toContain(pat);
    expect(text).not.toContain(stored!.credential);
    expect(
      request.mock.calls.some(([input]) =>
        (input instanceof Request ? input.url : input.toString()).includes(
          "/commits?",
        ),
      ),
    ).toBe(true);
    await savePrivateRepositories(env, userId, {
      repositories: ["primary/secret"],
    });
    expect((await privateState(env, userId))?.generation).not.toBe(
      stored?.generation,
    );
  });

  it.each([
    null,
    {},
    { token: "ghp_classic", repositories: ["primary/secret"] },
    { token: "oauth-token", repositories: ["primary/secret"] },
    { token: pat, repositories: [] },
    { token: pat, repositories: ["not-a-repository"] },
    {
      token: pat,
      repositories: Array.from({ length: 11 }, () => "primary/secret"),
    },
  ])(
    "rejects unsupported credentials and invalid selection: %j",
    async (input) => {
      const { env, userId } = await fixture();
      expect((await call(env, userId, "PUT", input)).status).toBe(422);
      expect(await privateState(env, userId)).toBeNull();
    },
  );

  it.each([
    { id: 202 },
    { private: false },
    { visibility: "internal" },
    { denied: 403 },
    { denied: 401 },
    { denied: 404 },
  ])(
    "fails closed for mismatched identity or inaccessible/private scope: %j",
    async (options) => {
      const { env, userId } = await fixture();
      vi.stubGlobal("fetch", github(options));
      expect(
        (
          await call(env, userId, "PUT", {
            token: pat,
            repositories: ["primary/secret"],
          })
        ).status,
      ).toBe(409);
      expect(await privateState(env, userId)).toBeNull();
    },
  );

  it("collects default-branch primary-author statistics without touching shared caches or public snapshots", async () => {
    const { env, userId, store, create, put } = await fixture();
    vi.stubGlobal("fetch", github({ page: 2 }));
    await connect(env, userId);
    const { runId } = await startPrivateCollection(env, userId);
    const state = (await privateState(env, userId))!;
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      params: { privateGeneration: state.generation },
    });
    await run(env, userId, state.generation, runId);
    const response = await readPrivateActivity(env, userId);
    expect(response.activeRunId).toBeNull();
    expect(response.snapshot?.totals).toEqual({
      commits: 2,
      additions: 6,
      deletions: 2,
      averageLines: 4,
    });
    expect(response.snapshot?.yearly).toHaveLength(365);
    expect(response.snapshot?.yearly?.at(-1)?.commits).toBe(2);
    expect(response.snapshot?.daily).toHaveLength(30);
    expect(response.snapshot?.repositories[0]?.name).toBe("primary/secret");
    for (const table of ["repositories", "commits", "collection_runs"])
      expect(await store.one(`SELECT count(*) AS count FROM ${table}`)).toEqual(
        { count: 0 },
      );
    expect(
      await store.one(
        "SELECT snapshot_json FROM personal_state WHERE id=?",
        userId,
      ),
    ).toEqual({ snapshot_json: null });
    expect(put).not.toHaveBeenCalled();
    expect(() => publicSnapshotProjection(response.snapshot)).toThrow(
      "Private statistics",
    );
    await expect(startPrivateCollection(env, userId)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("does not expose another user's private state, rejects anonymous requests and same-origin violations", async () => {
    const { env, userId, store } = await fixture();
    vi.stubGlobal("fetch", github());
    await connect(env, userId);
    expect((await call(env, null)).status).toBe(401);
    const otherId = crypto.randomUUID();
    await store
      .statement(
        "INSERT INTO personal_users(id,status,created_at) VALUES (?,'active',?)",
        otherId,
        until,
      )
      .run();
    const other = await call(env, otherId);
    expect(await other.json()).toMatchObject({
      connected: false,
      repositories: [],
      snapshot: null,
    });
    const crossOrigin = await app.request(
      `${origin}/api/personal/private-repositories`,
      {
        method: "DELETE",
        headers: { Cookie: await cookie(userId), Origin: "https://evil.test" },
      },
      env,
    );
    expect(crossOrigin.status).toBe(403);
    expect(await privateState(env, userId)).not.toBeNull();
  });

  it.each([
    { denied: 401 },
    { denied: 403 },
    { denied: 404 },
    { repoId: 999 },
    { private: false },
    { id: 999 },
  ])(
    "checks access fresh before reading stored results: %j",
    async (options) => {
      const { env, userId } = await fixture();
      vi.stubGlobal("fetch", github());
      await connect(env, userId);
      const { runId } = await startPrivateCollection(env, userId);
      const generation = (await privateState(env, userId))!.generation;
      await run(env, userId, generation, runId);
      vi.stubGlobal("fetch", github(options));
      const response = await call(env, userId);
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("secret description");
      await expect(startPrivateCollection(env, userId)).rejects.toMatchObject({
        code: "private_authorization_required",
      });
    },
  );

  it("disconnects and deletes old results; in-flight work cannot recreate deleted authorization", async () => {
    const { env, userId } = await fixture();
    vi.stubGlobal("fetch", github());
    await connect(env, userId);
    const { runId } = await startPrivateCollection(env, userId);
    const generation = (await privateState(env, userId))!.generation;
    await disconnectPrivateRepositories(env, userId);
    await expect(run(env, userId, generation, runId)).rejects.toMatchObject({
      code: "private_authorization_required",
    });
    await failPrivateCollection(env, userId, generation, runId);
    expect(await readPrivateActivity(env, userId)).toMatchObject({
      connected: false,
      snapshot: null,
    });
    expect((await call(env, userId, "DELETE")).status).toBe(200);
  });

  it("generation binding prevents replacement during collection from publishing or failing the new authorization", async () => {
    const { env, userId } = await fixture();
    const request = github();
    vi.stubGlobal("fetch", request);
    await connect(env, userId);
    const { runId } = await startPrivateCollection(env, userId);
    const old = (await privateState(env, userId))!;
    const replacement = github();
    let replaced = false;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await request(input, init);
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/graphql") && !replaced) {
          replaced = true;
          await savePrivateRepositories(
            env,
            userId,
            { token: pat, repositories: ["primary/secret"] },
            replacement,
          );
        }
        return response;
      },
    );
    await expect(run(env, userId, old.generation, runId)).rejects.toMatchObject(
      { code: "private_authorization_required" },
    );
    await failPrivateCollection(env, userId, old.generation, runId);
    const current = (await privateState(env, userId))!;
    expect(current.generation).not.toBe(old.generation);
    expect(current.snapshot_json).toBeNull();
    expect(current.error_message).toBeNull();
  });

  it("supports empty repositories and rejects malformed pagination without publishing partial data", async () => {
    const { env, userId } = await fixture();
    vi.stubGlobal("fetch", github({ empty: true }));
    await connect(env, userId);
    const { runId } = await startPrivateCollection(env, userId);
    const state = (await privateState(env, userId))!;
    await collectPrivateRepositories(
      env,
      {
        userId,
        runId,
        privateGeneration: state.generation,
        revisionId: state.generation,
        until,
      },
      {
        do: async (_name, callback) => callback(),
      },
    );
    expect(
      (await readPrivateActivity(env, userId)).snapshot?.totals.commits,
    ).toBe(0);
    await connect(env, userId);
    vi.stubGlobal("fetch", github({ page: 2, repeatCursor: true }));
    const next = await startPrivateCollection(env, userId);
    const generation = (await privateState(env, userId))!.generation;
    await expect(
      run(env, userId, generation, next.runId),
    ).rejects.toMatchObject({ code: "private_authorization_required" });
    await failPrivateCollection(env, userId, generation, next.runId);
    expect((await privateState(env, userId))?.snapshot_json).toBeNull();
  });

  it("handles unavailable workflows and creation failure without leaving a stuck reservation", async () => {
    const { env, userId, create } = await fixture();
    vi.stubGlobal("fetch", github());
    await expect(startPrivateCollection(env, userId)).rejects.toMatchObject({
      status: 409,
    });
    await connect(env, userId);
    const withoutWorkflow = { ...env };
    delete withoutWorkflow.COLLECTION;
    await expect(
      startPrivateCollection(withoutWorkflow, userId),
    ).rejects.toMatchObject({ status: 503 });
    create.mockRejectedValueOnce(new Error("not available"));
    expect(
      (
        await call(
          env,
          userId,
          "POST",
          undefined,
          "/api/personal/private-repositories/collection",
        )
      ).status,
    ).toBe(503);
    expect((await privateState(env, userId))?.active_run_id).toBeNull();
  });

  it("keeps opted-in public and legacy projections independent of private totals and metadata", async () => {
    const { env, userId, store } = await fixture();
    vi.stubGlobal("fetch", github());
    await connect(env, userId);
    const publicSnapshot = {
      version: 1,
      accounts: ["primary"],
      generatedAt: until,
      since: window.since,
      until,
      timezone: "Asia/Shanghai",
      days: 30,
      totals: { commits: 0, additions: 0, deletions: 0, averageLines: 0 },
      repositories: [],
      daily: window.dates.map((date) => ({
        date,
        commits: 0,
        additions: 0,
        deletions: 0,
        averageLines: 0,
      })),
      yearly: activityWindow(new Date(until), 365).dates.map((date) => ({
        date,
        commits: 0,
      })),
      rolling: [
        { at: until, commits: 0, additions: 0, deletions: 0, averageLines: 0 },
      ],
    };
    await store
      .statement(
        "UPDATE personal_users SET public_slug='primary' WHERE id=?",
        userId,
      )
      .run();
    await store
      .statement(
        "UPDATE personal_state SET snapshot_json=? WHERE id=?",
        JSON.stringify(publicSnapshot),
        userId,
      )
      .run();
    const { runId } = await startPrivateCollection(env, userId);
    await run(
      env,
      userId,
      (await privateState(env, userId))!.generation,
      runId,
    );
    const response = await call(
      env,
      null,
      "GET",
      undefined,
      "/api/profiles/primary",
    );
    const projection = await response.json<{
      snapshot: PrivateActivityResponse["snapshot"];
    }>();
    expect(projection.snapshot?.totals.commits).toBe(0);
    expect(projection.snapshot?.yearly?.every((day) => day.commits === 0)).toBe(
      true,
    );
    expect(projection.snapshot?.rolling?.[0]?.commits).toBe(0);
    expect(JSON.stringify(projection)).not.toContain("secret");
  });
});
