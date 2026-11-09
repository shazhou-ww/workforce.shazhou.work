import { encode, type JWT } from "@auth/core/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { createAuthConfig, collectionAdminIds } from "../src/auth.js";
import { CollectionStore } from "../src/collection-store.js";
import { parseConfig } from "../src/collection-config.js";
import { startCollection } from "../src/collection-api.js";
import type { Bindings } from "../src/env.js";
import type { CollectionParams } from "../src/collection.js";
import { TestD1 } from "./d1.js";

const secret = "authentication-test-secret-with-at-least-32-characters";
const administrator = "242885595";
const databases: TestD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks();
});

async function setup() {
  const db = new TestD1();
  databases.push(db);
  const store = new CollectionStore(db);
  const revisionId = await store.saveConfig(
    parseConfig({
      enabled: true,
      accounts: ["owner"],
      authorLogins: ["owner"],
      authorEmails: [],
      repositoryMode: "all_owned_public",
      includeRepositories: [],
      excludeRepositories: [],
    }),
  );
  const status = vi
    .fn<WorkflowInstance["status"]>()
    .mockResolvedValue({ status: "waiting" });
  const instance: WorkflowInstance = {
    id: "instance",
    status,
    restart: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    delete: vi.fn(),
    sendEvent: vi.fn(),
    subscribe: vi.fn(),
  };
  const create = vi
    .fn<Workflow<CollectionParams>["create"]>()
    .mockImplementation((options) => {
      instance.id = options?.id ?? "instance";
      return Promise.resolve(instance);
    });
  const env: Bindings = {
    APP_NAME: "Workforce",
    AUTH_SECRET: secret,
    AUTH_GITHUB_ID: "oauth-client",
    AUTH_GITHUB_SECRET: "oauth-client-secret",
    COLLECTION_ADMIN_GITHUB_IDS: administrator,
    COLLECTION_ADMIN_TOKEN:
      "management-token-with-at-least-thirty-two-characters",
    COLLECTION_EMAIL_KEY:
      "email-fingerprint-key-with-at-least-thirty-two-characters",
    GH_TOKEN: "github-collection-token",
    DB: db,
    ASSETS: {
      fetch: vi.fn<Fetcher["fetch"]>(),
      connect: vi.fn<Fetcher["connect"]>(),
    },
    STATS: {
      get: vi.fn(),
      put: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      getWithMetadata: vi.fn(),
    },
    COLLECTION: {
      create,
      get: vi.fn().mockResolvedValue(instance),
      createBatch: vi.fn(),
      deleteBatch: vi.fn(),
    },
  };
  async function cookie(token: JWT) {
    const name = "__Secure-authjs.session-token";
    return `${name}=${await encode({ token, secret, salt: name })}`;
  }
  const adminCookie = await cookie({
    sub: administrator,
    githubAccountId: administrator,
    name: "Administrator",
  });
  async function request(
    path = "",
    method = "GET",
    authCookie = "",
    origin: string | null = "https://example.test",
    bindings = env,
  ) {
    return app.request(
      `https://example.test/api/activity/collection${path}`,
      {
        method,
        headers: {
          Cookie: authCookie,
          ...(origin === null ? {} : { Origin: origin }),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      },
      bindings,
    );
  }
  return {
    db,
    store,
    env,
    create,
    status,
    cookie,
    adminCookie,
    request,
    revisionId,
  };
}

describe("manual collection session authorization", () => {
  it("retains task performance across reads, deduplicates recorded attempts, and exposes it only to administrators", async () => {
    const { request, store, revisionId, adminCookie, cookie } = await setup();
    await store.begin("measured", revisionId, "2026-11-09T08:00:00Z", "key");
    await store
      .statement(
        "UPDATE collection_runs SET started_at=? WHERE id=?",
        "2026-11-09T08:00:00.000Z",
        "measured",
      )
      .run();
    const attempt = {
      id: "attempt-1",
      step: "metadata owner batch 0",
      phase: "metadata" as const,
      finishedAt: "2026-11-09T08:00:01.000Z",
      activeMs: 10,
      rest: 0,
      graphql: 1,
      httpErrors: 0,
      networkErrors: 0,
    };
    await store.recordAttempt("measured", attempt);
    await store.recordAttempt("measured", attempt);
    await store.recordAttempt("measured", {
      ...attempt,
      id: "attempt-2",
      activeMs: 20,
      httpErrors: 1,
    });
    await store.recordAttempt("measured", {
      ...attempt,
      id: "attempt-3",
      step: "publish complete KV snapshot",
      phase: "publication",
      finishedAt: "2026-11-09T08:00:10.000Z",
      activeMs: 5,
      rest: 1,
      graphql: 0,
    });
    await store.startWait("measured", "metadata rate limit 0");
    await store.startWait("measured", "metadata rate limit 0");
    await store
      .statement(
        "UPDATE collection_waits SET started_at=?,finished_at=? WHERE run_id=?",
        "2026-11-09T08:00:02.000Z",
        "2026-11-09T08:00:05.000Z",
        "measured",
      )
      .run();
    await store.finishWait("measured", "metadata rate limit 0");
    await store
      .statement(
        "UPDATE collection_runs SET status='published',published_at=? WHERE id=?",
        "2026-11-09T08:00:10.000Z",
        "measured",
      )
      .run();
    const expected = {
      startedAt: "2026-11-09T08:00:00.000Z",
      updatedAt: "2026-11-09T08:00:10.000Z",
      elapsedMs: 10_000,
      activeMs: 35,
      restRequests: 1,
      graphqlRequests: 2,
      httpErrors: 1,
      networkErrors: 0,
      stepRetries: 1,
      rateLimitWaits: 1,
      rateLimitWaitMs: 3000,
      phases: [
        { phase: "metadata", attempts: 2, activeMs: 30 },
        { phase: "publication", attempts: 1, activeMs: 5 },
      ],
    };
    for (let read = 0; read < 2; read += 1) {
      expect(
        await (await request("/runs/measured", "GET", adminCookie)).json(),
      ).toMatchObject({ performance: expected });
    }
    expect(await (await request("", "GET", adminCookie)).json()).toMatchObject({
      latestRunId: "measured",
    });
    expect(
      await store.performance(
        "measured",
        false,
        Date.parse("2026-11-09T08:00:20Z"),
      ),
    ).toMatchObject({ elapsedMs: 20_000 });
    const visitor = await request("/runs/measured");
    expect(visitor.status).toBe(401);
    const other = await cookie({ sub: "999", githubAccountId: "999" });
    expect((await request("/runs/measured", "GET", other)).status).toBe(403);
    const publicAccess = await (await request()).json();
    expect(publicAccess).not.toHaveProperty("latestRunId");
    expect(publicAccess).not.toHaveProperty("performance");
    expect(JSON.stringify(expected)).not.toContain("token");
  });

  it("reports old runs without metrics explicitly and measures an ongoing wait", async () => {
    const { store, revisionId, request, adminCookie } = await setup();
    await store.begin("old", revisionId, "2026-11-09T08:00:00Z", "key");
    expect(
      await (await request("/runs/old", "GET", adminCookie)).json(),
    ).toMatchObject({ performance: null });
    await store
      .statement(
        "UPDATE collection_runs SET started_at=? WHERE id=?",
        "2026-11-09T08:00:00.000Z",
        "old",
      )
      .run();
    await store.recordAttempt("old", {
      id: "attempt",
      step: "discover owner page 1",
      phase: "discovery",
      finishedAt: "2026-11-09T08:00:01.000Z",
      activeMs: 1,
      rest: 1,
      graphql: 0,
      httpErrors: 1,
      networkErrors: 0,
    });
    await store.startWait("old", "wait");
    await store
      .statement(
        "UPDATE collection_waits SET started_at=? WHERE run_id=?",
        "2026-11-09T08:00:02.000Z",
        "old",
      )
      .run();
    expect(
      await store.performance("old", false, Date.parse("2026-11-09T08:00:07Z")),
    ).toMatchObject({ elapsedMs: 7000, rateLimitWaitMs: 5000 });
    await expect(store.performance("missing", false)).rejects.toThrow(
      "missing collection",
    );
  });

  it("keeps polling a live Workflow even when a replay previously marked the locked run failed", async () => {
    const { store, revisionId, request, adminCookie, status } = await setup();
    await store.begin("resuming", revisionId, "2026-11-09T08:00:00Z", "key");
    await store.failed("resuming", "Previous invocation interrupted");
    expect(
      await (await request("/runs/resuming", "GET", adminCookie)).json(),
    ).toMatchObject({
      status: "collecting",
      waiting: true,
    });
    status.mockResolvedValueOnce({ status: "queued" });
    expect(
      await (await request("/runs/resuming", "GET", adminCookie)).json(),
    ).toMatchObject({ status: "queued" });
    status.mockResolvedValueOnce({ status: "errored" });
    expect(
      await (await request("/runs/resuming", "GET", adminCookie)).json(),
    ).toMatchObject({ status: "failed" });
  });

  it("reports actual Workflow failures and pauses even before the persisted run state changes", async () => {
    const { request, store, revisionId, adminCookie, status } = await setup();
    await store.enqueue("pending", revisionId, "2026-11-09T08:00:00Z");
    status.mockResolvedValueOnce({ status: "errored" });
    expect(
      await (await request("/runs/pending", "GET", adminCookie)).json(),
    ).toMatchObject({ status: "failed" });
    status.mockResolvedValueOnce({ status: "terminated" });
    expect(
      await (await request("/runs/pending", "GET", adminCookie)).json(),
    ).toMatchObject({ status: "cancelled" });
    status.mockResolvedValueOnce({ status: "paused" });
    expect(
      await (await request("/runs/pending", "GET", adminCookie)).json(),
    ).toMatchObject({ waiting: true });
    status.mockResolvedValueOnce({ status: "waitingForPause" });
    expect(
      await (await request("/runs/pending", "GET", adminCookie)).json(),
    ).toMatchObject({ waiting: true });
  });

  it("skips duplicate scheduled deliveries without overwriting the queued record", async () => {
    const { env, create } = await setup();
    const time = Date.parse("2026-11-09T09:17:00Z");
    const enabled = { ...env, COLLECTION_ENABLED: "true" };
    expect(await startCollection(enabled, time)).not.toBeNull();
    expect(await startCollection(enabled, time)).toBeNull();
    expect(create).toHaveBeenCalledOnce();
  });

  it("reports login availability without revealing credentials to public visitors", async () => {
    const { request, env } = await setup();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      loginEnabled: true,
      signedIn: false,
      canCollect: false,
      displayName: null,
      activeRunId: null,
    });
    const noLogin = { ...env };
    delete noLogin.AUTH_GITHUB_ID;
    expect(
      await (await request("", "GET", "", null, noLogin)).json(),
    ).toMatchObject({ loginEnabled: false });
  });

  it("authorizes an encrypted GitHub identity and ignores untrusted profile names/emails", async () => {
    const { request, cookie, adminCookie, env } = await setup();
    expect(await (await request("", "GET", adminCookie)).json()).toMatchObject({
      signedIn: true,
      canCollect: true,
    });
    const other = await cookie({
      sub: "999",
      githubAccountId: "999",
      name: "shazhou-ww",
      email: "administrator@example.test",
    });
    expect((await request("", "POST", other)).status).toBe(403);
    const missingClaim = await cookie({
      sub: administrator,
      name: "Administrator",
    });
    expect((await request("", "POST", missingClaim)).status).toBe(403);
    expect(
      (
        await request("", "POST", adminCookie, "https://example.test", {
          ...env,
          COLLECTION_ADMIN_GITHUB_IDS: "999",
        })
      ).status,
    ).toBe(403);
    expect(await (await request("", "GET", other)).json()).toMatchObject({
      signedIn: true,
      canCollect: false,
    });
  });

  it("rejects anonymous, forged and cross-origin trigger requests before creating a Workflow", async () => {
    const { request, create, adminCookie } = await setup();
    expect((await request("", "POST")).status).toBe(401);
    expect((await request("", "POST", "forged-session-cookie")).status).toBe(
      401,
    );
    expect((await request("", "POST", adminCookie, null)).status).toBe(403);
    expect(
      (await request("", "POST", adminCookie, "https://attacker.test")).status,
    ).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("starts a real queued record, reports progress and does not weaken bearer management", async () => {
    const { request, adminCookie, store, env } = await setup();
    const started = await request("", "POST", adminCookie);
    expect(started.status).toBe(202);
    const { runId } = await started.json<{ runId: string }>();
    expect((await store.run(runId)).status).toBe("queued");
    const progress = await request(`/runs/${runId}`, "GET", adminCookie);
    expect(await progress.json()).toMatchObject({
      runId,
      status: "queued",
      waiting: true,
      completedRepositories: 0,
      totalRepositories: 0,
    });
    const manager = await app.request(
      "https://example.test/api/collection/config",
      { headers: { Cookie: adminCookie } },
      env,
    );
    expect(manager.status).toBe(401);
    expect((await request(`/runs/${runId}`)).status).toBe(401);
    expect((await request("/runs/missing", "GET", adminCookie)).status).toBe(
      404,
    );
  });

  it("exposes the active run to administrators and reports completed progress", async () => {
    const { request, store, revisionId, adminCookie, status } = await setup();
    await store.begin("active", revisionId, "2026-11-09T08:00:00Z", "key");
    await store.discover("active", { id: 1, login: "owner", type: "User" }, [
      {
        id: 2,
        full_name: "owner/project",
        private: false,
        owner: { id: 1, login: "owner", type: "User" },
      },
    ]);
    expect(await (await request("", "GET", adminCookie)).json()).toMatchObject({
      activeRunId: "active",
    });
    expect((await request("", "POST", adminCookie)).status).toBe(409);
    await store
      .statement(
        "UPDATE run_repositories SET status='complete' WHERE run_id='active'",
      )
      .run();
    await store.ready("active");
    await store.published("active");
    status.mockClear();
    expect(
      await (await request("/runs/active", "GET", adminCookie)).json(),
    ).toMatchObject({
      status: "published",
      completedRepositories: 1,
      totalRepositories: 1,
      waiting: false,
    });
    expect(status).not.toHaveBeenCalled();
  });

  it("surfaces missing bindings and Workflow creation failures explicitly", async () => {
    const { env, request, adminCookie, create, store } = await setup();
    const incomplete = { ...env };
    delete incomplete.COLLECTION;
    expect(
      (
        await request(
          "",
          "POST",
          adminCookie,
          "https://example.test",
          incomplete,
        )
      ).status,
    ).toBe(503);
    expect(
      (await request("/runs/id", "GET", adminCookie, null, incomplete)).status,
    ).toBe(503);
    create.mockRejectedValueOnce(new Error("Workflow unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await request("", "POST", adminCookie)).status).toBe(500);
    expect(log).toHaveBeenCalled();
    expect(await store.rows("SELECT status FROM collection_runs")).toEqual([
      { status: "failed" },
    ]);
  });

  it("rejects status access by signed-in non-administrators and respects the configured proxy origin", async () => {
    const { request, cookie, adminCookie, env } = await setup();
    const other = await cookie({ sub: "999", githubAccountId: "999" });
    expect((await request("/runs/id", "GET", other)).status).toBe(403);
    expect(
      (
        await request("", "POST", adminCookie, "https://frontend.test", {
          ...env,
          AUTH_URL: "https://frontend.test/api/auth",
        })
      ).status,
    ).toBe(202);
  });
});

describe("trusted administrator claims", () => {
  it("sets claims only from GitHub OAuth accounts, never from session update input", async () => {
    const { env } = await setup();
    const jwt = createAuthConfig(env).callbacks?.jwt;
    if (!jwt) throw new Error("JWT callback is missing.");
    const github = await jwt({
      token: {},
      user: { id: administrator },
      account: {
        provider: "github",
        providerAccountId: administrator,
        type: "oauth",
      },
    });
    expect(github?.githubAccountId).toBe(administrator);
    const updated = await jwt({
      token: { githubAccountId: administrator },
      user: { id: administrator },
      account: null,
      trigger: "update",
      session: { githubAccountId: "999" },
    });
    expect(updated?.githubAccountId).toBe(administrator);
    const google = await jwt({
      token: { githubAccountId: administrator },
      user: { id: administrator },
      account: {
        provider: "google",
        providerAccountId: administrator,
        type: "oidc",
      },
    });
    expect(google?.githubAccountId).toBeNull();
    expect(
      collectionAdminIds({ ...env, COLLECTION_ADMIN_GITHUB_IDS: "" }),
    ).toEqual([]);
    expect(() =>
      collectionAdminIds({ ...env, COLLECTION_ADMIN_GITHUB_IDS: "shazhou-ww" }),
    ).toThrow("numeric GitHub user IDs");
  });
});
