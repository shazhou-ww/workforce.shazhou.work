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
  requestToken,
} from "./auth.js";
import { startCollection } from "./collection-api.js";
import { CollectionStore, type CollectionRun } from "./collection-store.js";
import type { Bindings } from "./env.js";
import { publicActivityOwner } from "./public-activity.js";
import { PersonalError } from "./platform.js";
import {
  reconcilePersonalRun,
  startPersonalCollection,
} from "./personal-api.js";

export const manualCollectionApi = new Hono<{ Bindings: Bindings }>();

async function sourceOwner(request: Request, env: Bindings) {
  const token = await requestToken(request, env);
  if (typeof token?.platformUserId !== "string") return null;
  return token.platformUserId === (await publicActivityOwner(env))
    ? token.platformUserId
    : null;
}

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
  const owner =
    context.env.PUBLIC_ACTIVITY_GITHUB_ID && user
      ? await sourceOwner(context.req.raw, context.env)
      : null;
  const canCollect =
    canCollectActivity(user, context.env) &&
    (!context.env.PUBLIC_ACTIVITY_GITHUB_ID || owner !== null);
  let activeRunId: string | null = null;
  let latestRunId: string | null = null;
  if (canCollect && context.env.DB) {
    if (owner) await reconcilePersonalRun(context.env, owner);
    const store = new CollectionStore(context.env.DB, owner ?? undefined);
    const state = await store.one<{
      active_run_id: string | null;
    }>(
      owner
        ? "SELECT active_run_id FROM personal_state WHERE id=?"
        : "SELECT active_run_id FROM collection_state WHERE id=?",
      owner ?? 1,
    );
    activeRunId = state?.active_run_id ?? null;
    const latest = await store.one<{
      id: string;
    }>(
      "SELECT r.id FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE c.config_id=? ORDER BY r.started_at DESC,r.id DESC LIMIT 1",
      owner ?? "default",
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
    const owner = context.env.PUBLIC_ACTIVITY_GITHUB_ID
      ? await sourceOwner(context.req.raw, context.env)
      : null;
    if (context.env.PUBLIC_ACTIVITY_GITHUB_ID && !owner)
      return context.json({ error: "只有公开数据源本人可以刷新统计。" }, 403);
    const result = owner
      ? await startPersonalCollection(context.env, owner)
      : await startCollection(context.env);
    if (!result) throw new Error("Manual collection unexpectedly skipped.");
    return context.json<CollectionTriggerResponse>(result, 202);
  } catch (error) {
    if (error instanceof PersonalError) {
      console.warn("Public source personal refresh rejected:", error.code);
      return context.json(
        { error: error.message, code: error.code },
        error.status,
      );
    }
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
  const owner = context.env.PUBLIC_ACTIVITY_GITHUB_ID
    ? await sourceOwner(context.req.raw, context.env)
    : null;
  if (context.env.PUBLIC_ACTIVITY_GITHUB_ID && !owner)
    return context.json({ error: "只有公开数据源本人可以读取任务。" }, 403);
  if (owner) await reconcilePersonalRun(context.env, owner);
  const store = new CollectionStore(context.env.DB, owner ?? undefined);
  const run = await store.one<CollectionRun>(
    "SELECT r.* FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id=?",
    context.req.param("id"),
    owner ?? "default",
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
