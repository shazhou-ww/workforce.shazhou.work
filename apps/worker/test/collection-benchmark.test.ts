import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { runCollection } from "../src/collection.js";
import {
  performanceFixture,
  fixtureUser,
} from "./collection-performance-fixture.js";
import type { TestD1 } from "./d1.js";

const databases: TestD1[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => {
    db.sqlite.close();
  });
  vi.restoreAllMocks();
});

it.skipIf(!process.env.COLLECTION_BENCHMARK_BASELINE)(
  "compares three frozen-baseline pairs with disclosed controlled D1 latency",
  async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const path = "../.collection-performance-baseline/collection.ts";
    const baseline = (await import(path)) as {
      runCollection: typeof runCollection;
    };
    interface Measurement {
      variant: string;
      wallMs: number;
      callbackMs: number;
      planningAggregationMs: number;
      planningAggregationCallbacks: number;
      planningAggregationRoundTrips: number;
      planningAggregationStatements: number;
      callbacks: number;
      roundTrips: number;
      statements: number;
      batches: number;
      waitMs: number;
      githubRequests: number;
      phases: {
        phase: string;
        callbacks: number;
        activeMs: number;
        rest: number;
        graphql: number;
      }[];
    }
    const pairs: {
      pair: number;
      scenario: string;
      baseline: Measurement;
      optimized: Measurement;
    }[] = [];
    for (let pair = 0; pair < 5; pair += 1) {
      const scenario = pair < 3 ? "mixed" : pair === 3 ? "all-reuse" : "first";
      const results: Measurement[] = [];
      const snapshots: Record<string, unknown>[] = [];
      for (const [variant, collect] of [
        ["baseline", baseline.runCollection],
        ["optimized", runCollection],
      ] as const) {
        const { db, env, store, params, request } = await performanceFixture(
          70,
          scenario !== "first",
        );
        databases.push(db);
        db.latencyMs = scenario === "first" ? 0 : 2;
        const github = request(scenario === "mixed");
        let callbackMs = 0;
        let planningAggregationMs = 0;
        let planningAggregationCallbacks = 0;
        let planningAggregationRoundTrips = 0;
        let planningAggregationStatements = 0;
        let callbacks = 0;
        const started = performance.now();
        await collect(
          env,
          params,
          {
            async do(name, callback) {
              const start = performance.now();
              const counts = { ...db.counts };
              await callback();
              const elapsed = performance.now() - start;
              callbacks += 1;
              callbackMs += elapsed;
              if (name.includes("pin and plan") || name.includes("aggregate")) {
                planningAggregationMs += elapsed;
                planningAggregationCallbacks += 1;
                planningAggregationRoundTrips +=
                  db.counts.roundTrips - counts.roundTrips;
                planningAggregationStatements +=
                  db.counts.statements - counts.statements;
              }
            },
          },
          github,
        );
        const wallMs = performance.now() - started;
        const counts = { ...db.counts };
        const phases = await store.rows<{
          phase: string;
          callbacks: number;
          activeMs: number;
          rest: number;
          graphql: number;
        }>(
          `SELECT phase,count(*) AS callbacks,sum(active_ms) AS activeMs,
           sum(rest_requests) AS rest,sum(graphql_requests) AS graphql
           FROM collection_attempts WHERE run_id=? GROUP BY phase ORDER BY phase`,
          params.runId,
        );
        const row = db.sqlite
          .prepare("SELECT snapshot_json FROM personal_state WHERE id=?")
          .get(fixtureUser);
        if (typeof row?.snapshot_json !== "string")
          throw new Error("Missing benchmark snapshot.");
        const snapshot = JSON.parse(row.snapshot_json) as Record<
          string,
          unknown
        >;
        delete snapshot.generatedAt;
        snapshots.push(snapshot);
        results.push({
          variant,
          wallMs,
          callbackMs,
          planningAggregationMs,
          planningAggregationCallbacks,
          planningAggregationRoundTrips,
          planningAggregationStatements,
          callbacks,
          ...counts,
          githubRequests: github.mock.calls.length,
          phases,
        });
      }
      const before = results[0]!;
      const after = results[1]!;
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(after.githubRequests).toBe(before.githubRequests);
      expect(after.planningAggregationCallbacks).toBe(
        scenario === "mixed" ? 19 : scenario === "all-reuse" ? 15 : 141,
      );
      expect(before.planningAggregationCallbacks).toBe(140);
      pairs.push({
        pair: pair + 1,
        scenario,
        baseline: before,
        optimized: after,
      });
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
    const mixed = pairs.filter((pair) => pair.scenario === "mixed");
    const active = (value: (typeof pairs)[number]["baseline"]) =>
      value.phases
        .filter((phase) => ["planning", "aggregation"].includes(phase.phase))
        .reduce((sum, phase) => sum + phase.activeMs, 0);
    const reduction =
      1 -
      median(mixed.map((pair) => active(pair.optimized))) /
        median(mixed.map((pair) => active(pair.baseline)));
    const report = JSON.stringify(
      {
        benchmark: "collection-performance",
        baselineRevision: process.env.COLLECTION_BENCHMARK_BASELINE,
        fixture: {
          repositories: 70,
          reused: 68,
          incremental: 2,
          newCommits: 13,
          injectedD1RoundTripMs: 2,
          cutoff: "2026-11-12T12:00:00.000Z",
          environment: "Node SQLite; not production D1 or Workflow scheduler",
          nodeVersion: process.version,
          sqliteVersion: process.versions.sqlite,
          platform: process.platform,
          architecture: process.arch,
          productionD1RowsRead: null,
          productionD1RowsWritten: null,
          productionD1ExecutionMs: null,
          externalRateLimitWaitMs: 0,
          retryWaitMs: 0,
          graphqlCost: null,
          scenarioNotes:
            "Three mixed pairs are acceptance workload; one all-reuse reference pair has the same 2ms nominal call delay; first initialization is a separate zero-delay count/semantic comparison.",
        },
        pairs,
        planningAggregationMedianReduction: reduction,
      },
      null,
      2,
    );
    if (process.env.COLLECTION_BENCHMARK_OUTPUT)
      writeFileSync(process.env.COLLECTION_BENCHMARK_OUTPUT, `${report}\n`);
    console.log(report);
    expect(reduction).toBeGreaterThanOrEqual(0.7);
    // Include metrics persistence and the entire invocation as additional guardrails.
    expect(
      median(mixed.map((pair) => pair.optimized.planningAggregationMs)),
    ).toBeLessThan(
      median(mixed.map((pair) => pair.baseline.planningAggregationMs)) * 0.3,
    );
    expect(median(mixed.map((pair) => pair.optimized.wallMs))).toBeLessThan(
      median(mixed.map((pair) => pair.baseline.wallMs)) * 0.3,
    );
  },
  240_000,
);
