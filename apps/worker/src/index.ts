import { authHandler, initAuthConfig, verifyAuth } from "@hono/auth-js";
import type { Session } from "@auth/core/types";
import type {
  BootstrapResponse,
  ActivitySnapshot,
  HealthResponse,
  SessionResponse,
} from "@shazhou-work/workforce-contracts";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import {
  canCollectActivity,
  createAuthConfig,
  getConfiguredProviders,
} from "./auth.js";
import type { Bindings } from "./env.js";
import { collectionApi } from "./collection-api.js";
import { manualCollectionApi } from "./manual-collection-api.js";
import { personalApi } from "./personal-api.js";
import { deleteCookie } from "hono/cookie";
import { linkCookieName } from "./auth.js";
import { publicPersonalSnapshot } from "./public-activity.js";

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", secureHeaders());
app.use(
  "*",
  initAuthConfig((context) =>
    createAuthConfig(context.env as Bindings, context.req.raw),
  ),
);

app.use(
  "/api/auth/callback/github",
  async (
    context: Context<{ Bindings: Bindings }, "/api/auth/callback/github">,
    next,
  ) => {
    await next();
    deleteCookie(context, linkCookieName(context.req.raw), {
      path: "/",
      secure: new URL(context.req.url).protocol === "https:",
    });
  },
);
app.use("/api/auth/*", authHandler());
app.route("/api/collection", collectionApi);
app.route("/api/activity/collection", manualCollectionApi);
app.route("/api", personalApi);

app.get("/api/health", (context) =>
  context.json<HealthResponse>({
    service: context.env.APP_NAME,
    status: "ok",
  }),
);

app.get("/api/activity", async (context) => {
  const snapshot = context.env.PUBLIC_ACTIVITY_GITHUB_ID
    ? await publicPersonalSnapshot(context.env)
    : await context.env.STATS.get<ActivitySnapshot>("activity:v1", "json");
  if (!snapshot) {
    return context.json(
      {
        error:
          "尚无统计快照。请配置 Cloudflare 采集任务并将完整结果写入 STATS KV。",
      },
      503,
    );
  }
  context.header("Cache-Control", "public, max-age=60");
  return context.json(snapshot);
});

app.onError((error, context) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }
  console.error("Worker request failed", error);
  return context.json({ error: "读取统计数据失败，请稍后重试。" }, 500);
});

app.get("/api/bootstrap", (context) =>
  context.json<BootstrapResponse>({
    appName: context.env.APP_NAME,
    providers: getConfiguredProviders(context.env),
  }),
);

app.use("/api/me", verifyAuth());
app.get("/api/me", (context) => {
  const user = context.get("authUser");
  context.header("Cache-Control", "no-store");
  return context.json({
    ...toSessionResponse(user.session),
    canCollect: canCollectActivity(user, context.env),
  });
});

app.notFound((context) =>
  context.json(
    {
      error: "Not found",
    },
    404,
  ),
);

export default app;

export function toSessionResponse(session: Session): SessionResponse {
  return {
    expires: session.expires,
    ...(session.user ? { user: session.user } : {}),
  };
}
