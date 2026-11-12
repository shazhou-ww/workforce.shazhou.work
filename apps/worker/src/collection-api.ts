import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { CollectionInputError, parseConfig } from "./collection-config.js";
import { CollectionStore } from "./collection-store.js";
import type { Bindings } from "./env.js";
import type { CollectionParams } from "./collection.js";

export const collectionApi = new Hono<{
  Bindings: Bindings;
  Variables: { store: CollectionStore; workflow: Workflow<CollectionParams> };
}>();

collectionApi.use("*", async (context, next) => {
  const token = context.env.COLLECTION_ADMIN_TOKEN;
  if (!token || token.length < 32) {
    throw new HTTPException(503, {
      message: "Collection management is not configured.",
    });
  }
  const supplied =
    context.req.header("Authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(token);
  const suppliedBytes = encoder.encode(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    console.warn("Rejected unauthorized collection management request.");
    return context.json({ error: "Unauthorized" }, 401);
  }
  context.header("Cache-Control", "no-store");
  if (!context.env.DB || !context.env.COLLECTION) {
    return context.json(
      { error: "Configure the DB and COLLECTION bindings first." },
      503,
    );
  }
  context.set("store", new CollectionStore(context.env.DB));
  context.set("workflow", context.env.COLLECTION);
  await next();
  return;
});

collectionApi.get("/config", async (context) => {
  const store = context.get("store");
  const active = await store.activeConfig();
  return context.json({
    revisionId: active.revisionId,
    config: active.revisionId ? await store.config(active.revisionId) : null,
    schedulingEnabled:
      !context.env.PUBLIC_ACTIVITY_GITHUB_ID &&
      context.env.COLLECTION_ENABLED === "true",
  });
});

collectionApi.put("/config", async (context) => {
  if (context.env.PUBLIC_ACTIVITY_GITHUB_ID) return retired(context);
  let value: unknown;
  try {
    value = await context.req.json<unknown>();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn("Rejected malformed collection configuration JSON.");
    return context.json({ error: "Invalid JSON." }, 400);
  }
  try {
    const config = parseConfig(value);
    const revisionId = await context.get("store").saveConfig(config);
    return context.json({ revisionId }, 201);
  } catch (error) {
    if (!(error instanceof CollectionInputError)) throw error;
    console.warn("Rejected invalid collection configuration:", error.message);
    return context.json({ error: error.message }, 400);
  }
});

collectionApi.get("/runs", async (context) => {
  const store = context.get("store");
  return context.json({
    state: await store.one(
      "SELECT active_run_id,published_run_id FROM collection_state WHERE id=1",
    ),
    runs: await store.rows(
      "SELECT r.* FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE c.config_id='default' ORDER BY r.started_at DESC LIMIT 20",
    ),
  });
});

export async function startCollection(env: Bindings, scheduledAt?: number) {
  if (env.PUBLIC_ACTIVITY_GITHUB_ID)
    throw new HTTPException(410, {
      message: "Global collection is retired. Use personal collection.",
    });
  if (
    !env.DB ||
    !env.COLLECTION ||
    !env.GH_TOKEN?.trim() ||
    !env.COLLECTION_EMAIL_KEY ||
    env.COLLECTION_EMAIL_KEY.length < 32
  ) {
    throw new HTTPException(503, {
      message: "Configure collection bindings and secrets first.",
    });
  }
  const store = new CollectionStore(env.DB);
  const active = await store.activeConfig();
  if (!active.revisionId) {
    throw new HTTPException(503, {
      message: "Save a collection configuration first.",
    });
  }
  if (
    scheduledAt !== undefined &&
    (env.COLLECTION_ENABLED !== "true" || active.enabled !== 1)
  )
    return null;
  const state = await store.one<{ active_run_id: string | null }>(
    "SELECT active_run_id FROM collection_state WHERE id=1",
  );
  if (state?.active_run_id) {
    if (scheduledAt !== undefined) {
      console.warn(
        "Scheduled collection skipped because another run is active.",
      );
      return null;
    }
    throw new HTTPException(409, {
      message: "Another collection is active; inspect or retry it first.",
    });
  }
  const until = new Date(scheduledAt ?? Date.now()).toISOString();
  const runId =
    scheduledAt === undefined
      ? crypto.randomUUID()
      : `scheduled-${scheduledAt}`;
  if (
    scheduledAt !== undefined &&
    (await store.one("SELECT id FROM collection_runs WHERE id=?", runId))
  ) {
    console.warn("Duplicate scheduled collection delivery skipped.");
    return null;
  }
  await store.enqueue(runId, active.revisionId, until);
  try {
    const instance = await env.COLLECTION.create({
      id: runId,
      params: { runId, revisionId: active.revisionId, until },
    });
    return { runId: instance.id };
  } catch (error) {
    console.error("Failed to start the collection Workflow.", error);
    await store.failed(
      runId,
      "Workflow could not be started. Inspect Worker logs.",
    );
    throw error;
  }
}

collectionApi.post("/runs", async (context) =>
  context.json(await startCollection(context.env), 202),
);

collectionApi.post("/runs/:id/retry", async (context) => {
  if (context.env.PUBLIC_ACTIVITY_GITHUB_ID) return retired(context);
  const store = context.get("store");
  const run = await store.one<{ id: string; status: string }>(
    "SELECT r.id,r.status FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id='default'",
    context.req.param("id"),
  );
  if (!run) return context.json({ error: "Collection run not found." }, 404);
  if (
    !(await store.ownsRun(run.id)) ||
    !["failed", "ready", "collecting"].includes(run.status)
  ) {
    return context.json({ error: "This run cannot be retried." }, 409);
  }
  const instance = await context.get("workflow").get(run.id);
  const status = await instance.status();
  if (status.status !== "errored") {
    return context.json(
      {
        error:
          "Only an errored Workflow can be restarted; an active Workflow may still be retrying.",
      },
      409,
    );
  }
  await instance.restart();
  return context.json({ runId: run.id }, 202);
});

function retired(context: Context) {
  return context.json(
    { error: "Global collection is retired. Use personal collection." },
    410,
  );
}

collectionApi.post("/runs/:id/cancel", async (context) => {
  const store = context.get("store");
  const id = context.req.param("id");
  if (!(await store.ownsRun(id)))
    return context.json(
      { error: "This run does not hold the collection lock." },
      409,
    );
  const instance = await context.get("workflow").get(id);
  const status = await instance.status();
  if (status.status !== "errored" && status.status !== "terminated") {
    return context.json(
      { error: "Stop the Workflow before cancelling its collection lock." },
      409,
    );
  }
  await store.cancel(id);
  console.warn(
    `Cancelled collection ${id}; its publication lock was released.`,
  );
  return context.json({ runId: id, status: "cancelled" });
});
