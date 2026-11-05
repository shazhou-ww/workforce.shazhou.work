import { authHandler, initAuthConfig, verifyAuth } from "@hono/auth-js";
import type { Session } from "@auth/core/types";
import type {
  BootstrapResponse,
  ActivitySnapshot,
  HealthResponse,
  SessionResponse,
} from "@workspace/contracts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import { createAuthConfig, getConfiguredProviders } from "./auth.js";
import type { Bindings } from "./env.js";

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", secureHeaders());
app.use(
  "*",
  initAuthConfig((context) => createAuthConfig(context.env as Bindings)),
);

app.use("/api/auth/*", authHandler());

app.get("/api/health", (context) =>
  context.json<HealthResponse>({
    service: context.env.APP_NAME,
    status: "ok",
  }),
);

app.get("/api/activity", async (context) => {
  const snapshot = await context.env.STATS.get<ActivitySnapshot>(
    "activity:v1",
    "json",
  );
  if (!snapshot) {
    return context.json(
      { error: "尚无统计快照。请运行 GitHub 采集任务并将结果写入 STATS KV。" },
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
  const session = context.get("authUser").session;
  return context.json(toSessionResponse(session));
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
