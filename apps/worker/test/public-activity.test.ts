import { encode } from "@auth/core/jwt";
import {
  activityWindow,
  activityTotals,
  type ActivitySnapshot,
} from "@shazhou-work/workforce-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import entry from "../src/entry.js";
import { CollectionStore } from "../src/collection-store.js";
import { startCollection } from "../src/collection-api.js";
import { registerIdentity, retainGitHub } from "../src/platform.js";
import { publicSnapshotProjection } from "../src/public-activity.js";
import type { Bindings } from "../src/env.js";
import type { CollectionParams } from "../src/collection.js";
import { TestD1 } from "./d1.js";

const sourceId = "242885595";
const secret = "public-source-test-secret-longer-than-thirty-two-characters";
const until = "2026-11-12T10:00:00.000Z";
const config = {
  enabled: true,
  accounts: ["owner"],
  authorLogins: ["private-author-filter"],
  authorEmails: ["synthetic@example.invalid"],
  repositoryMode: "all_owned_public" as const,
  includeRepositories: [],
  excludeRepositories: [],
};
const databases: TestD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks();
});

function snapshot(cutoff = until): ActivitySnapshot {
  const window = activityWindow(new Date(cutoff));
  const totals = activityTotals([{ commits: 1, additions: 2, deletions: 3 }]);
  const daily = window.dates.map((date) => ({ date, ...totals }));
  return {
    version: 1,
    accounts: ["private-scope-choice"],
    authorFilter: { login: "private-author-filter", emailMatching: true },
    generatedAt: cutoff,
    since: window.since,
    until: cutoff,
    timezone: "Asia/Shanghai",
    days: 30,
    totals,
    daily,
    yearly: [{ date: window.dates[0]!, commits: 1 }],
    rolling: [{ at: cutoff, ...totals }],
    repositories: [
      {
        name: "owner/public",
        url: "https://github.com/owner/public",
        description: "Public repository",
        defaultBranch: "main",
        fork: false,
        archived: false,
        latestCommit: {
          committedAt: cutoff,
          message: "Public subject",
          url: "https://github.com/owner/public/commit/abc",
        },
        daily,
        ...totals,
      },
    ],
  };
}

async function fixture() {
  const db = new TestD1();
  databases.push(db);
  const create = vi
    .fn<
      (options: {
        id: string;
        params: CollectionParams;
      }) => Promise<{ id: string }>
    >()
    .mockImplementation(({ id }) => Promise.resolve({ id }));
  const get = vi.fn().mockResolvedValue({
    status: () => Promise.resolve({ status: "running" }),
  });
  const kvGet = vi
    .fn()
    .mockResolvedValue({ ...snapshot(), until: "2099-01-01" });
  const env = {
    APP_NAME: "Workforce",
    AUTH_SECRET: secret,
    AUTH_GITHUB_ID: "test-client",
    AUTH_GITHUB_SECRET: "test-client-secret",
    COLLECTION_ADMIN_GITHUB_IDS: `${sourceId},202`,
    COLLECTION_ADMIN_TOKEN: secret,
    COLLECTION_EMAIL_KEY: secret,
    COLLECTION_ENABLED: "true",
    PUBLIC_ACTIVITY_GITHUB_ID: sourceId,
    GH_TOKEN: "synthetic-server-token",
    DB: db,
    STATS: { get: kvGet, put: vi.fn() },
    COLLECTION: { create, get },
  } as unknown as Bindings;
  async function owner(githubId: string) {
    const userId = await registerIdentity(env, "github", githubId, []);
    if (!userId) throw new Error("Missing test owner.");
    await retainGitHub(
      env,
      userId,
      {
        id: githubId,
        login: "mutable-login",
        avatarUrl: "https://example.invalid/avatar",
      },
      "synthetic-oauth-token",
      "",
    );
    const store = new CollectionStore(db, userId);
    const revision = await store.saveConfig(config);
    return { userId, store, revision };
  }
  const source = await owner(sourceId);
  const other = await owner("202");
  async function publish(
    target: typeof source,
    id: string,
    value = snapshot(),
  ) {
    await target.store.begin(id, target.revision, value.until, "test-key");
    await target.store.ready(id);
    await target.store.publishPersonal(id, value);
    await target.store.published(id);
  }
  async function cookie(target: typeof source, githubId = sourceId) {
    const salt = "__Secure-authjs.session-token";
    return `${salt}=${await encode({
      token: {
        sub: githubId,
        githubAccountId: githubId,
        platformUserId: target.userId,
      },
      secret,
      salt,
    })}`;
  }
  const read = (suffix = "") =>
    app.request(`https://example.test/api/activity${suffix}`, {}, env);
  return { db, env, source, other, publish, cookie, read, create, kvGet };
}

describe("explicit public personal source", () => {
  it("uses only the configured stable identity, ignoring logins, administrators, request selectors and legacy KV writes", async () => {
    const { env, source, other, publish, read, kvGet } = await fixture();
    await publish(source, "source");
    await publish(other, "private", snapshot("2026-11-12T11:00:00.000Z"));
    await source.store
      .statement(
        "UPDATE personal_github SET login='renamed' WHERE user_id=?",
        source.userId,
      )
      .run();
    const response = await read(
      `?userId=${other.userId}&githubId=202&collection=private`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = await response.json<ActivitySnapshot>();
    expect(body).toEqual(publicSnapshotProjection(snapshot()));
    expect(body.until).toBe(until);
    expect(body.accounts).toEqual(["owner"]);
    expect(kvGet).not.toHaveBeenCalled();
    const missing = await app.request(
      "https://example.test/api/activity",
      {},
      {
        ...env,
        PUBLIC_ACTIVITY_GITHUB_ID: "999",
      },
    );
    expect(missing.status).toBe(503);
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("recursively allowlists public statistics, not scope, email matching, credentials or future private fields", () => {
    const input = snapshot();
    const privateFields = {
      credential: "synthetic-secret",
      authorEmails: config.authorEmails,
      config,
    };
    const projected = publicSnapshotProjection({
      ...input,
      ...privateFields,
      totals: { ...input.totals, ...privateFields },
      daily: input.daily.map((day) => ({ ...day, ...privateFields })),
      rolling: input.rolling?.map((row) => ({ ...row, ...privateFields })),
      yearly: input.yearly?.map((row) => ({ ...row, ...privateFields })),
      repositories: input.repositories.map((repo) => ({
        ...repo,
        ...privateFields,
        latestCommit: { ...repo.latestCommit, ...privateFields },
        daily: repo.daily.map((day) => ({ ...day, ...privateFields })),
      })),
    });
    const json = JSON.stringify(projected);
    for (const privateValue of [
      "synthetic-secret",
      "synthetic@example.invalid",
      "private-author-filter",
      "private-scope-choice",
      "credential",
      "authorEmails",
    ])
      expect(json).not.toContain(privateValue);
    expect(projected.daily).toEqual(input.daily);
    expect(projected.yearly).toEqual(input.yearly);
    expect(projected.rolling).toEqual(input.rolling);
    expect(projected.repositories).toEqual(input.repositories);
    expect(() => publicSnapshotProjection({ ...input, daily: [] })).toThrow(
      "Incomplete",
    );
    expect(() =>
      publicSnapshotProjection({
        ...input,
        repositories: [
          {
            ...input.repositories[0],
            url: "https://github.com/owner/public?token=synthetic-secret",
          },
        ],
      }),
    ).toThrow("URL");
  });

  it("keeps the previous complete public result on failure, fences older runs, and exposes the next complete personal publication immediately", async () => {
    const { source, publish, read } = await fixture();
    await publish(source, "first");
    const newer = "2026-11-12T11:00:00.000Z";
    await source.store.begin("failed", source.revision, newer, "test-key");
    await source.store.failed("failed", "Synthetic failure");
    expect((await (await read()).json<ActivitySnapshot>()).until).toBe(until);
    await source.store.cancel("failed");
    await publish(source, "newer", snapshot(newer));
    expect(
      await source.store.begin("older", source.revision, until, "test-key"),
    ).toBe(false);
    await expect(
      source.store.publishPersonal("older", snapshot()),
    ).rejects.toThrow("stopped");
    expect((await (await read()).json<ActivitySnapshot>()).until).toBe(newer);
  });

  it("never substitutes another user's result when source data is missing or malformed", async () => {
    const { source, other, publish, read, kvGet } = await fixture();
    await publish(other, "other");
    expect((await read()).status).toBe(503);
    await publish(source, "source");
    await source.store
      .statement(
        "UPDATE personal_state SET snapshot_json=? WHERE id=?",
        '{"credential":"synthetic-secret"',
        source.userId,
      )
      .run();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await read()).status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret");
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("retains a complete atomic publication even when final workflow bookkeeping fails", async () => {
    const { source, read } = await fixture();
    await source.store.begin(
      "published-before-error",
      source.revision,
      until,
      "test-key",
    );
    await source.store.ready("published-before-error");
    await source.store.publishPersonal("published-before-error", snapshot());
    await source.store
      .statement(
        "UPDATE collection_runs SET status='failed' WHERE id='published-before-error'",
      )
      .run();
    expect((await (await read()).json<ActivitySnapshot>()).until).toBe(until);
  });

  it("schedules only personal runs, retires global writes/restarts, and preserves in-flight legacy task completion and reads", async () => {
    const { env, source, create } = await fixture();
    const legacy = new CollectionStore(env.DB!);
    const revision = await legacy.saveConfig(config);
    await legacy.begin("in-flight-legacy", revision, until, "test-key");
    await entry.scheduled(
      { scheduledTime: Date.parse(until) } as ScheduledController,
      env,
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(
      create.mock.calls.every(
        ([call]) => typeof call.params.userId === "string",
      ),
    ).toBe(true);
    expect(
      create.mock.calls.some(([call]) => call.params.userId === source.userId),
    ).toBe(true);
    await expect(startCollection(env)).rejects.toMatchObject({ status: 410 });
    for (const [path, method] of [
      ["config", "PUT"],
      ["runs", "POST"],
      ["runs/in-flight-legacy/retry", "POST"],
    ] as const) {
      const response = await app.request(
        `https://example.test/api/collection/${path}`,
        {
          method,
          headers: { Authorization: `Bearer ${secret}` },
          body: "{}",
        },
        env,
      );
      expect(response.status).toBe(410);
    }
    const response = await app.request(
      "https://example.test/api/collection/runs",
      {
        headers: { Authorization: `Bearer ${secret}` },
      },
      env,
    );
    expect(response.status).toBe(200);
    // Old Workflow payloads and checkpoints still own their original scope.
    await legacy.ready("in-flight-legacy");
    await legacy.published("in-flight-legacy");
    expect((await legacy.run("in-flight-legacy")).status).toBe("published");
    expect(await legacy.ownsRun("in-flight-legacy")).toBe(false);
  });

  it("bridges homepage refresh/status to the source personal scope without exposing another administrator's tasks", async () => {
    const { env, source, other, cookie, create } = await fixture();
    const auth = await cookie(source);
    const request = (path: string, method = "GET", cookie = auth) =>
      app.request(
        `https://example.test/api/activity/collection${path}`,
        {
          method,
          headers: { Cookie: cookie, Origin: "https://example.test" },
          ...(method === "POST" ? { body: "{}" } : {}),
        },
        env,
      );
    expect(await (await request("")).json()).toMatchObject({
      canCollect: true,
    });
    const started = await request("", "POST");
    expect(started.status).toBe(202);
    const { runId } = await started.json<{ runId: string }>();
    expect(create.mock.calls[0]?.[0].params.userId).toBe(source.userId);
    expect((await request(`/runs/${runId}`)).status).toBe(200);
    expect((await request("", "POST")).status).toBe(429);
    const otherCookie = await cookie(other, "202");
    expect(await (await request("", "GET", otherCookie)).json()).toMatchObject({
      canCollect: false,
    });
    expect((await request("", "POST", otherCookie)).status).toBe(403);
    expect((await request(`/runs/${runId}`, "GET", otherCookie)).status).toBe(
      403,
    );
    expect((await request(`/runs/${runId}`, "GET", "")).status).toBe(401);
    const privateRun = await other.store.saveConfig(config);
    await other.store.begin("private-run", privateRun, until, "test-key");
    expect((await request("/runs/private-run")).status).toBe(404);
  });
});
