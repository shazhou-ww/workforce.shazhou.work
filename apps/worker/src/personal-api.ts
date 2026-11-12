import { Auth } from "@auth/core";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { html } from "hono/html";
import { activityWindow } from "@shazhou-work/workforce-contracts";
import type { JWT } from "@auth/core/jwt";
import type {
  GitHubConnectResponse,
  GitHubDiscoveryResponse,
  InvitationRecord,
  PersonalActivityResponse,
  PersonalCollectionResponse,
  PersonalConfigResponse,
  PublicRepository,
} from "@shazhou-work/workforce-contracts";
import {
  createAuthConfig,
  linkCookieName,
  linkIntentId,
  requestToken,
  collectionAdminIds,
} from "./auth.js";
import { CollectionInputError, parseConfig } from "./collection-config.js";
import { CollectionStore } from "./collection-store.js";
import type { Bindings } from "./env.js";
import {
  assertPersonalActive,
  database,
  decryptCredential,
  githubConnection,
  personalLimits,
  PersonalError,
  platformAccess,
} from "./platform.js";

type PersonalEnv = {
  Bindings: Bindings;
  Variables: { userId: string; token: JWT; store: CollectionStore };
};
export const personalApi = new Hono<PersonalEnv>();

function personalErrorResponse(error: Error, context: Context<PersonalEnv>) {
  if (error instanceof PersonalError)
    return context.json(
      { error: error.message, code: error.code },
      error.status,
    );
  if (error instanceof CollectionInputError || error instanceof SyntaxError) {
    const field = error.message.match(
      /accounts|authorLogins|authorEmails|includeRepositories|excludeRepositories|repositoryMode|enabled/,
    )?.[0];
    return context.json(
      {
        error: error instanceof SyntaxError ? "Invalid JSON." : error.message,
        code: "invalid_configuration",
        ...(field ? { field } : {}),
      },
      422,
    );
  }
  console.error("Personal API request failed; sensitive details omitted.");
  return context.json(
    {
      error: "Personal service is temporarily unavailable.",
      code: "unavailable",
    },
    503,
  );
}
personalApi.onError(personalErrorResponse);

personalApi.use("*", async (context: Context<PersonalEnv, "*">, next) => {
  if (
    context.req.path !== "/api/platform/access" &&
    !context.req.path.startsWith("/api/personal/") &&
    !context.req.path.startsWith("/api/admin/")
  ) {
    await next();
    return;
  }
  context.header("Cache-Control", "private, no-store");
  context.header("Vary", "Cookie");
  try {
    if (!["GET", "HEAD"].includes(context.req.method)) {
      if (context.req.header("origin") !== new URL(context.req.url).origin)
        throw new PersonalError(
          "csrf_rejected",
          "A same-origin request is required.",
          403,
        );
    }
    const token = await requestToken(context.req.raw, context.env);
    if (context.req.path === "/api/platform/access") {
      return context.json(await platformAccess(context.env, token));
    }
    if (!token)
      throw new PersonalError(
        "authentication_required",
        "Sign in to continue.",
        401,
      );
    const access = await platformAccess(context.env, token);
    if (access.status !== "active" || !access.userId)
      throw new PersonalError(
        access.status,
        access.status === "suspended"
          ? "Your access is suspended."
          : "An invitation matching a trusted verified email is required.",
        403,
      );
    if (context.req.path.startsWith("/api/admin/") && !access.isAdmin)
      throw new PersonalError(
        "administrator_required",
        "Administrator access is required.",
        403,
      );
    context.set("userId", access.userId);
    context.set("token", token);
    context.set("store", new CollectionStore(context.env.DB!, access.userId));
    await next();
    return;
  } catch (error) {
    return personalErrorResponse(
      error instanceof Error ? error : new Error("Personal service failed."),
      context,
    );
  }
});

personalApi.get("/platform/access", (context) => context.json({}));

personalApi.get("/personal/config", async (context) => {
  const store = context.get("store");
  const active = await store.activeConfig();
  return context.json<PersonalConfigResponse>({
    config: active.revisionId ? await store.config(active.revisionId) : null,
    revisionId: active.revisionId,
    github: await githubConnection(context.env, context.get("userId")),
  });
});

personalApi.put("/personal/config", async (context) => {
  const github = await githubConnection(context.env, context.get("userId"));
  if (!github)
    throw new PersonalError(
      "github_connection_required",
      "Connect GitHub before saving your configuration.",
      409,
    );
  const parsed = parseConfig(await context.req.json<unknown>());
  const config = {
    ...parsed,
    authorLogins: [
      ...new Set([github.login.toLowerCase(), ...parsed.authorLogins]),
    ].sort(),
  };
  await validateScope(context.env, config);
  await assertPersonalActive(context.env, context.get("userId"));
  const revisionId = await context.get("store").saveConfig(config);
  return context.json<PersonalConfigResponse>({ config, revisionId, github });
});

personalApi.get("/personal/activity", async (context) => {
  const store = context.get("store");
  const row = await store.one<{
    snapshot_json: string | null;
    revision_id: string | null;
  }>(
    "SELECT s.snapshot_json,r.revision_id FROM personal_state s LEFT JOIN collection_runs r ON r.id=s.published_run_id WHERE s.id=?",
    context.get("userId"),
  );
  const active = await store.activeConfig();
  return context.json<PersonalActivityResponse>({
    snapshot: row?.snapshot_json
      ? (JSON.parse(row.snapshot_json) as PersonalActivityResponse["snapshot"])
      : null,
    revisionId: row?.revision_id ?? null,
    currentRevisionId: active.revisionId,
    stale: !!row?.revision_id && row.revision_id !== active.revisionId,
  });
});

async function progress(store: CollectionStore, runId: string) {
  const run = await store.run(runId);
  const counts = await store.one<{ completed: number; total: number }>(
    "SELECT COALESCE(sum(status='complete'),0) AS completed,count(*) AS total FROM run_repositories WHERE run_id=?",
    runId,
  );
  const error = await store.one<{ error_message: string | null }>(
    "SELECT error_message FROM collection_runs WHERE id=?",
    runId,
  );
  const wait = await store.one(
    "SELECT name FROM collection_waits WHERE run_id=? AND finished_at IS NULL LIMIT 1",
    runId,
  );
  return {
    runId,
    status: run.status,
    waiting:
      run.status === "queued" || (run.status === "collecting" && wait !== null),
    completedRepositories: counts?.completed ?? 0,
    totalRepositories: counts?.total ?? 0,
    until: run.until_at,
    error: error?.error_message ?? null,
    revisionId: run.revision_id,
    performance: await store.performance(
      runId,
      ["published", "failed", "cancelled", "blocked"].includes(run.status),
    ),
  };
}

personalApi.get("/personal/collection", async (context) => {
  const store = context.get("store");
  await reconcilePersonalRun(context.env, context.get("userId"));
  const row = await store.one<{
    active_run_id: string | null;
    last_refresh_at: string | null;
  }>(
    "SELECT s.active_run_id,u.last_refresh_at FROM personal_state s JOIN personal_users u ON u.id=s.id WHERE s.id=?",
    context.get("userId"),
  );
  const latest = await store.one<{ id: string }>(
    "SELECT r.id FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE c.config_id=? ORDER BY r.started_at DESC LIMIT 1",
    context.get("userId"),
  );
  return context.json<PersonalCollectionResponse>({
    activeRunId: row?.active_run_id ?? null,
    latestRun: latest ? await progress(store, latest.id) : null,
    nextRefreshAt: row?.last_refresh_at
      ? new Date(Date.parse(row.last_refresh_at) + 900_000).toISOString()
      : null,
  });
});

personalApi.get("/personal/collection/:runId", async (context) => {
  const store = context.get("store");
  await reconcilePersonalRun(context.env, context.get("userId"));
  const row = await store.one<{ id: string }>(
    "SELECT r.id FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id=?",
    context.req.param("runId"),
    context.get("userId"),
  );
  if (!row)
    throw new PersonalError("not_found", "Collection run not found.", 404);
  return context.json(await progress(store, row.id));
});

personalApi.post("/personal/collection", async (context) =>
  context.json(
    await startPersonalCollection(context.env, context.get("userId")),
    202,
  ),
);

export async function startPersonalCollection(
  env: Bindings,
  userId: string,
  scheduledAt?: number,
) {
  await assertPersonalActive(env, userId);
  if (
    !env.DB ||
    !env.COLLECTION ||
    !env.GH_TOKEN?.trim() ||
    (env.COLLECTION_EMAIL_KEY?.length ?? 0) < 32
  )
    throw new PersonalError(
      "collection_unavailable",
      "Collection bindings and secrets are not configured.",
      503,
    );
  await reconcilePersonalRun(env, userId);
  const store = new CollectionStore(env.DB, userId);
  const active = await store.activeConfig();
  if (!active.revisionId)
    throw new PersonalError(
      "configuration_required",
      "Save your configuration first.",
      409,
    );
  if (
    scheduledAt !== undefined &&
    (env.COLLECTION_ENABLED !== "true" || !active.enabled)
  )
    return null;
  const now = new Date(scheduledAt ?? Date.now()).toISOString();
  const runId = crypto.randomUUID();
  const revisionId = active.revisionId;
  const cutoff = new Date(Date.parse(now) - 900_000).toISOString();
  // Reserving state, live qualification, concurrency and cooldown in one SQLite
  // write prevents concurrent tabs or simultaneous cron/manual calls from racing.
  const window = activityWindow(new Date(now));
  await store.batch([
    store.statement(
      `INSERT INTO collection_runs(id,revision_id,status,since_at,until_at,started_at)
       SELECT ?,?,'queued',?,?,? WHERE EXISTS(
         SELECT 1 FROM personal_state s JOIN personal_users u ON u.id=s.id WHERE s.id=? AND s.active_run_id IS NULL AND u.status='active'
         AND (?=1 OR u.last_refresh_at IS NULL OR u.last_refresh_at<=?)
       ) AND (SELECT count(*) FROM personal_state WHERE active_run_id IS NOT NULL)<4`,
      runId,
      revisionId,
      window.since,
      window.until,
      now,
      userId,
      Number(scheduledAt !== undefined),
      cutoff,
    ),
    store.statement(
      "UPDATE personal_state SET active_run_id=? WHERE id=? AND EXISTS(SELECT 1 FROM collection_runs WHERE id=?)",
      runId,
      userId,
      runId,
    ),
    store.statement(
      "UPDATE personal_users SET last_refresh_at=?,last_scheduled_at=CASE WHEN ?=1 THEN ? ELSE last_scheduled_at END WHERE id=? AND EXISTS(SELECT 1 FROM collection_runs WHERE id=?)",
      now,
      Number(scheduledAt !== undefined),
      now,
      userId,
      runId,
    ),
  ]);
  if (!(await store.one("SELECT id FROM collection_runs WHERE id=?", runId)))
    throw new PersonalError(
      "refresh_limited",
      "A collection is active, global capacity is busy, or the 15 minute refresh cooldown has not elapsed.",
      429,
    );
  try {
    await env.COLLECTION.create({
      id: runId,
      params: { runId, revisionId, until: now, userId },
    });
  } catch {
    await store.failed(
      runId,
      "Workflow could not start. Try again after the refresh cooldown.",
    );
    await store
      .statement(
        "UPDATE personal_state SET active_run_id=NULL WHERE id=? AND active_run_id=?",
        userId,
        runId,
      )
      .run();
    throw new PersonalError(
      "collection_unavailable",
      "The collection could not start; previous results are retained.",
      503,
    );
  }
  return { runId };
}

export async function schedulePersonalCollections(
  env: Bindings,
  scheduledAt: number,
) {
  if (!env.DB || env.COLLECTION_ENABLED !== "true") return;
  const running = await database(env).rows<{ id: string }>(
    "SELECT id FROM personal_state WHERE active_run_id IS NOT NULL LIMIT 4",
  );
  for (const user of running) {
    try {
      await reconcilePersonalRun(env, user.id);
    } catch {
      console.warn(
        "Personal scheduled workflow inspection unavailable; scope deferred.",
      );
    }
  }
  const due = await database(env).rows<{ id: string }>(
    `SELECT u.id FROM personal_users u JOIN collection_configs c ON c.id=u.id JOIN personal_state s ON s.id=u.id
     WHERE u.status='active' AND c.enabled=1 AND c.active_revision_id IS NOT NULL AND s.active_run_id IS NULL
       AND (u.last_scheduled_at IS NULL OR u.last_scheduled_at<=?)
     ORDER BY COALESCE(u.last_scheduled_at,'') LIMIT 4`,
    new Date(scheduledAt - 3_600_000).toISOString(),
  );
  for (const user of due) {
    try {
      await startPersonalCollection(env, user.id, scheduledAt);
    } catch {
      console.warn(
        "Personal scheduled collection deferred; previous results retained.",
      );
    }
  }
}

async function reconcilePersonalRun(env: Bindings, userId: string) {
  if (!env.DB) return;
  const store = new CollectionStore(env.DB, userId);
  const state = await store.one<{ active_run_id: string | null }>(
    "SELECT active_run_id FROM personal_state WHERE id=?",
    userId,
  );
  if (!state?.active_run_id) return;
  let status: string;
  try {
    if (!env.COLLECTION) throw new Error("Workflow binding unavailable.");
    status = (await (await env.COLLECTION.get(state.active_run_id)).status())
      .status;
  } catch {
    console.warn(
      "Personal workflow inspection failed; active reservation retained.",
    );
    throw new PersonalError(
      "workflow_status_unavailable",
      "Collection status is temporarily unavailable. The active reservation and previous results are retained; retry shortly.",
      503,
    );
  }
  if (!["errored", "terminated", "complete"].includes(status)) return;
  await store.batch([
    store.statement(
      "UPDATE collection_runs SET status=?,error_message=? WHERE id=? AND status NOT IN ('published','cancelled')",
      status === "terminated" ? "cancelled" : "failed",
      "Workflow stopped. Previous complete results are retained; retry after the refresh cooldown.",
      state.active_run_id,
    ),
    store.statement(
      "UPDATE personal_state SET active_run_id=NULL WHERE id=? AND active_run_id=?",
      userId,
      state.active_run_id,
    ),
  ]);
}

async function githubRequest<T>(
  token: string,
  path: string,
): Promise<{ data: T; response: Response }> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "workforce-personal",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PersonalError(
      "github_unavailable",
      "GitHub is temporarily unavailable; saved selections are unchanged.",
      502,
    );
  }
  if (response.status === 401)
    throw new PersonalError(
      "github_connection_required",
      "GitHub authorization expired or was revoked. Reconnect GitHub.",
      409,
    );
  if (response.status === 404)
    throw new PersonalError(
      "repository_not_found",
      "Repository or account does not exist or is not visible to this authorization.",
      404,
    );
  if (response.status === 403)
    throw new PersonalError(
      "github_access_denied",
      "GitHub denied access (organization policy, missing permission, or rate limit). Saved selections are unchanged.",
      403,
    );
  if (!response.ok)
    throw new PersonalError(
      "github_unavailable",
      "GitHub could not validate the request. Retry; saved selections are unchanged.",
      502,
    );
  return { data: await response.json<T>(), response };
}

async function credential(env: Bindings, userId: string) {
  const row = await database(env).one<{ credential: string }>(
    "SELECT credential FROM personal_github WHERE user_id=?",
    userId,
  );
  if (!row?.credential)
    throw new PersonalError(
      "github_connection_required",
      "Connect GitHub to discover your organizations.",
      409,
    );
  return decryptCredential(env, userId, row.credential);
}

interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
  private: boolean;
  visibility?: string;
}
function publicRepo(repo: GitHubRepo): PublicRepository {
  if (repo.private || (repo.visibility && repo.visibility !== "public"))
    throw new PersonalError(
      "repository_not_public",
      "Only public repositories can be included.",
      422,
    );
  return { id: repo.id, fullName: repo.full_name, url: repo.html_url };
}
const repoPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i;
personalApi.get("/personal/github/repository", async (context) => {
  const name = context.req.query("name")?.trim();
  if (!name || !repoPattern.test(name))
    throw new PersonalError(
      "repository_invalid",
      "Use a repository name in owner/name format.",
      422,
    );
  return context.json(
    publicRepo(
      (
        await githubRequest<GitHubRepo>(
          await credential(context.env, context.get("userId")),
          `/repos/${name}`,
        )
      ).data,
    ),
  );
});

personalApi.get("/personal/github", async (context) => {
  const userId = context.get("userId");
  const github = await githubConnection(context.env, userId);
  const token = await credential(context.env, userId);
  const check = await githubRequest<{ id: number }>(token, "/user");
  if (String(check.data.id) !== github?.id)
    throw new PersonalError(
      "identity_mismatch",
      "Reconnect your original GitHub account.",
      409,
    );
  if (
    !(check.response.headers.get("x-oauth-scopes") ?? "")
      .split(/[, ]+/)
      .includes("read:org")
  )
    throw new PersonalError(
      "organization_permission_required",
      "Authorize read:org to discover joined organizations. Existing selections are unchanged.",
      403,
    );
  const organizations: GitHubDiscoveryResponse["organizations"][number][] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = (
      await githubRequest<{ id: number; login: string; avatar_url: string }[]>(
        token,
        `/user/orgs?per_page=100&page=${page}`,
      )
    ).data;
    organizations.push(
      ...rows.map((row) => ({
        id: row.id,
        login: row.login,
        avatarUrl: row.avatar_url,
      })),
    );
    if (rows.length < 100) break;
    if (page === 10)
      throw new PersonalError(
        "discovery_limit",
        "Organization discovery exceeded 1000 entries; use manual public accounts.",
        422,
      );
  }
  const repositories: PublicRepository[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = (
      await githubRequest<GitHubRepo[]>(
        token,
        `/users/${github.login}/repos?type=owner&per_page=100&page=${page}`,
      )
    ).data;
    repositories.push(...rows.map(publicRepo));
    if (rows.length < 100) break;
    if (page === 10)
      throw new PersonalError(
        "discovery_limit",
        "Repository suggestions exceeded 1000 entries; add repositories manually.",
        422,
      );
  }
  return context.json<GitHubDiscoveryResponse>({
    github,
    organizations,
    repositories,
    ...(context.env.AUTH_GITHUB_ID?.trim()
      ? {
          organizationAccessUrl: `https://github.com/settings/connections/applications/${encodeURIComponent(context.env.AUTH_GITHUB_ID.trim())}`,
        }
      : {}),
  });
});

personalApi.post("/personal/github/connect", async (context) => {
  const value = await context.req.json<{ organizations?: boolean }>();
  const id = crypto.randomUUID();
  const sessionId = context.get("token").platformSessionId;
  if (typeof sessionId !== "string")
    throw new PersonalError(
      "authentication_required",
      "Sign in again before connecting GitHub.",
      401,
    );
  await database(context.env)
    .statement(
      "INSERT INTO github_link_intents(id,user_id,session_binding,organizations,expires_at) VALUES (?,?,?,?,?)",
      id,
      context.get("userId"),
      sessionId,
      Number(value.organizations === true),
      new Date(Date.now() + 600_000).toISOString(),
    )
    .run();
  setCookie(context, linkCookieName(context.req.raw), id, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return context.json<GitHubConnectResponse>({
    url: "/api/personal/github/authorize",
  });
});

personalApi.get("/personal/github/authorize", async (context) => {
  const id = linkIntentId(context.req.raw);
  const intent = await database(context.env).one<{ organizations: number }>(
    "SELECT organizations FROM github_link_intents WHERE id=? AND user_id=? AND session_binding=? AND consumed_at IS NULL AND expires_at>?",
    id,
    context.get("userId"),
    String(context.get("token").platformSessionId),
    new Date().toISOString(),
  );
  if (!intent)
    throw new PersonalError(
      "link_expired",
      "Start a new GitHub connection request.",
      403,
    );
  const response = await Auth(
    new Request(new URL("/api/auth/csrf", context.req.url), {
      headers: context.req.raw.headers,
    }),
    createAuthConfig(context.env, context.req.raw),
  );
  const csrf = await response.json<{ csrfToken: string }>();
  for (const cookie of response.headers.getSetCookie())
    context.header("Set-Cookie", cookie, { append: true });
  const scope = intent.organizations
    ? "read:user user:email read:org"
    : "read:user user:email";
  const action = `/api/auth/signin/github?scope=${encodeURIComponent(scope)}`;
  const callbackUrl = intent.organizations
    ? "/?personal=configure&github=organizations"
    : "/?personal=configure";
  if (!/^[a-f\d]+$/i.test(csrf.csrfToken))
    throw new PersonalError(
      "unavailable",
      "Could not initialize OAuth CSRF protection.",
      503,
    );
  return context.html(
    html`<!doctype html>
      <html lang="en">
        <meta charset="utf-8" /><title>Connect GitHub</title>
        <body>
          <form method="post" action="${action}">
            <input
              type="hidden"
              name="csrfToken"
              value="${csrf.csrfToken}"
            /><input
              type="hidden"
              name="callbackUrl"
              value="${callbackUrl}"
            /><button>Continue to GitHub</button>
          </form>
          <script>
            document.forms[0].submit();
          </script>
        </body>
      </html>`,
  );
});

async function validateScope(
  env: Bindings,
  config: ReturnType<typeof parseConfig>,
) {
  const token = env.GH_TOKEN;
  if (!token)
    throw new PersonalError(
      "collection_unavailable",
      "Collection credentials are unavailable.",
      503,
    );
  const excludedIds = new Set<number>();
  for (const name of config.excludeRepositories)
    excludedIds.add(
      publicRepo(
        (await githubRequest<GitHubRepo>(token, `/repos/${name}`)).data,
      ).id,
    );
  const repositories = new Set<number>();
  const add = (repo: GitHubRepo) => {
    publicRepo(repo);
    if (!excludedIds.has(repo.id)) repositories.add(repo.id);
    if (repositories.size > personalLimits.repositories)
      throw new PersonalError(
        "repository_limit",
        `Expanded scope exceeds ${personalLimits.repositories} public repositories. Narrow the scope or add exclusions.`,
        422,
      );
  };
  if (config.repositoryMode === "all_owned_public") {
    for (const account of config.accounts) {
      for (let page = 1; page <= 11; page++) {
        const rows = (
          await githubRequest<GitHubRepo[]>(
            token,
            `/users/${account}/repos?type=owner&per_page=100&page=${page}`,
          )
        ).data;
        rows.forEach(add);
        if (rows.length < 100) break;
        if (page === 11)
          throw new PersonalError(
            "discovery_limit",
            "Account discovery exceeds the bounded validation budget. Use explicit repositories.",
            422,
          );
      }
    }
  }
  for (const name of config.includeRepositories)
    add((await githubRequest<GitHubRepo>(token, `/repos/${name}`)).data);
}

personalApi.get("/admin/invitations", async (context) => {
  const invitations = await database(context.env).rows<InvitationRecord>(
    `SELECT i.id,i.email,CASE WHEN i.status='claimed' THEN u.status ELSE i.status END AS status,
     i.user_id AS userId,i.created_at AS createdAt FROM invitations i LEFT JOIN personal_users u ON u.id=i.user_id ORDER BY i.created_at DESC`,
  );
  return context.json({ invitations });
});

personalApi.post("/admin/invitations", async (context) => {
  const body = await context.req.json<{ email?: unknown }>();
  if (
    typeof body.email !== "string" ||
    body.email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
  )
    throw new PersonalError(
      "email_invalid",
      "Enter a valid invitation email.",
      422,
    );
  const email = body.email.trim().toLowerCase();
  const store = database(context.env);
  const previous = await store.one<{ status: string }>(
    "SELECT status FROM invitations WHERE email=?",
    email,
  );
  if (previous && previous.status !== "revoked")
    throw new PersonalError(
      "invitation_exists",
      "This email already has an invitation or user.",
      409,
    );
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await store.batch([
    store.statement(
      "DELETE FROM invitations WHERE email=? AND status='revoked' AND user_id IS NULL",
      email,
    ),
    store.statement(
      "INSERT INTO invitations VALUES (?,?,'pending',NULL,?,?)",
      id,
      email,
      now,
      now,
    ),
    store.statement(
      "INSERT INTO personal_audit VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      context.get("userId"),
      "invite",
      id,
      now,
    ),
  ]);
  return context.json<InvitationRecord>(
    { id, email, status: "pending", userId: null, createdAt: now },
    201,
  );
});

personalApi.post("/admin/invitations/:id", async (context) => {
  const body = await context.req.json<{ action?: unknown }>();
  const id = context.req.param("id");
  const store = database(context.env);
  const row = await store.one<{ status: string; user_id: string | null }>(
    "SELECT status,user_id FROM invitations WHERE id=?",
    id,
  );
  if (!row) throw new PersonalError("not_found", "Invitation not found.", 404);
  const action = body.action;
  if (!["revoke", "suspend", "restore"].includes(String(action)))
    throw new PersonalError(
      "action_invalid",
      "Choose revoke, suspend or restore.",
      422,
    );
  if (action === "revoke" && row.status !== "pending")
    throw new PersonalError(
      "invalid_transition",
      "Only pending invitations can be revoked.",
      409,
    );
  if (action !== "revoke" && !row.user_id)
    throw new PersonalError(
      "invalid_transition",
      "This invitation has not been claimed.",
      409,
    );
  if (row.user_id) {
    const github = await store.one<{ provider_id: string }>(
      "SELECT provider_id FROM personal_identities WHERE user_id=? AND provider='github'",
      row.user_id,
    );
    if (github && collectionAdminIds(context.env).includes(github.provider_id))
      throw new PersonalError(
        "bootstrap_protected",
        "Bootstrap administrators cannot be suspended here.",
        403,
      );
  }
  const now = new Date().toISOString();
  const statements = [
    store.statement(
      "INSERT INTO personal_audit VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      context.get("userId"),
      String(action),
      row.user_id ?? id,
      now,
    ),
  ];
  if (action === "revoke")
    statements.push(
      store.statement(
        "UPDATE invitations SET status='revoked',updated_at=? WHERE id=? AND status='pending'",
        now,
        id,
      ),
    );
  else {
    statements.push(
      store.statement(
        "UPDATE personal_users SET status=? WHERE id=?",
        action === "suspend" ? "suspended" : "active",
        row.user_id,
      ),
    );
    if (action === "suspend") {
      statements.push(
        store.statement(
          "UPDATE collection_runs SET status='cancelled',error_message='Personal access was suspended.' WHERE revision_id IN (SELECT id FROM config_revisions WHERE config_id=?) AND status IN ('queued','collecting','ready','failed')",
          row.user_id,
        ),
        store.statement(
          "UPDATE personal_state SET active_run_id=NULL WHERE id=?",
          row.user_id,
        ),
      );
    }
  }
  await store.batch(statements);
  return context.json({ ok: true });
});
