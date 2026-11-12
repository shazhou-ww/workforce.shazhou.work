import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCollection } from "../src/collection.js";
import {
  performanceFixture,
  fixtureUser,
  replaySteps,
} from "./collection-performance-fixture.js";
import type { TestD1 } from "./d1.js";
import { createEmailHasher } from "../src/collection-config.js";
import {
  assertPersonalActive,
  assertPersonalCollectionActive,
} from "../src/platform.js";

const databases: TestD1[] = [];
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  databases.splice(0).forEach((db) => {
    db.sqlite.close();
  });
  vi.restoreAllMocks();
});
async function fixture(size = 70) {
  const value = await performanceFixture(size);
  databases.push(value.db);
  return value;
}

describe("bounded cached collection", () => {
  it("uses 19 planning/aggregation callbacks for 68 reused and 2 changed repositories and preserves every statistic", async () => {
    const optimized = await fixture();
    const serial = await fixture();
    const callbacks: string[] = [];
    let roundTrips = 0;
    await runCollection(
      optimized.env,
      optimized.params,
      {
        async do(name, callback) {
          const before = optimized.db.counts.roundTrips;
          await callback();
          if (name.includes("pin and plan") || name.includes("aggregate")) {
            callbacks.push(name);
            roundTrips += optimized.db.counts.roundTrips - before;
          }
        },
      },
      optimized.request(true),
    );
    const serialRequest = serial.request(true);
    await runCollection(
      serial.env,
      serial.params,
      {
        async do(name, callback) {
          if (!name.startsWith("reuse batch ")) await callback();
        },
      },
      serialRequest,
    );
    expect(callbacks).toHaveLength(19);
    expect(roundTrips).toBeLessThan(150);
    expect(
      await optimized.store.rows(
        "SELECT sync_mode,count(*) AS count FROM run_repositories WHERE run_id=? GROUP BY sync_mode ORDER BY sync_mode",
        optimized.params.runId,
      ),
    ).toEqual([
      { sync_mode: "incremental", count: 2 },
      { sync_mode: "reuse", count: 68 },
    ]);
    const snapshot = (db: TestD1) => {
      const row = db.sqlite
        .prepare("SELECT snapshot_json FROM personal_state WHERE id=?")
        .get(fixtureUser);
      if (typeof row?.snapshot_json !== "string")
        throw new Error("Missing test snapshot.");
      const value = JSON.parse(row.snapshot_json) as Record<string, unknown>;
      delete value.generatedAt;
      return value;
    };
    expect(snapshot(optimized.db)).toEqual(snapshot(serial.db));
    expect(serialRequest).toHaveBeenCalledTimes(12);
    expect(
      optimized.db.sqlite
        .prepare(
          "SELECT sum(received_commits) AS count FROM run_repositories WHERE run_id=?",
        )
        .get(optimized.params.runId)?.count,
    ).toBe(13);
    // The cutoff moved a day despite unchanged HEADs; daily/rolling are rebuilt.
    const previous = await optimized.store.snapshot(
      "fixture-seed",
      await createEmailHasher(optimized.env.COLLECTION_EMAIL_KEY ?? ""),
    );
    expect(snapshot(optimized.db).daily).not.toEqual(previous.daily);
  }, 15_000);

  it("rolls back a partially executed aggregation batch and replays its fixed manifest without duplicates", async () => {
    const { db, store, env, params, request } = await fixture(12);
    const checkpoint = replaySteps();
    let failed = false;
    db.onStatement = (sql) => {
      if (!failed && sql.startsWith("INSERT INTO daily_activity")) {
        failed = true;
        throw new Error("Injected batch failure.");
      }
    };
    await expect(
      runCollection(env, params, checkpoint, request()),
    ).rejects.toThrow("Injected batch failure");
    expect(
      await store.rows(
        "SELECT * FROM daily_activity WHERE run_id=?",
        params.runId,
      ),
    ).toEqual([]);
    expect(
      await store.rows(
        "SELECT * FROM run_repositories WHERE run_id=? AND status='complete'",
        params.runId,
      ),
    ).toEqual([]);
    expect(await store.reusePlan(params.runId)).toHaveLength(12);
    expect(
      db.sqlite.prepare("SELECT published_run_id FROM personal_state").get()
        ?.published_run_id,
    ).toBe("fixture-seed");
    db.onStatement = undefined;
    await runCollection(env, params, checkpoint, request());
    const before = db.sqlite
      .prepare("SELECT snapshot_json FROM personal_state")
      .get()?.snapshot_json;
    await runCollection(env, params, replaySteps(), request());
    expect(
      db.sqlite.prepare("SELECT snapshot_json FROM personal_state").get()
        ?.snapshot_json,
    ).toBe(before);
    expect(
      await store.one<{ count: number }>(
        "SELECT count(*) AS count FROM run_repositories WHERE run_id=? AND status='complete'",
        params.runId,
      ),
    ).toEqual({ count: 12 });
    expect(await store.reusePlan(params.runId)).toHaveLength(12);
  });

  it.each(["cancel", "suspend", "owner"] as const)(
    "stops %s observed midway through a batch before the next batch or publication",
    async (action) => {
      const { db, store, env, params, request } = await fixture(12);
      let interrupted = false;
      db.onStatement = (sql) => {
        if (
          !interrupted &&
          sql.startsWith("UPDATE run_repositories SET status='complete'")
        ) {
          interrupted = true;
          // Model a state change during the in-flight call, not a second D1 transaction.
          if (action === "cancel")
            db.sqlite
              .prepare(
                "UPDATE collection_runs SET status='cancelled' WHERE id=?",
              )
              .run(params.runId);
          if (action === "suspend")
            db.sqlite.exec("UPDATE personal_users SET status='suspended'");
          if (action === "owner")
            db.sqlite.exec("UPDATE personal_state SET active_run_id=NULL");
        }
      };
      await expect(
        runCollection(env, params, replaySteps(), request()),
      ).rejects.toThrow(
        action === "cancel"
          ? "cancelled"
          : action === "suspend"
            ? "access has been stopped"
            : "publication lock",
      );
      expect(
        await store.one(
          "SELECT count(*) AS count FROM run_repositories WHERE run_id=? AND status='complete'",
          params.runId,
        ),
      ).toEqual({ count: 10 });
      expect(
        db.sqlite.prepare("SELECT published_run_id FROM personal_state").get()
          ?.published_run_id,
      ).toBe("fixture-seed");
    },
  );

  it("keeps live admin bootstrap semantics without accepting a foreign or missing run", async () => {
    const { db, env: baseEnv, store, params } = await fixture(1);
    const env = { ...baseEnv, COLLECTION_ADMIN_GITHUB_IDS: "100" };
    db.sqlite.exec("UPDATE personal_users SET status='suspended'");
    const sessions = vi.spyOn(db, "withSession");
    const before = db.counts.roundTrips;
    await assertPersonalActive(env, fixtureUser);
    expect(db.counts.roundTrips - before).toBe(1);
    expect(sessions).toHaveBeenCalledWith("first-primary");
    await assertPersonalCollectionActive(env, fixtureUser, "missing", true);
    expect(sessions).toHaveBeenCalledTimes(2);
    await expect(
      assertPersonalCollectionActive(env, fixtureUser, "missing", false),
    ).rejects.toThrow("publication lock");
    await store.enqueue(params.runId, params.revisionId, params.until);
    db.sqlite.exec("UPDATE config_revisions SET config_id='default'");
    await expect(
      assertPersonalCollectionActive(env, fixtureUser, params.runId, false),
    ).rejects.toThrow("publication lock");
    await expect(
      assertPersonalActive(env, "00000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow("access has been stopped");
  });

  it("resumes legacy per-repository checkpoints without replanning completed members", async () => {
    const { env, params, store, request } = await fixture(12);
    const completed = new Set<string>();
    let interrupted = false;
    const checkpoint = {
      async do(name: string, callback: () => Promise<void>) {
        if (completed.has(name)) return;
        if (name.startsWith("reuse batch ")) return;
        await callback();
        completed.add(name);
        if (!interrupted && name.endsWith("aggregate and advance watermark")) {
          interrupted = true;
          throw new Error("Old Workflow interrupted.");
        }
      },
    };
    await expect(
      runCollection(env, params, checkpoint, request()),
    ).rejects.toThrow("Old Workflow interrupted");
    const first = (await store.repositories(params.runId))[0]!;
    expect(first.status).toBe("complete");
    await store
      .statement(
        "DELETE FROM discovery_pages WHERE run_id=? AND scope='reuse-plan:v1'",
        params.runId,
      )
      .run();
    completed.delete("cached repositories pin and plan manifest");
    await runCollection(
      env,
      params,
      {
        async do(name, callback) {
          if (!completed.has(name)) await callback();
        },
      },
      request(),
    );
    expect((await store.run(params.runId)).status).toBe("published");
    expect(
      (await store.repository(params.runId, first.repository_id)).history_id,
    ).toBe(first.history_id);
    expect(await store.reusePlan(params.runId)).toHaveLength(12);
  });

  it("rejects malformed manifests and oversized batches instead of silently publishing", async () => {
    const { env, params, store, request } = await fixture(12);
    await expect(
      store.planReuseBatch(params.runId, Array(11).fill(1)),
    ).rejects.toThrow("bounded budget");
    await expect(
      store.finishReuseBatch(
        {
          id: params.runId,
          revision_id: params.revisionId,
          status: "collecting",
          since_at: params.until,
          until_at: params.until,
        },
        Array(11).fill(1),
        [],
      ),
    ).rejects.toThrow("bounded budget");
    await expect(
      runCollection(
        env,
        params,
        {
          async do(name, callback) {
            await callback();
            if (name === "cached repositories pin and plan manifest")
              await store
                .statement(
                  "UPDATE discovery_pages SET payload_json='[1,1]' WHERE run_id=? AND scope='reuse-plan:v1'",
                  params.runId,
                )
                .run();
          },
        },
        request(),
      ),
    ).rejects.toThrow("Invalid reusable repository manifest");
    expect((await store.run(params.runId)).status).not.toBe("published");
  });
});
