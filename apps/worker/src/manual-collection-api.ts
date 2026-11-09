import { getAuthUser, verifyAuth } from "@hono/auth-js";
import type {
  CollectionAccessResponse,
  CollectionProgressResponse,
  CollectionTriggerResponse,
} from "@shazhou-work/workforce-contracts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  canCollectActivity,
  collectionAdminIds,
  getConfiguredProviders,
} from "./auth.js";
import { startCollection } from "./collection-api.js";
import { CollectionStore, type CollectionRun } from "./collection-store.js";
import type { Bindings } from "./env.js";

export const manualCollectionApi = new Hono<{ Bindings: Bindings }>();

manualCollectionApi.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});

manualCollectionApi.get("/", async (context) => {
  const loginEnabled =
    getConfiguredProviders(context.env).some(
      (provider) => provider.id === "github",
    ) &&
    typeof context.env.AUTH_SECRET === "string" &&
    context.env.AUTH_SECRET.length >= 32 &&
    collectionAdminIds(context.env).length > 0;
  const user = loginEnabled ? await getAuthUser(context) : null;
  const canCollect = canCollectActivity(user, context.env);
  let activeRunId: string | null = null;
  let latestRunId: string | null = null;
  if (canCollect && context.env.DB) {
    const state = await new CollectionStore(context.env.DB).one<{
      active_run_id: string | null;
    }>("SELECT active_run_id FROM collection_state WHERE id=1");
    activeRunId = state?.active_run_id ?? null;
    const latest = await new CollectionStore(context.env.DB).one<{
      id: string;
    }>(
      "SELECT id FROM collection_runs ORDER BY started_at DESC,id DESC LIMIT 1",
    );
    latestRunId = latest?.id ?? null;
  }
  return context.json<CollectionAccessResponse>({
    loginEnabled,
    signedIn: user !== null,
    canCollect,
    displayName: user?.session.user?.name ?? null,
    activeRunId,
    ...(canCollect ? { latestRunId } : {}),
  });
});

manualCollectionApi.post("/", verifyAuth(), async (context) => {
  if (!canCollectActivity(context.get("authUser"), context.env)) {
    console.warn("Rejected manual collection by a non-administrator.");
    return context.json({ error: "当前账号没有手动采集权限。" }, 403);
  }
  if (
    context.req.header("Origin") !==
    new URL(context.env.AUTH_URL ?? context.req.url).origin
  ) {
    console.warn("Rejected cross-origin manual collection request.");
    return context.json({ error: "请从本站页面触发采集。" }, 403);
  }
  try {
    const result = await startCollection(context.env);
    if (!result) throw new Error("Manual collection unexpectedly skipped.");
    return context.json<CollectionTriggerResponse>(result, 202);
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    console.warn("Manual collection rejected:", error.message);
    return context.json(
      {
        error:
          error.status === 409
            ? "已有采集任务正在进行，请等待完成。"
            : "采集任务尚未配置完整，请联系管理员。",
      },
      error.status,
    );
  }
});

manualCollectionApi.get("/runs/:id", verifyAuth(), async (context) => {
  if (!canCollectActivity(context.get("authUser"), context.env)) {
    console.warn("Rejected collection status request by a non-administrator.");
    return context.json({ error: "当前账号没有手动采集权限。" }, 403);
  }
  if (!context.env.DB || !context.env.COLLECTION) {
    return context.json({ error: "采集任务尚未配置完整。" }, 503);
  }
  const store = new CollectionStore(context.env.DB);
  const run = await store.one<CollectionRun>(
    "SELECT * FROM collection_runs WHERE id=?",
    context.req.param("id"),
  );
  if (!run) {
    console.warn("Requested collection run was not found.");
    return context.json({ error: "找不到该采集任务。" }, 404);
  }
  const repositories = await store.one<{
    total: number;
    complete: number | null;
  }>(
    "SELECT count(*) AS total,sum(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete FROM run_repositories WHERE run_id=?",
    run.id,
  );
  if (!repositories)
    throw new Error("Collection progress query returned no result.");
  let waiting = false;
  let status = run.status;
  if (
    run.status === "queued" ||
    run.status === "collecting" ||
    run.status === "ready" ||
    (run.status === "failed" && (await store.ownsRun(run.id)))
  ) {
    const state = await (await context.env.COLLECTION.get(run.id)).status();
    waiting =
      state.status === "waiting" ||
      state.status === "paused" ||
      state.status === "waitingForPause";
    if (state.status === "errored") status = "failed";
    if (state.status === "terminated") status = "cancelled";
    if (
      run.status === "failed" &&
      ["queued", "running", "waiting", "paused", "waitingForPause"].includes(
        state.status,
      )
    ) {
      status = state.status === "queued" ? "queued" : "collecting";
    }
  }
  return context.json<CollectionProgressResponse>({
    runId: run.id,
    status,
    waiting,
    completedRepositories: repositories.complete ?? 0,
    totalRepositories: repositories.total,
    until: run.until_at,
    performance: await store.performance(
      run.id,
      ["published", "failed", "blocked", "cancelled"].includes(status),
    ),
  });
});
