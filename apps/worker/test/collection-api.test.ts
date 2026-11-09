import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { startCollection } from "../src/collection-api.js";
import { parseConfig, createEmailHasher } from "../src/collection-config.js";
import { CollectionStore } from "../src/collection-store.js";
import type { Bindings } from "../src/env.js";
import type { CollectionParams } from "../src/collection.js";
import { TestD1 } from "./d1.js";

const token = "management-secret-with-at-least-32-characters";
const config = {
  enabled: false,
  accounts: ["Owner"],
  authorLogins: ["SHAZHOU-WW"],
  authorEmails: [" AUTHOR@example.test ", "author@example.test"],
  repositoryMode: "all_owned_public",
  includeRepositories: [],
  excludeRepositories: [],
};
const databases: TestD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks();
});

function setup() {
  const db = new TestD1();
  databases.push(db);
  const restart = vi
    .fn<WorkflowInstance["restart"]>()
    .mockResolvedValue(undefined);
  const status = vi
    .fn<WorkflowInstance["status"]>()
    .mockResolvedValue({ status: "errored" });
  const instance: WorkflowInstance = {
    id: "instance",
    restart,
    status,
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    delete: vi.fn(),
    sendEvent: vi.fn(),
    subscribe: vi.fn(),
  };
  const create = vi
    .fn<Workflow<CollectionParams>["create"]>()
    .mockResolvedValue(instance);
  const get = vi
    .fn<Workflow<CollectionParams>["get"]>()
    .mockResolvedValue(instance);
  const env: Bindings = {
    APP_NAME: "Workforce",
    AUTH_SECRET: "a-long-test-auth-secret",
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
    COLLECTION_ADMIN_TOKEN: token,
    COLLECTION_EMAIL_KEY: token,
    GH_TOKEN: "test-token",
    DB: db,
    COLLECTION: { create, get, createBatch: vi.fn(), deleteBatch: vi.fn() },
  };
  const store = new CollectionStore(db);
  function request(
    path: string,
    method = "GET",
    body?: string,
    authorization = `Bearer ${token}`,
    bindings = env,
  ) {
    return app.request(
      `https://example.test/api/collection${path}`,
      {
        method,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body }),
      },
      bindings,
    );
  }
  return { db, store, env, request, create, get, status, restart };
}

describe("private collection configuration", () => {
  it("requires an independent management credential and configured bindings", async () => {
    const { env, request } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await request("/config", "GET", undefined, "")).status).toBe(401);
    expect((await request("/config", "GET", undefined, token)).status).toBe(
      401,
    );
    expect(
      (
        await request(
          "/config",
          "GET",
          undefined,
          `Bearer ${"x".repeat(token.length)}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/config", "GET", undefined, `Bearer ${token}`, {
          ...env,
          COLLECTION_ADMIN_TOKEN: "",
        })
      ).status,
    ).toBe(503);
    const noDatabase = { ...env };
    delete noDatabase.DB;
    expect(
      (
        await request(
          "/config",
          "GET",
          undefined,
          `Bearer ${token}`,
          noDatabase,
        )
      ).status,
    ).toBe(503);
    const noWorkflow = { ...env };
    delete noWorkflow.COLLECTION;
    expect(
      (
        await request(
          "/config",
          "GET",
          undefined,
          `Bearer ${token}`,
          noWorkflow,
        )
      ).status,
    ).toBe(503);
  });

  it("stores immutable revisions and only exposes emails through protected no-store routes", async () => {
    const { store, request } = setup();
    expect(await (await request("/config")).json()).toMatchObject({
      revisionId: null,
      config: null,
      schedulingEnabled: false,
    });
    const response = await request("/config", "PUT", JSON.stringify(config));
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { revisionId } = await response.json<{ revisionId: string }>();
    expect((await store.config(revisionId)).authorEmails).toEqual([
      "author@example.test",
    ]);
    const second = await request(
      "/config",
      "PUT",
      JSON.stringify({ ...config, authorEmails: [], enabled: true }),
    );
    expect(second.status).toBe(201);
    const current = await request("/config");
    expect(await current.json()).toMatchObject({
      config: {
        authorEmails: [],
        enabled: true,
        accounts: ["owner"],
        authorLogins: ["shazhou-ww"],
      },
    });
    expect((await store.config(revisionId)).authorEmails).toEqual([
      "author@example.test",
    ]);
    expect((await request("/runs")).status).toBe(200);
  });

  it("rejects malformed and invalid configuration without leaking submitted values", async () => {
    const { request } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await request("/config", "PUT", "{")).status).toBe(400);
    const invalid = await request(
      "/config",
      "PUT",
      JSON.stringify({ ...config, authorEmails: ["private invalid identity"] }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private invalid identity");
  });

  it("starts an explicit run with a pinned revision and cutoff but never auto-enables scheduling", async () => {
    const { request, create, store, env } = setup();
    await expect(startCollection(env)).rejects.toMatchObject({ status: 503 });
    const revisionId = await store.saveConfig(parseConfig(config));
    expect((await request("/runs", "POST")).status).toBe(202);
    expect(create.mock.calls[0]?.[0]?.params).toMatchObject({ revisionId });
    const result = await startCollection(env, Date.now());
    expect(result).toBeNull();
    await store.saveConfig(parseConfig({ ...config, enabled: true }));
    expect(await startCollection(env, Date.now())).toBeNull();
    const time = Date.parse("2026-11-09T05:00:00Z");
    await startCollection({ ...env, COLLECTION_ENABLED: "true" }, time);
    expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
      id: `scheduled-${time}`,
      params: { until: "2026-11-09T05:00:00.000Z" },
    });
    const noDb = { ...env };
    delete noDb.DB;
    await expect(startCollection(noDb)).rejects.toMatchObject({ status: 503 });
    await expect(
      startCollection({ ...env, GH_TOKEN: "" }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("rejects overlapping runs and offers guarded retry/cancel for stopped Workflows", async () => {
    const { env, request, store, status, restart } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const revisionId = await store.saveConfig(
      parseConfig({ ...config, enabled: true }),
    );
    await store.begin("active", revisionId, "2026-11-09T05:00:00Z", "key-id");
    expect((await request("/runs", "POST")).status).toBe(409);
    expect(
      await startCollection({ ...env, COLLECTION_ENABLED: "true" }, Date.now()),
    ).toBeNull();
    expect((await request("/runs/missing/retry", "POST")).status).toBe(404);
    expect((await request("/runs/missing/cancel", "POST")).status).toBe(409);
    status.mockResolvedValueOnce({ status: "running" });
    expect((await request("/runs/active/retry", "POST")).status).toBe(409);
    expect((await request("/runs/active/retry", "POST")).status).toBe(202);
    expect(restart).toHaveBeenCalledOnce();
    status.mockResolvedValueOnce({ status: "running" });
    expect((await request("/runs/active/cancel", "POST")).status).toBe(409);
    expect((await request("/runs/active/cancel", "POST")).status).toBe(200);
    expect((await store.run("active")).status).toBe("cancelled");
    expect(await store.ownsRun("active")).toBe(false);
    expect((await request("/runs/active/retry", "POST")).status).toBe(409);
    expect(
      await store.begin("active", revisionId, "2026-11-09T05:00:00Z", "key-id"),
    ).toBe(false);
  });
});

describe("configuration validation", () => {
  it.each([
    null,
    [],
    {},
    { ...config, unexpected: true },
    { ...config, enabled: "true" },
    { ...config, repositoryMode: "private" },
    { ...config, accounts: "owner" },
    { ...config, accounts: Array.from({ length: 101 }, () => "owner") },
    { ...config, accounts: [123] },
    { ...config, accounts: ["bad/name"] },
    { ...config, authorEmails: ["x".repeat(321)] },
    { ...config, includeRepositories: ["invalid"] },
    { ...config, accounts: [] },
    { ...config, authorLogins: [], authorEmails: [] },
    { ...config, repositoryMode: "explicit", includeRepositories: [] },
  ])("rejects invalid configuration %#", (value) => {
    expect(() => parseConfig(value)).toThrow();
  });

  it("normalizes and deduplicates identities, and supports email-only explicit configurations", async () => {
    expect(
      parseConfig({
        ...config,
        accounts: [],
        authorLogins: [],
        repositoryMode: "explicit",
        includeRepositories: ["Owner/Repo", "owner/repo"],
        excludeRepositories: ["Owner/Repo"],
      }),
    ).toMatchObject({
      includeRepositories: ["owner/repo"],
      authorEmails: ["author@example.test"],
    });
    await expect(createEmailHasher("short")).rejects.toThrow("32");
  });
});
