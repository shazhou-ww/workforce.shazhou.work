import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { encode } from "@auth/core/jwt";
import type { JWT } from "@auth/core/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { createAuthConfig } from "../src/auth.js";
import type { Bindings } from "../src/env.js";
import { CollectionStore } from "../src/collection-store.js";
import { parseConfig } from "../src/collection-config.js";
import {
  decryptCredential,
  encryptCredential,
  githubIdentity,
  githubCredential,
  githubCredentialGeneration,
  platformAccess,
  registerIdentity,
  retainGitHub,
} from "../src/platform.js";
import {
  schedulePersonalCollections,
  startPersonalCollection,
} from "../src/personal-api.js";
import { runCollection } from "../src/collection.js";
import { TestD1 } from "./d1.js";
import type {
  ActivitySnapshot,
  PlatformAccessResponse,
} from "@shazhou-work/workforce-contracts";
import { activityWindow } from "@shazhou-work/workforce-contracts";

const origin = "https://example.test";
const secret = "personal-test-secret-longer-than-thirty-two-characters";
const config = {
  enabled: true,
  accounts: ["primary"],
  authorLogins: ["primary"],
  authorEmails: ["history@example.invalid"],
  repositoryMode: "explicit" as const,
  includeRepositories: ["primary/public"],
  excludeRepositories: [],
};
const github = {
  id: "101",
  login: "primary",
  avatarUrl: "https://avatars.githubusercontent.com/u/101",
};
const publicRepository = {
  id: 501,
  full_name: "primary/public",
  html_url: "https://github.com/primary/public",
  private: false,
  visibility: "public",
  owner: { id: 101, login: "primary", type: "User" },
};

function fixture() {
  const db = new TestD1();
  const create = vi
    .fn()
    .mockImplementation(({ id }: { id: string }) => ({ id }));
  const put = vi.fn();
  const getWorkflow = vi.fn().mockResolvedValue({
    status: () => Promise.resolve({ status: "running" }),
  });
  const env = {
    APP_NAME: "Workforce",
    DB: db,
    AUTH_SECRET: secret,
    AUTH_GITHUB_ID: "github-id",
    AUTH_GITHUB_SECRET: "github-secret",
    AUTH_GOOGLE_ID: "google-id",
    AUTH_GOOGLE_SECRET: "google-secret",
    COLLECTION_ADMIN_GITHUB_IDS: "999",
    COLLECTION_ENABLED: "true",
    COLLECTION_EMAIL_KEY: secret,
    GH_TOKEN: "server-token",
    COLLECTION: { create, get: getWorkflow },
    STATS: { put, get: vi.fn() },
  } as unknown as Bindings;
  return { db, env, create, put, getWorkflow, store: new CollectionStore(db) };
}
async function invite(env: Bindings, email = "invitee@example.invalid") {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await new CollectionStore(env.DB!)
    .statement(
      "INSERT INTO invitations VALUES (?,?,'pending',NULL,?,?)",
      id,
      email,
      now,
      now,
    )
    .run();
  return id;
}
async function user(
  env: Bindings,
  providerId = "101",
  email = "invitee@example.invalid",
) {
  await invite(env, email);
  const id = await registerIdentity(env, "github", providerId, [email]);
  if (!id) throw new Error("Invitation was not claimed.");
  await retainGitHub(
    env,
    id,
    { ...github, id: providerId },
    "oauth-private-token",
    "read:user,user:email,read:org",
  );
  return id;
}
async function session(userId: string | null, extra: JWT = {}) {
  const name = "__Secure-authjs.session-token";
  return `${name}=${await encode({ token: { sub: "stable-provider-id", platformUserId: userId, platformSessionId: "stable-session", verifiedEmail: true, ...extra }, secret, salt: name })}`;
}
async function call(
  env: Bindings,
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
  requestOrigin: string | null = origin,
) {
  return app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}
async function jwtCallback(
  env: Bindings,
  input: {
    provider?: string;
    providerId?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshExpiresIn?: number;
    profile?: Record<string, unknown>;
  } = {},
  request?: Request,
) {
  const callback = createAuthConfig(env, request).callbacks!.jwt!;
  return callback({
    token: {},
    user: { id: "provider-user" },
    account: {
      provider: input.provider ?? "github",
      providerAccountId: input.providerId ?? "101",
      type: "oauth",
      access_token: input.accessToken ?? "oauth-private-token",
      ...(input.refreshToken === undefined
        ? {}
        : { refresh_token: input.refreshToken }),
      ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
      ...(input.refreshExpiresIn === undefined
        ? {}
        : { refresh_token_expires_in: input.refreshExpiresIn }),
    },
    profile: input.profile ?? {},
    trigger: "signIn",
  });
}
function githubFetch(
  options: {
    id?: number;
    verified?: boolean;
    orgPermission?: boolean;
    status?: number;
    name?: string | null;
    login?: string;
  } = {},
) {
  const login = options.login ?? "primary";
  const repository = {
    ...publicRepository,
    full_name: `${login}/public`,
    html_url: `https://github.com/${login}/public`,
    owner: { ...publicRepository.owner, login },
  };
  return vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (options.status)
      return Promise.resolve(Response.json({}, { status: options.status }));
    if (url.endsWith("/user/emails"))
      return Promise.resolve(
        Response.json([
          {
            email: "invitee@example.invalid",
            verified: options.verified ?? true,
          },
        ]),
      );
    if (url.endsWith("/user"))
      return Promise.resolve(
        Response.json(
          {
            id: options.id ?? 101,
            login,
            name: options.name ?? null,
            avatar_url: github.avatarUrl,
          },
          {
            headers: {
              "x-oauth-scopes":
                options.orgPermission === false
                  ? "read:user,user:email"
                  : "read:user,user:email,read:org",
            },
          },
        ),
      );
    if (url.endsWith(`/users/${login}`))
      return Promise.resolve(Response.json(repository.owner));
    if (url.includes("/user/orgs"))
      return Promise.resolve(
        Response.json([
          {
            id: 300,
            login: "joined-org",
            avatar_url: "https://avatars.githubusercontent.com/u/300",
          },
        ]),
      );
    if (url.includes("/repos?"))
      return Promise.resolve(Response.json([repository]));
    if (url.includes("/repos/"))
      return Promise.resolve(Response.json(repository));
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("personal access and invitations", () => {
  it("publishes and revokes a managed user's underscore profile address", async () => {
    const { env } = fixture();
    await invite(env);
    vi.stubGlobal("fetch", githubFetch({ login: "Managed-User_Microsoft" }));
    const token = await jwtCallback(env);
    if (typeof token?.platformUserId !== "string")
      throw new Error("Managed-user invitation was not claimed.");
    const cookie = await session(token.platformUserId);
    const publish = await call(env, "/personal/profile", cookie, "PUT", {
      enabled: true,
    });
    expect(publish.status).toBe(200);
    expect(await publish.json()).toEqual({
      publicPath: "/u/managed-user_microsoft",
    });
    const profile = await call(env, "/profiles/MANAGED-USER_MICROSOFT");
    expect(profile.status).toBe(200);
    expect(await profile.json()).toEqual({
      login: "managed-user_microsoft",
      snapshot: null,
    });
    await call(env, "/personal/profile", cookie, "PUT", { enabled: false });
    expect((await call(env, "/profiles/managed-user_microsoft")).status).toBe(
      404,
    );
  });

  it("publishes only an opted-in owner's snapshot and revokes anonymous access immediately", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    const other = await user(env, "202", "other@example.invalid");
    const otherCookie = await session(other);
    const daily = activityWindow(new Date("2026-11-12T08:00:00Z")).dates.map(
      (date) => ({
        date,
        commits: 1,
        additions: 2,
        deletions: 1,
        averageLines: 3,
        credential: "must-not-be-published",
      }),
    );
    await store
      .statement(
        "UPDATE personal_github SET login='other' WHERE user_id=?",
        other,
      )
      .run();
    await store
      .statement(
        "UPDATE personal_state SET snapshot_json=? WHERE id=?",
        JSON.stringify({
          version: 1,
          accounts: ["primary"],
          generatedAt: "2026-11-12T08:00:00Z",
          since: "2026-10-14T16:00:00Z",
          until: "2026-11-12T08:00:00Z",
          timezone: "Asia/Shanghai",
          days: 30,
          totals: { commits: 1, additions: 2, deletions: 1, averageLines: 3 },
          daily,
          repositories: [
            {
              name: "primary/public",
              url: "https://github.com/primary/public",
              description: null,
              defaultBranch: "main",
              fork: false,
              archived: false,
              latestCommit: null,
              daily,
              commits: 1,
              additions: 2,
              deletions: 1,
              averageLines: 3,
              authorEmails: ["secret@example.invalid"],
            },
          ],
          credential: "must-not-be-published",
          authorEmails: ["secret@example.invalid"],
        }),
        id,
      )
      .run();
    expect(await (await call(env, "/personal/profile", cookie)).json()).toEqual(
      { publicPath: null },
    );
    expect((await call(env, "/profiles/primary")).status).toBe(404);
    expect(
      (await call(env, "/personal/profile", "", "PUT", { enabled: true }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          env,
          "/personal/profile",
          cookie,
          "PUT",
          { enabled: true },
          "https://evil.invalid",
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(env, "/personal/profile", cookie, "PUT", { enabled: "yes" }))
        .status,
    ).toBe(422);
    const published = await call(env, "/personal/profile", cookie, "PUT", {
      enabled: true,
    });
    expect(await published.json()).toEqual({ publicPath: "/u/primary" });
    expect(published.headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      await (await call(env, "/personal/profile", otherCookie)).json(),
    ).toEqual({ publicPath: null });
    const response = await call(env, "/profiles/PRIMARY");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<{
      login: string;
      snapshot: ActivitySnapshot;
    }>();
    expect(Object.keys(body)).toEqual(["login", "snapshot"]);
    expect(body.login).toBe("primary");
    expect(body.snapshot.totals.commits).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(
      /secret@|must-not|credential|authorEmails|revisionId|runId/,
    );
    expect((await call(env, "/profiles/other")).status).toBe(404);
    await call(env, "/personal/profile", cookie, "PUT", { enabled: false });
    const hidden = await call(env, "/profiles/primary");
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("Cache-Control")).toBe("no-store");
    await call(env, "/personal/profile", cookie, "PUT", { enabled: true });
    await store
      .statement("UPDATE personal_users SET status='suspended' WHERE id=?", id)
      .run();
    expect((await call(env, "/profiles/primary")).status).toBe(404);
    expect(
      (await call(env, "/personal/profile", cookie, "PUT", { enabled: true }))
        .status,
    ).toBe(403);
  });

  it("requires a connected GitHub identity and does not take another user's profile address", async () => {
    const { env, store } = fixture();
    const first = await user(env);
    await call(env, "/personal/profile", await session(first), "PUT", {
      enabled: true,
    });
    const second = await user(env, "202", "second@example.invalid");
    expect(
      (
        await call(env, "/personal/profile", await session(second), "PUT", {
          enabled: true,
        })
      ).status,
    ).toBe(409);
    expect(await (await call(env, "/profiles/primary")).json()).toEqual({
      login: "primary",
      snapshot: null,
    });
    await store
      .statement("DELETE FROM personal_github WHERE user_id=?", second)
      .run();
    expect(
      (
        await call(env, "/personal/profile", await session(second), "PUT", {
          enabled: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(env, "/personal/profile", await session(second), "PUT", {
          enabled: false,
        })
      ).status,
    ).toBe(200);
  });

  it("uses only trusted verified invitations, stable IDs, and never merges email identities", async () => {
    const { env, store } = fixture();
    const invitation = await invite(env, "mixed+tag@example.invalid");
    expect(await registerIdentity(env, "github", "101", [])).toBeNull();
    expect(
      await registerIdentity(env, "github", "101", ["mixed@example.invalid"]),
    ).toBeNull();
    const id = await registerIdentity(env, "github", "101", [
      " MIXED+TAG@EXAMPLE.INVALID ",
    ]);
    expect(id).toBeTruthy();
    expect(await registerIdentity(env, "github", "101", [])).toBe(id);
    expect(
      await registerIdentity(env, "google", "different-sub", [
        "mixed+tag@example.invalid",
      ]),
    ).toBeNull();
    expect(
      await store.one(
        "SELECT user_id,status FROM invitations WHERE id=?",
        invitation,
      ),
    ).toEqual({ user_id: id, status: "claimed" });
    expect((await store.rows("SELECT id FROM personal_users")).length).toBe(1);
  });

  it("bootstraps administrators only from stable configured numeric GitHub IDs", async () => {
    const { env } = fixture();
    expect(await registerIdentity(env, "google", "999", [])).toBeNull();
    const id = await registerIdentity(env, "github", "999", []);
    expect(await platformAccess(env, { platformUserId: id })).toMatchObject({
      status: "active",
      isAdmin: true,
    });
    expect(await platformAccess(env, null)).toMatchObject({
      status: "signed_out",
    });
    expect(await platformAccess(env, {})).toMatchObject({
      status: "verification_required",
    });
    expect(await platformAccess(env, { verifiedEmail: true })).toMatchObject({
      status: "uninvited",
    });
    expect(
      await platformAccess(env, { platformUserId: crypto.randomUUID() }),
    ).toMatchObject({ status: "uninvited" });
  });

  it("rejects every protected read/mutation when signed out or suspended; checks CSRF", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    expect((await call(env, "/platform/access")).status).toBe(200);
    expect((await call(env, "/personal/config")).status).toBe(401);
    expect(
      (await call(env, "/personal/config", await session(null))).status,
    ).toBe(403);
    expect(
      (
        await call(
          env,
          "/personal/config",
          cookie,
          "PUT",
          config,
          "https://evil.invalid",
        )
      ).status,
    ).toBe(403);
    expect(
      (await call(env, "/personal/config", cookie, "PUT", config, null)).status,
    ).toBe(403);
    expect((await call(env, "/admin/invitations", cookie)).status).toBe(403);
    await store
      .statement("UPDATE personal_users SET status='suspended' WHERE id=?", id)
      .run();
    for (const [path, method] of [
      ["/personal/config", "GET"],
      ["/personal/activity", "GET"],
      ["/personal/collection", "GET"],
      ["/personal/github", "GET"],
      ["/personal/collection", "POST"],
      ["/personal/config", "PUT"],
    ]) {
      expect(
        (
          await call(
            env,
            path!,
            cookie,
            method,
            method === "PUT" ? config : undefined,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await (
          await call(env, "/platform/access", cookie)
        ).json<PlatformAccessResponse>()
      ).status,
    ).toBe("suspended");
  });

  it("supports audited invitation revoke/reinvite and live suspend/restore without changing config toggles", async () => {
    const { env, store } = fixture();
    const adminId = await registerIdentity(env, "github", "999", []);
    const adminCookie = await session(adminId);
    const created = await call(env, "/admin/invitations", adminCookie, "POST", {
      email: " Pending+Tag@Example.Invalid ",
    });
    expect(created.status).toBe(201);
    const invitation = await created.json<{ id: string; email: string }>();
    expect(invitation.email).toBe("pending+tag@example.invalid");
    expect(
      (
        await call(env, "/admin/invitations", adminCookie, "POST", {
          email: invitation.email,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          env,
          `/admin/invitations/${invitation.id}`,
          adminCookie,
          "POST",
          { action: "restore" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          env,
          `/admin/invitations/${invitation.id}`,
          adminCookie,
          "POST",
          { action: "revoke" },
        )
      ).status,
    ).toBe(200);
    expect(
      await registerIdentity(env, "github", "202", [invitation.email]),
    ).toBeNull();
    const reinvited = await (
      await call(env, "/admin/invitations", adminCookie, "POST", {
        email: invitation.email,
      })
    ).json<{ id: string }>();
    expect(reinvited.id).not.toBe(invitation.id);
    const id = await registerIdentity(env, "github", "202", [invitation.email]);
    await retainGitHub(
      env,
      id!,
      { ...github, id: "202" },
      "oauth-private-token",
      "read:user,user:email,read:org",
    );
    const scoped = new CollectionStore(env.DB!, id!);
    await scoped.saveConfig(config);
    const started = await startPersonalCollection(env, id!);
    expect(started).toBeTruthy();
    expect(
      (
        await call(
          env,
          `/admin/invitations/${reinvited.id}`,
          adminCookie,
          "POST",
          { action: "suspend" },
        )
      ).status,
    ).toBe(200);
    expect((await scoped.run(started!.runId)).status).toBe("cancelled");
    await scoped.failed(started!.runId, "A late workflow error.");
    await scoped.published(started!.runId);
    expect((await scoped.run(started!.runId)).status).toBe("cancelled");
    expect(await scoped.ownsRun(started!.runId)).toBe(false);
    await expect(startPersonalCollection(env, id!)).rejects.toMatchObject({
      code: "access_stopped",
    });
    expect(
      (
        await call(
          env,
          `/admin/invitations/${reinvited.id}`,
          adminCookie,
          "POST",
          { action: "restore" },
        )
      ).status,
    ).toBe(200);
    expect((await scoped.activeConfig()).enabled).toBe(1);
    expect((await scoped.run(started!.runId)).status).toBe("cancelled");
    const listing = await (
      await call(env, "/admin/invitations", adminCookie)
    ).json<{ invitations: { status: string }[] }>();
    expect(listing.invitations.some((row) => row.status === "active")).toBe(
      true,
    );
    expect((await store.rows("SELECT action FROM personal_audit")).length).toBe(
      5,
    );
  });

  it("rejects invalid admin operations and protects bootstrap identities", async () => {
    const { env, store } = fixture();
    const id = await user(env, "999");
    const cookie = await session(id);
    const invitation = await store.one<{ id: string }>(
      "SELECT id FROM invitations LIMIT 1",
    );
    await store
      .statement(
        "UPDATE invitations SET status='claimed',user_id=? WHERE id=?",
        id,
        invitation!.id,
      )
      .run();
    for (const value of [null, 3, "", "not-email"])
      expect(
        (
          await call(env, "/admin/invitations", cookie, "POST", {
            email: value,
          })
        ).status,
      ).toBe(422);
    expect(
      (
        await call(env, "/admin/invitations/missing", cookie, "POST", {
          action: "revoke",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          env,
          `/admin/invitations/${invitation!.id}`,
          cookie,
          "POST",
          { action: "wrong" },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await call(
          env,
          `/admin/invitations/${invitation!.id}`,
          cookie,
          "POST",
          { action: "suspend" },
        )
      ).status,
    ).toBe(403);
  });
});

describe("OAuth identities and protected credentials", () => {
  const renewedTokens = {
    access_token: "renewed-access-token",
    refresh_token: "rotated-refresh-token",
    expires_in: 28800,
    refresh_token_expires_in: 15811200,
  };

  async function expiringConnection(env: Bindings, id: string, seconds = 299) {
    const now = Math.floor(Date.now() / 1000);
    await retainGitHub(env, id, github, "old-access-token", "read:org", fetch, {
      refreshToken: "old-refresh-token",
      expiresAt: now + seconds,
      refreshExpiresAt: now + 86400,
    });
    return now;
  }

  it("encrypts refresh tokens from OAuth callbacks without exposing them in sessions or APIs", async () => {
    const { env, store } = fixture();
    await invite(env);
    vi.stubGlobal("fetch", githubFetch());
    const expiresAt = Math.floor(Date.now() / 1000) + 28800;
    const token = await jwtCallback(env, {
      refreshToken: "callback-refresh-secret",
      expiresAt,
      refreshExpiresIn: 86400,
    });
    const id = token?.platformUserId;
    if (typeof id !== "string") throw new Error("Missing personal test user.");
    const row = await store.one<{
      refresh_credential: string;
      expires_at: number;
      refresh_expires_at: number;
    }>(
      "SELECT refresh_credential,expires_at,refresh_expires_at FROM personal_github WHERE user_id=?",
      id,
    );
    expect(await decryptCredential(env, id, row!.refresh_credential)).toBe(
      "callback-refresh-secret",
    );
    expect(row!.expires_at).toBe(expiresAt);
    expect(row!.refresh_expires_at).toBeGreaterThan(expiresAt);
    const access = await platformAccess(env, token);
    const response = await call(env, "/personal/github", await session(id));
    for (const value of [token, access, await response.json(), row])
      expect(JSON.stringify(value)).not.toContain("callback-refresh-secret");
  });

  it("rotates both tokens before expiry and keeps the connection generation stable", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const now = await expiringConnection(env, id);
    const generation = await githubCredentialGeneration(env, id);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(renewedTokens));
    expect(await githubCredential(env, id, request, generation)).toBe(
      renewedTokens.access_token,
    );
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://github.com/login/oauth/access_token");
    if (!(init?.body instanceof URLSearchParams))
      throw new Error("Missing OAuth refresh form.");
    const form = init.body;
    expect(form.get("refresh_token")).toBe("old-refresh-token");
    expect(form.get("client_secret")).toBe("github-secret");
    const row = await store.one<{
      credential: string;
      refresh_credential: string;
      expires_at: number;
      refresh_expires_at: number;
      refresh_lock: string | null;
    }>("SELECT * FROM personal_github WHERE user_id=?", id);
    expect(await decryptCredential(env, id, row!.credential)).toBe(
      renewedTokens.access_token,
    );
    expect(await decryptCredential(env, id, row!.refresh_credential)).toBe(
      renewedTokens.refresh_token,
    );
    expect(row!.expires_at).toBeGreaterThanOrEqual(now + 28800);
    expect(row!.refresh_expires_at).toBeGreaterThanOrEqual(now + 15811200);
    expect(row!.refresh_lock).toBeNull();
    expect(await githubCredentialGeneration(env, id)).toBe(generation);
    expect(await githubCredential(env, id, request)).toBe(
      renewedTokens.access_token,
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("renews only once when two requests concurrently use an expiring token", async () => {
    const { env } = fixture();
    const id = await user(env);
    await expiringConnection(env, id);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json(renewedTokens);
    });
    expect(
      await Promise.all([
        githubCredential(env, id, request),
        githubCredential(env, id, request),
      ]),
    ).toEqual([renewedTokens.access_token, renewedTokens.access_token]);
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not renew non-expiring OAuth tokens or tokens outside the five-minute window", async () => {
    const { env } = fixture();
    const id = await user(env);
    const request = vi.fn<typeof fetch>();
    expect(await githubCredential(env, id, request)).toBe(
      "oauth-private-token",
    );
    await expiringConnection(env, id, 600);
    expect(await githubCredential(env, id, request)).toBe("old-access-token");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([300, 301])(
    "checks the exact five-minute renewal boundary (%s seconds)",
    async (seconds) => {
      vi.spyOn(Date, "now").mockReturnValue(1794564600000);
      const { env } = fixture();
      const id = await user(env);
      await expiringConnection(env, id, seconds);
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(renewedTokens));
      expect(await githubCredential(env, id, request)).toBe(
        seconds === 300 ? renewedTokens.access_token : "old-access-token",
      );
      expect(request).toHaveBeenCalledTimes(seconds === 300 ? 1 : 0);
    },
  );

  it("preserves refresh metadata when retaining a verified organization credential after a basic login", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    await expiringConnection(env, id, 600);
    const before = await store.one(
      "SELECT credential,refresh_credential,expires_at,refresh_expires_at,credential_generation FROM personal_github WHERE user_id=?",
      id,
    );
    await retainGitHub(
      env,
      id,
      github,
      "basic-token",
      "read:user,user:email",
      githubFetch(),
    );
    expect(
      await store.one(
        "SELECT credential,refresh_credential,expires_at,refresh_expires_at,credential_generation FROM personal_github WHERE user_id=?",
        id,
      ),
    ).toEqual(before);
  });

  it.each(["bad_refresh_token", "expired_refresh", "missing_refresh"] as const)(
    "requires reconnection instead of using expired credentials: %s",
    async (failure) => {
      const { env, store } = fixture();
      const id = await user(env);
      await expiringConnection(env, id, -1);
      if (failure === "expired_refresh")
        await store
          .statement(
            "UPDATE personal_github SET refresh_expires_at=0 WHERE user_id=?",
            id,
          )
          .run();
      if (failure === "missing_refresh")
        await store
          .statement(
            "UPDATE personal_github SET refresh_credential=NULL WHERE user_id=?",
            id,
          )
          .run();
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          error: "bad_refresh_token",
          error_description: "secret",
        }),
      );
      await expect(githubCredential(env, id, request)).rejects.toMatchObject({
        code: "github_connection_required",
      });
      expect(request).toHaveBeenCalledTimes(
        failure === "bad_refresh_token" ? 1 : 0,
      );
    },
  );

  it.each(["network", "server", "invalid_json", "incomplete"] as const)(
    "surfaces sanitized renewal failures without erasing stored credentials: %s",
    async (failure) => {
      const { env, store } = fixture();
      const id = await user(env);
      await expiringConnection(env, id);
      const before = await store.one(
        "SELECT credential,refresh_credential FROM personal_github WHERE user_id=?",
        id,
      );
      const request = vi.fn<typeof fetch>().mockImplementation(() => {
        if (failure === "network")
          return Promise.reject(new Error("sensitive-secret"));
        if (failure === "server")
          return Promise.resolve(
            new Response("sensitive-secret", { status: 503 }),
          );
        if (failure === "invalid_json")
          return Promise.resolve(new Response("sensitive-secret"));
        return Promise.resolve(
          Response.json({ access_token: "sensitive-secret" }),
        );
      });
      await expect(githubCredential(env, id, request)).rejects.toMatchObject({
        code: "github_refresh_unavailable",
      });
      expect(
        await store.one(
          "SELECT credential,refresh_credential FROM personal_github WHERE user_id=?",
          id,
        ),
      ).toEqual(before);
      expect(
        await store.one(
          "SELECT refresh_lock FROM personal_github WHERE user_id=?",
          id,
        ),
      ).toEqual({ refresh_lock: null });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each(["disconnect", "reconnect"] as const)(
    "does not resurrect or overwrite a connection changed during renewal: %s",
    async (change) => {
      const { env, store } = fixture();
      const id = await user(env);
      await expiringConnection(env, id);
      const generation = await githubCredentialGeneration(env, id);
      const request = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (change === "disconnect")
          await store
            .statement("DELETE FROM personal_github WHERE user_id=?", id)
            .run();
        else
          await retainGitHub(env, id, github, "replacement-token", "read:org");
        return Response.json(renewedTokens);
      });
      await expect(
        githubCredential(env, id, request, generation),
      ).rejects.toMatchObject({
        code: "github_connection_required",
      });
      if (change === "disconnect")
        expect(
          await store.one(
            "SELECT user_id FROM personal_github WHERE user_id=?",
            id,
          ),
        ).toBeNull();
      else {
        expect(await githubCredential(env, id)).toBe("replacement-token");
        await expect(
          githubCredential(env, id, request, generation),
        ).rejects.toThrow("credential changed");
      }
    },
  );

  it("uses the hourly collection scheduler to renew credentials before starting a Workflow", async () => {
    const { env, create } = fixture();
    const id = await user(env);
    await new CollectionStore(env.DB!, id).saveConfig(config);
    await expiringConnection(env, id, -1);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(renewedTokens));
    vi.stubGlobal("fetch", request);
    await schedulePersonalCollections(env, Date.now());
    expect(request).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(await githubCredential(env, id)).toBe(renewedTokens.access_token);
  });

  it.each(["GitHub Display Name", null, "   "])(
    "retains the verified GitHub display name and avatar through sign-in (%s)",
    async (name) => {
      const { env } = fixture();
      await invite(env);
      vi.stubGlobal("fetch", githubFetch({ name }));
      const token = await jwtCallback(env);
      const access = await platformAccess(env, token);
      expect(access.github).toMatchObject({
        id: "101",
        login: "primary",
        name: name?.trim() || null,
        avatarUrl: github.avatarUrl,
      });
      await retainGitHub(
        env,
        access.userId!,
        { ...github, name: "Updated Name" },
        "oauth-private-token",
        "read:user,user:email,read:org",
      );
      expect((await platformAccess(env, token)).github?.name).toBe(
        "Updated Name",
      );
    },
  );
  it("retains credentials only as authenticated encryption bound to user and secret", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const row = await store.one<{ credential: string }>(
      "SELECT credential FROM personal_github WHERE user_id=?",
      id,
    );
    expect(row!.credential).not.toContain("oauth-private-token");
    expect(await decryptCredential(env, id, row!.credential)).toBe(
      "oauth-private-token",
    );
    expect(await encryptCredential(env, id, "oauth-private-token")).not.toBe(
      row!.credential,
    );
    await expect(
      decryptCredential(env, crypto.randomUUID(), row!.credential),
    ).rejects.toMatchObject({ code: "github_connection_required" });
    await expect(
      decryptCredential(
        { ...env, AUTH_SECRET: `${secret}-rotated` },
        id,
        row!.credential,
      ),
    ).rejects.toMatchObject({ code: "github_connection_required" });
    await expect(decryptCredential(env, id, "invalid")).rejects.toMatchObject({
      code: "github_connection_required",
    });
    await expect(
      encryptCredential({ ...env, AUTH_SECRET: "short" }, id, "token"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("preserves a server-verified read:org credential when a subsequent login grants only basic scopes", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const before = await store.one<{ credential: string }>(
      "SELECT credential FROM personal_github WHERE user_id=?",
      id,
    );
    const basic = githubFetch({ orgPermission: false });
    const organizations = githubFetch();
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      return new Headers(init?.headers).get("authorization") ===
        "Bearer fresh-basic-credential"
        ? basic(input, init)
        : organizations(input, init);
    });
    vi.stubGlobal("fetch", request);
    const token = await jwtCallback(env, {
      accessToken: "fresh-basic-credential",
    });
    expect(token?.platformUserId).toBe(id);
    expect(JSON.stringify(token)).not.toContain("fresh-basic-credential");
    expect(JSON.stringify(token)).not.toContain("oauth-private-token");
    const after = await store.one<{ credential: string; scopes: string }>(
      "SELECT credential,scopes FROM personal_github WHERE user_id=?",
      id,
    );
    expect(after!.credential).toBe(before!.credential);
    expect(after!.scopes).toContain("read:org");
    expect(
      organizations.mock.calls.some(
        ([input, init]) =>
          (input instanceof Request ? input.url : input.toString()) ===
            "https://api.github.com/user" &&
          new Headers(init?.headers).get("authorization") ===
            "Bearer oauth-private-token",
      ),
    ).toBe(true);
    expect(
      await (await call(env, "/personal/github", await session(id))).json(),
    ).toMatchObject({
      organizations: [{ login: "joined-org" }],
    });
  });

  it.each([
    "revoked",
    "identity_changed",
    "scope_removed",
    "unavailable",
    "unreadable",
  ] as const)(
    "stores the fresh credential and requires organization reauthorization when the previous connection is %s",
    async (failure) => {
      const { env, store } = fixture();
      const id = await user(env);
      if (failure === "unreadable")
        await store
          .statement(
            "UPDATE personal_github SET credential='unreadable' WHERE user_id=?",
            id,
          )
          .run();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const check = vi.fn<typeof fetch>().mockImplementation(() => {
        if (failure === "unavailable")
          return Promise.reject(new Error("sensitive provider response"));
        return Promise.resolve(
          Response.json(
            { id: failure === "identity_changed" ? 202 : 101 },
            {
              status: failure === "revoked" ? 401 : 200,
              headers: {
                "x-oauth-scopes":
                  failure === "scope_removed"
                    ? "read:user,user:email"
                    : "read:org",
              },
            },
          ),
        );
      });
      await retainGitHub(
        env,
        id,
        github,
        "fresh-basic-credential",
        "read:user,user:email",
        check,
      );
      const row = await store.one<{ credential: string; scopes: string }>(
        "SELECT credential,scopes FROM personal_github WHERE user_id=?",
        id,
      );
      expect(await decryptCredential(env, id, row!.credential)).toBe(
        "fresh-basic-credential",
      );
      expect(row!.scopes).toBe("read:user,user:email");
      expect(warning).toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).not.toContain(
        "sensitive provider response",
      );
      vi.stubGlobal("fetch", githubFetch({ orgPermission: false }));
      const response = await call(env, "/personal/github", await session(id));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "organization_permission_required",
      });
    },
  );

  it("verifies GitHub /user and /user/emails, never public profile or submitted emails", async () => {
    const { env, store } = fixture();
    await invite(env);
    const request = githubFetch();
    vi.stubGlobal("fetch", request);
    const token = await jwtCallback(env);
    expect(token).toMatchObject({
      verifiedEmail: true,
      githubAccountId: "101",
    });
    expect(token?.platformUserId).toEqual(expect.any(String));
    expect(JSON.stringify(token)).not.toContain("oauth-private-token");
    expect(
      await store.rows("SELECT provider,provider_id FROM personal_identities"),
    ).toEqual([{ provider: "github", provider_id: "101" }]);
    expect(
      request.mock.calls.map(([url]) =>
        url instanceof Request ? url.url : url.toString(),
      ),
    ).toContain("https://api.github.com/user/emails");
    vi.stubGlobal("fetch", githubFetch({ verified: false }));
    const other = fixture();
    await invite(other.env);
    expect(await jwtCallback(other.env)).toMatchObject({
      platformUserId: null,
      verifiedEmail: false,
    });
    vi.stubGlobal("fetch", githubFetch({ id: 404 }));
    await expect(jwtCallback(env)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("claims invitations and retains enterprise-managed GitHub identities", async () => {
    const { env, store } = fixture();
    await invite(env);
    vi.stubGlobal("fetch", githubFetch({ login: "managed-user_enterprise" }));
    const token = await jwtCallback(env);
    expect(token).toMatchObject({
      githubAccountId: "101",
      verifiedEmail: true,
    });
    expect(token?.platformUserId).toEqual(expect.any(String));
    expect(await store.rows("SELECT status,user_id FROM invitations")).toEqual([
      { status: "claimed", user_id: token?.platformUserId },
    ]);
    expect(
      await store.rows("SELECT github_id,login FROM personal_github"),
    ).toEqual([{ github_id: "101", login: "managed-user_enterprise" }]);
  });

  it.each(["invalid/login", "invalid?login", "invalid login"])(
    "rejects unsafe GitHub login %s without claiming invitations",
    async (login) => {
      const { env, store } = fixture();
      await invite(env);
      vi.stubGlobal("fetch", githubFetch({ login }));
      await expect(jwtCallback(env)).rejects.toMatchObject({
        code: "github_identity_failed",
      });
      expect(await store.rows("SELECT status FROM invitations")).toEqual([
        { status: "pending" },
      ]);
      expect(await store.rows("SELECT * FROM personal_identities")).toEqual([]);
    },
  );

  it("trusts Google email_verified only and rejects Microsoft/unverified claims for invitations", async () => {
    const { env } = fixture();
    await invite(env);
    expect(
      await jwtCallback(env, {
        provider: "google",
        providerId: "google-sub",
        profile: { email: "invitee@example.invalid", email_verified: false },
      }),
    ).toMatchObject({ platformUserId: null });
    expect(
      await jwtCallback(env, {
        provider: "microsoft-entra-id",
        providerId: "ms-sub",
        profile: { email: "invitee@example.invalid", email_verified: true },
      }),
    ).toMatchObject({ platformUserId: null });
    expect(
      (
        await jwtCallback(env, {
          provider: "google",
          providerId: "google-sub",
          profile: { email: "invitee@example.invalid", email_verified: true },
        })
      )?.platformUserId,
    ).toEqual(expect.any(String));
  });

  it("rejects unavailable/invalid GitHub claims without persisting an identity", async () => {
    const request = githubFetch({ status: 401 });
    await expect(githubIdentity("token", request)).rejects.toMatchObject({
      code: "github_identity_failed",
    });
    await expect(
      githubIdentity(
        "token",
        vi.fn().mockResolvedValue(Response.json({ id: -1, login: "invalid" })),
      ),
    ).rejects.toMatchObject({ code: "github_identity_failed" });
    const failingEmail = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: 101, login: "primary", avatar_url: "" }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await expect(githubIdentity("token", failingEmail)).rejects.toMatchObject({
      code: "verified_email_required",
    });
  });

  it("requests organization access during ordinary GitHub sign-in with CSRF and state protection", async () => {
    const { env } = fixture();
    const csrfResponse = await app.request(`${origin}/api/auth/csrf`, {}, env);
    const { csrfToken } = await csrfResponse.json<{ csrfToken: string }>();
    const cookie = csrfResponse.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const response = await app.request(
      `${origin}/api/auth/signin/github`,
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrfToken, callbackUrl: origin }),
      },
      env,
    );
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["read:user", "user:email", "read:org"]),
    );
    expect(redirect.searchParams.get("state")).toBeTruthy();
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/github`,
    );
  });

  it("links explicitly with session-owned expiring one-use intent and unchanged callback URL", async () => {
    const { env, store } = fixture();
    await invite(env);
    const id = await registerIdentity(env, "google", "google-sub", [
      "invitee@example.invalid",
    ]);
    const cookie = await session(id);
    const response = await call(
      env,
      "/personal/github/connect",
      cookie,
      "POST",
      { organizations: true },
    );
    expect(response.status).toBe(200);
    const linkCookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const authorization = await call(
      env,
      "/personal/github/authorize",
      `${cookie}; ${linkCookie}`,
    );
    expect(authorization.status).toBe(200);
    const html = await authorization.text();
    expect(html).toContain("read%3Aorg");
    expect(html.match(/name="callbackUrl"\s+value="([^"]+)"/)?.[1]).toBe(
      "/?personal=configure&amp;github=organizations",
    );
    expect(authorization.headers.getSetCookie().join(";")).toContain(
      "csrf-token",
    );
    const csrf = html.match(/name="csrfToken"\s+value="([^"]+)"/)?.[1];
    const authCookies = authorization.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const signin = await app.request(
      `${origin}/api/auth/signin/github?scope=read%3Auser%20user%3Aemail%20read%3Aorg`,
      {
        method: "POST",
        headers: { Cookie: `${cookie}; ${linkCookie}; ${authCookies}` },
        body: new URLSearchParams({
          csrfToken: csrf!,
          callbackUrl: "/?personal=configure&github=organizations",
        }),
      },
      env,
    );
    const redirect = new URL(signin.headers.get("location")!);
    expect(redirect.searchParams.get("scope")).toBe(
      "read:user user:email read:org",
    );
    expect(redirect.searchParams.get("state")).toBeTruthy();
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/github`,
    );
    vi.stubGlobal("fetch", githubFetch());
    const request = new Request(`${origin}/api/auth/callback/github`, {
      headers: { Cookie: `${cookie}; ${linkCookie}` },
    });
    expect(await jwtCallback(env, {}, request)).toMatchObject({
      platformUserId: id,
    });
    expect(
      await store.one(
        "SELECT user_id FROM personal_identities WHERE provider='github' AND provider_id='101'",
      ),
    ).toEqual({ user_id: id });
    await expect(jwtCallback(env, {}, request)).rejects.toMatchObject({
      code: "link_expired",
    });
    expect(
      (
        await call(
          env,
          "/personal/github/authorize",
          `${cookie}; ${linkCookie}`,
        )
      ).status,
    ).toBe(403);
    expect((await call(env, "/personal/github/authorize", cookie)).status).toBe(
      403,
    );
  });

  it("requests organization access for a regular connection without changing its return context", async () => {
    const { env } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    const connected = await call(
      env,
      "/personal/github/connect",
      cookie,
      "POST",
      { organizations: false },
    );
    const linkCookie = connected.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const response = await call(
      env,
      "/personal/github/authorize",
      `${cookie}; ${linkCookie}`,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.match(/name="callbackUrl"\s+value="([^"]+)"/)?.[1]).toBe(
      "/?personal=configure",
    );
    expect(body).not.toContain("github=organizations");
    expect(body).toContain("read%3Aorg");
  });

  it("rejects cross-session, expired and conflicting link intents without linking by email", async () => {
    const { env, store } = fixture();
    const first = await user(env);
    await invite(env, "second@example.invalid");
    const second = await registerIdentity(env, "google", "second-sub", [
      "second@example.invalid",
    ]);
    const cookie = await session(second);
    const response = await call(
      env,
      "/personal/github/connect",
      cookie,
      "POST",
      {},
    );
    const linkCookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    vi.stubGlobal("fetch", githubFetch());
    const req = (sessionCookie: string) =>
      new Request(`${origin}/api/auth/callback/github`, {
        headers: { Cookie: `${sessionCookie}; ${linkCookie}` },
      });
    await expect(jwtCallback(env, {}, req(cookie))).rejects.toMatchObject({
      code: "identity_conflict",
    });
    vi.stubGlobal("fetch", githubFetch({ id: 202 }));
    await expect(
      jwtCallback(env, { providerId: "202" }, req("")),
    ).rejects.toMatchObject({ code: "link_expired" });
    await expect(
      jwtCallback(env, { providerId: "202" }, req(await session(first))),
    ).rejects.toMatchObject({ code: "identity_conflict" });
    await store
      .statement(
        "UPDATE github_link_intents SET expires_at='2000-01-01T00:00:00.000Z'",
      )
      .run();
    await expect(
      jwtCallback(env, { providerId: "202" }, req(cookie)),
    ).rejects.toMatchObject({ code: "link_expired" });
    expect(
      await store.one(
        "SELECT user_id FROM personal_identities WHERE provider='github' AND provider_id='202'",
      ),
    ).toBeNull();
  });

  it("requires Auth.js CSRF and OAuth state even with a valid platform session", async () => {
    const { env } = fixture();
    const id = await user(env);
    const response = await app.request(
      `${origin}/api/auth/callback/github?code=forged&state=forged`,
      { headers: { Cookie: await session(id) } },
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=");
    expect(response.headers.getSetCookie().join(";")).toContain(
      "__Host-workforce-link=;",
    );
    const signin = await app.request(
      `${origin}/api/auth/signin/github`,
      { method: "POST", body: new URLSearchParams({ callbackUrl: "/" }) },
      env,
    );
    expect(signin.headers.get("location")).toContain("MissingCSRF");
  });
});

describe("personal configuration, discovery and isolation", () => {
  it("saves managed-user accounts and authors and resolves their repository scope", async () => {
    const { env } = fixture();
    await invite(env);
    vi.stubGlobal("fetch", githubFetch({ login: "managed-user_microsoft" }));
    const token = await jwtCallback(env);
    if (typeof token?.platformUserId !== "string")
      throw new Error("Managed-user invitation was not claimed.");
    const cookie = await session(token.platformUserId);
    const saved = await call(env, "/personal/config", cookie, "PUT", {
      ...config,
      repositoryMode: "all_owned_public",
      accounts: [" Managed-User_Microsoft "],
      authorLogins: ["Historical-User_Microsoft"],
      includeRepositories: [" Managed-User_Microsoft/Public "],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      config: {
        accounts: ["managed-user_microsoft"],
        authorLogins: ["historical-user_microsoft", "managed-user_microsoft"],
        includeRepositories: ["managed-user_microsoft/public"],
      },
    });
    const repository = await call(
      env,
      "/personal/github/repository?name=managed-user_microsoft%2Fpublic",
      cookie,
    );
    expect(repository.status).toBe(200);
    expect(await repository.json()).toMatchObject({
      fullName: "managed-user_microsoft/public",
    });
  });

  it("saves verified normalized scope, immutable revisions, and retains old snapshots", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    vi.stubGlobal("fetch", githubFetch());
    expect(
      await (await call(env, "/personal/config", cookie)).json(),
    ).toMatchObject({ config: null, revisionId: null, github: { id: "101" } });
    const saved = await call(env, "/personal/config", cookie, "PUT", {
      ...config,
      authorLogins: ["HISTORY", "history"],
    });
    expect(saved.status).toBe(200);
    const first = await saved.json<{
      revisionId: string;
      config: { authorLogins: string[] };
    }>();
    expect(first.config.authorLogins).toEqual(["history", "primary"]);
    await store
      .statement(
        "INSERT INTO collection_runs(id,revision_id,status,since_at,until_at,started_at) VALUES (?,?,'published',?,?,?)",
        "snapshot-run",
        first.revisionId,
        "2026-01-01",
        "2026-01-02",
        "2026-01-02",
      )
      .run();
    await store
      .statement(
        "UPDATE personal_state SET snapshot_json=?,published_run_id='snapshot-run' WHERE id=?",
        JSON.stringify({ version: 1 }),
        id,
      )
      .run();
    const second = await (
      await call(env, "/personal/config", cookie, "PUT", {
        ...config,
        enabled: false,
      })
    ).json<{ revisionId: string }>();
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(
      (await new CollectionStore(env.DB!, id).config(first.revisionId)).enabled,
    ).toBe(true);
    expect(
      await (await call(env, "/personal/activity", cookie)).json(),
    ).toMatchObject({
      snapshot: { version: 1 },
      stale: true,
      revisionId: first.revisionId,
      currentRevisionId: second.revisionId,
    });
    expect(saved.headers.get("cache-control")).toBe("private, no-store");
    expect(
      JSON.stringify(
        await (await call(env, "/platform/access", cookie)).json(),
      ),
    ).not.toContain("oauth-private-token");
  });

  it("never returns another user's config, snapshot or run existence, including to administrators", async () => {
    const { env } = fixture();
    const first = await user(env);
    const admin = await registerIdentity(env, "github", "999", []);
    const personalStore = new CollectionStore(env.DB!, first);
    const revision = await personalStore.saveConfig(config);
    await personalStore.enqueue(
      "private-run",
      revision,
      new Date().toISOString(),
    );
    const cookie = await session(admin);
    expect(
      await (await call(env, "/personal/config", cookie)).json(),
    ).toMatchObject({ config: null });
    expect(
      await (await call(env, "/personal/activity", cookie)).json(),
    ).toMatchObject({ snapshot: null });
    expect(
      (await call(env, "/personal/collection/private-run", cookie)).status,
    ).toBe(404);
    expect(
      (await call(env, "/personal/collection/nonexistent", cookie)).status,
    ).toBe(404);
    await expect(
      new CollectionStore(env.DB!, admin!).config(revision),
    ).rejects.toThrow("does not exist");
    await expect(
      new CollectionStore(env.DB!, admin!).run("private-run"),
    ).rejects.toThrow("does not exist");
    const administrator = await session(admin, { githubAccountId: "999" });
    expect(
      (await call(env, "/activity/collection/runs/private-run", administrator))
        .status,
    ).toBe(404);
    expect(
      await (await call(env, "/activity/collection", administrator)).json(),
    ).toMatchObject({ latestRunId: null });
    const management = { ...env, COLLECTION_ADMIN_TOKEN: secret };
    const legacy = await app.request(
      `${origin}/api/collection/runs`,
      { headers: { Authorization: `Bearer ${secret}` } },
      management,
    );
    expect(await legacy.json()).toMatchObject({ runs: [] });
  });

  it("distinguishes malformed config, repository validation failures, private and unavailable repositories", async () => {
    const { env } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    const invalid = await call(env, "/personal/config", cookie, "PUT", {
      ...config,
      includeRepositories: ["bad"],
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      field: "includeRepositories",
    });
    expect(
      (await call(env, "/personal/github/repository?name=bad", cookie)).status,
    ).toBe(422);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ...publicRepository, private: true }),
        ),
    );
    expect(
      await (
        await call(
          env,
          "/personal/github/repository?name=primary/public",
          cookie,
        )
      ).json(),
    ).toMatchObject({ code: "repository_not_public" });
    for (const [status, code] of [
      [404, "repository_not_found"],
      [403, "github_access_denied"],
      [401, "github_connection_required"],
      [500, "github_unavailable"],
    ] as const) {
      vi.stubGlobal("fetch", githubFetch({ status }));
      expect(
        await (
          await call(
            env,
            "/personal/github/repository?name=primary/public",
            cookie,
          )
        ).json(),
      ).toMatchObject({ code });
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(
      (
        await call(
          env,
          "/personal/github/repository?name=primary/public",
          cookie,
        )
      ).status,
    ).toBe(502);
    vi.stubGlobal("fetch", githubFetch());
    expect(
      await (
        await call(
          env,
          "/personal/github/repository?name=primary/public",
          cookie,
        )
      ).json(),
    ).toEqual({
      id: 501,
      fullName: "primary/public",
      url: publicRepository.html_url,
    });
  });

  it("enforces expanded scope after ID-based exclusions rather than merely input counts", async () => {
    const { env } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    const repos = Array.from({ length: 202 }, (_, index) => ({
      ...publicRepository,
      id: 1000 + index,
      full_name: `primary/r${index}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        const url = new URL(input);
        if (url.pathname === "/users/primary")
          return Promise.resolve(Response.json(publicRepository.owner));
        const page = Number(url.searchParams.get("page") ?? 1);
        return Promise.resolve(
          Response.json(
            url.pathname.endsWith("/repos")
              ? repos.slice((page - 1) * 100, page * 100)
              : repos[input.endsWith("/second-renamed") ? 1 : 0],
          ),
        );
      }),
    );
    const large = {
      ...config,
      repositoryMode: "all_owned_public",
      includeRepositories: [],
    };
    expect(
      (
        await call(env, "/personal/config", cookie, "PUT", {
          ...large,
          excludeRepositories: ["old/renamed"],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(env, "/personal/config", cookie, "PUT", {
          ...large,
          excludeRepositories: ["old/renamed", "old/second-renamed"],
        })
      ).status,
    ).toBe(200);
    repos.splice(200);
    expect(
      (await call(env, "/personal/config", cookie, "PUT", large)).status,
    ).toBe(200);
  });

  it("allows 200 explicit repository entries but rejects 201 without raising account or author limits", () => {
    for (const field of [
      "includeRepositories",
      "excludeRepositories",
    ] as const) {
      const entries = Array.from(
        { length: 200 },
        (_, index) => `primary/repository-${index}`,
      );
      expect(parseConfig({ ...config, [field]: entries })[field]).toHaveLength(
        200,
      );
      expect(() =>
        parseConfig({
          ...config,
          [field]: [...entries, "primary/over-budget"],
        }),
      ).toThrow(`${field} must be an array of at most 200 values.`);
    }
    for (const field of ["accounts", "authorLogins", "authorEmails"] as const) {
      const entries = Array.from({ length: 100 }, (_, index) =>
        field === "authorEmails"
          ? `historical-${index}@example.invalid`
          : `author-${index}`,
      );
      expect(parseConfig({ ...config, [field]: entries })[field]).toHaveLength(
        100,
      );
      expect(() =>
        parseConfig({ ...config, [field]: [...entries, entries[0]!] }),
      ).toThrow(`${field} must be an array of at most 100 values.`);
    }
  });

  it("reports the shared 200-repository personal quota without changing history and refresh limits", async () => {
    const { env } = fixture();
    const id = await user(env);
    const response = await call(env, "/platform/access", await session(id));
    expect((await response.json<PlatformAccessResponse>()).limits).toEqual({
      repositories: 200,
      historyCommits: 50_000,
      refreshCooldownSeconds: 900,
    });
  });

  it("validates public users, organizations, and explicit repositories with the user's OAuth credential, ignoring server overrides", async () => {
    const { env } = fixture();
    const id = await user(env);
    const profiles = {
      primary: publicRepository.owner,
      "public-empty": { id: 301, login: "public-empty", type: "Organization" },
      "public-org": { id: 302, login: "public-org", type: "Organization" },
    };
    const cache = new CollectionStore(env.DB!);
    await cache.batch([
      cache.accountStatement(profiles.primary),
      cache.accountStatement(profiles["public-org"]),
    ]);
    const orgRepositories = ["renamed", "kept"].map((name, index) => ({
      ...publicRepository,
      id: 8000 + index,
      full_name: `public-org/${name}`,
      owner: profiles["public-org"],
    }));
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe("Bearer oauth-private-token");
      const profile = Object.values(profiles).find(
        (account) => url.pathname === `/users/${account.login}`,
      );
      if (profile) {
        return Promise.resolve(Response.json(profile));
      }
      if (url.pathname === "/users/primary/repos") {
        expect(url.searchParams.get("type")).toBe("owner");
        return Promise.resolve(
          Response.json(
            Array.from({ length: 68 }, (_, index) => ({
              ...publicRepository,
              id: 1000 + index,
              full_name: `primary/repo-${index}`,
            })),
          ),
        );
      }
      if (url.pathname === "/orgs/public-empty/repos") {
        expect(url.searchParams.get("type")).toBe("public");
        return Promise.resolve(Response.json([]));
      }
      if (url.pathname === "/orgs/public-org/repos") {
        expect(url.searchParams.get("type")).toBe("public");
        return Promise.resolve(Response.json(orgRepositories));
      }
      if (url.pathname.startsWith("/repos/public-org/")) {
        return Promise.resolve(
          Response.json(
            orgRepositories[url.pathname.endsWith("/kept") ? 1 : 0],
          ),
        );
      }
      return Promise.resolve(Response.json({}, { status: 403 }));
    });
    vi.stubGlobal("fetch", request);
    const response = await call(
      {
        ...env,
        GH_TOKEN: "",
        GH_TOKEN_PUBLIC_ORG: "organization-discovery-token",
      },
      "/personal/config",
      await session(id),
      "PUT",
      {
        ...config,
        repositoryMode: "all_owned_public",
        accounts: ["primary", "public-empty", "public-org"],
        includeRepositories: ["public-org/kept"],
        excludeRepositories: ["public-org/old-name"],
      },
    );
    expect(response.status).toBe(200);
    expect(
      request.mock.calls
        .filter(([input]) =>
          new URL(
            input instanceof Request ? input.url : input.toString(),
          ).pathname.match(/^\/users\/[^/]+$/),
        )
        .map(
          ([input]) =>
            new URL(input instanceof Request ? input.url : input.toString())
              .pathname,
        ),
    ).toEqual(["/users/public-empty"]);
    expect(
      request.mock.calls.some(([input]) =>
        new URL(
          input instanceof Request ? input.url : input.toString(),
        ).pathname.match(/^\/users\/public-(empty|org)\/repos$/),
      ),
    ).toBe(false);
  });

  it.each([
    [403, "github_access_denied", 403],
    [429, "github_rate_limited", 429],
    [404, "repository_not_found", 404],
    [401, "github_connection_required", 409],
  ] as const)(
    "preserves organization discovery HTTP %i failures without changing credentials or the saved config",
    async (status, code, expectedStatus) => {
      const { env } = fixture();
      const id = await user(env);
      const store = new CollectionStore(env.DB!, id);
      const revisionId = await store.saveConfig(config);
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation((input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          if (url.pathname === "/users/public-org") {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer oauth-private-token",
            );
            return Promise.resolve(
              Response.json({
                id: 302,
                login: "public-org",
                type: "Organization",
              }),
            );
          }
          calls.push(url.pathname);
          expect(url.pathname).toBe("/orgs/public-org/repos");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer oauth-private-token",
          );
          return Promise.resolve(
            Response.json(
              { message: "Resource not accessible by personal access token" },
              { status },
            ),
          );
        }),
      );
      const response = await call(
        { ...env, GH_TOKEN_PUBLIC_ORG: "organization-discovery-token" },
        "/personal/config",
        await session(id),
        "PUT",
        {
          ...config,
          repositoryMode: "all_owned_public",
          accounts: ["public-org"],
          includeRepositories: [],
        },
      );
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toMatchObject({ code });
      expect(calls).toEqual(["/orgs/public-org/repos"]);
      expect((await store.activeConfig()).revisionId).toBe(revisionId);
    },
  );

  it("rejects account discovery whose repository owner identity changed instead of silently skipping repositories", async () => {
    const { env } = fixture();
    const id = await user(env);
    const base = githubFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        return url.includes("/users/primary/repos")
          ? Promise.resolve(
              Response.json([
                {
                  ...publicRepository,
                  owner: { ...publicRepository.owner, id: 9999 },
                },
              ]),
            )
          : base(input, init);
      }),
    );
    const response = await call(
      env,
      "/personal/config",
      await session(id),
      "PUT",
      {
        ...config,
        repositoryMode: "all_owned_public",
        includeRepositories: [],
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "repository_identity_changed",
    });
  });

  it("paginates app-visible organizations and returns the public OAuth application access settings", async () => {
    const { env } = fixture();
    const id = await user(env);
    const base = githubFetch();
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/user/orgs")) {
        const page = new URL(url).searchParams.get("page");
        return Promise.resolve(
          Response.json(
            page === "1"
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: 1000 + index,
                  login: `joined-${index}`,
                  avatar_url: "",
                }))
              : [
                  {
                    id: 2000,
                    login: "last-org",
                    avatar_url: "",
                  },
                ],
          ),
        );
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", request);
    const response = await call(env, "/personal/github", await session(id));
    expect(response.status).toBe(200);
    const discovery = await response.json<{
      organizations: { login: string }[];
      repositories: { fullName: string }[];
      organizationAccessUrl: string;
    }>();
    expect(discovery.organizations).toHaveLength(101);
    expect(discovery.organizations.at(-1)?.login).toBe("last-org");
    expect(discovery.repositories).toMatchObject([
      { fullName: "primary/public" },
    ]);
    expect(discovery.organizationAccessUrl).toBe(
      "https://github.com/settings/connections/applications/github-id",
    );
    expect(discovery.organizationAccessUrl).not.toContain(
      env.AUTH_GITHUB_SECRET,
    );
    expect(
      request.mock.calls.filter(([input]) =>
        (input instanceof Request ? input.url : input.toString()).includes(
          "/user/orgs",
        ),
      ),
    ).toHaveLength(2);
  });

  it("preserves policy errors and honest empty results from app-visible organization discovery", async () => {
    const { env } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    const base = githubFetch();
    let denied = true;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        return url.includes("/user/orgs")
          ? Promise.resolve(
              Response.json(denied ? {} : [], { status: denied ? 403 : 200 }),
            )
          : base(input, init);
      }),
    );
    const blocked = await call(env, "/personal/github", cookie);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      code: "github_access_denied",
    });
    denied = false;
    expect(
      await (await call(env, "/personal/github", cookie)).json(),
    ).toMatchObject({
      organizations: [],
      repositories: [{ fullName: "primary/public" }],
      organizationAccessUrl:
        "https://github.com/settings/connections/applications/github-id",
    });
  });

  it("omits app-specific organization settings when the public client ID is unavailable", async () => {
    const { env } = fixture();
    const id = await user(env);
    vi.stubGlobal("fetch", githubFetch());
    const withoutClientId = { ...env };
    delete withoutClientId.AUTH_GITHUB_ID;
    const response = await call(
      withoutClientId,
      "/personal/github",
      await session(id),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("organizationAccessUrl");
  });

  it("reads joined organizations on demand and never masks permission or connection failures as empty", async () => {
    const { env, store } = fixture();
    const id = await user(env);
    const cookie = await session(id);
    vi.stubGlobal("fetch", githubFetch());
    expect(
      await (await call(env, "/personal/github", cookie)).json(),
    ).toMatchObject({
      github: { login: "primary" },
      organizations: [{ login: "joined-org" }],
      repositories: [{ fullName: "primary/public" }],
    });
    vi.stubGlobal("fetch", githubFetch({ orgPermission: false }));
    expect(
      await (await call(env, "/personal/github", cookie)).json(),
    ).toMatchObject({ code: "organization_permission_required" });
    vi.stubGlobal("fetch", githubFetch({ id: 404 }));
    expect(
      await (await call(env, "/personal/github", cookie)).json(),
    ).toMatchObject({ code: "identity_mismatch" });
    await store
      .statement("DELETE FROM personal_github WHERE user_id=?", id)
      .run();
    expect(
      await (await call(env, "/personal/github", cookie)).json(),
    ).toMatchObject({ code: "github_connection_required" });
    expect(
      (await call(env, "/personal/config", cookie, "PUT", config)).status,
    ).toBe(409);
  });
});

describe("scoped collection and migration safety", () => {
  it("reserves per-user runs atomically, enforces cooldown/global capacity, and releases failed workflow reservations", async () => {
    const { env, create } = fixture();
    const first = await user(env);
    const second = await user(env, "202", "second@example.invalid");
    const firstStore = new CollectionStore(env.DB!, first);
    const secondStore = new CollectionStore(env.DB!, second);
    await firstStore.saveConfig(config);
    await secondStore.saveConfig(config);
    const started = await startPersonalCollection(env, first);
    expect(started!.runId).toBeTruthy();
    await expect(startPersonalCollection(env, first)).rejects.toMatchObject({
      status: 429,
    });
    expect((await startPersonalCollection(env, second))!.runId).not.toBe(
      started!.runId,
    );
    expect(create).toHaveBeenCalledTimes(2);
    const state = await (
      await call(env, "/personal/collection", await session(first))
    ).json<{
      activeRunId: string;
      latestRun: { revisionId: string; status: string };
    }>();
    expect(state).toMatchObject({
      activeRunId: started!.runId,
      latestRun: { status: "queued" },
    });
    expect(
      (
        await call(
          env,
          `/personal/collection/${started!.runId}`,
          await session(first),
        )
      ).status,
    ).toBe(200);
    await firstStore
      .statement(
        "UPDATE personal_state SET active_run_id=NULL WHERE id=?",
        first,
      )
      .run();
    await expect(startPersonalCollection(env, first)).rejects.toMatchObject({
      status: 429,
    });
    await firstStore
      .statement(
        "UPDATE personal_users SET last_refresh_at=NULL WHERE id=?",
        first,
      )
      .run();
    create.mockRejectedValueOnce(new Error("binding unavailable"));
    await expect(startPersonalCollection(env, first)).rejects.toMatchObject({
      status: 503,
    });
    expect(
      await firstStore.one(
        "SELECT active_run_id FROM personal_state WHERE id=?",
        first,
      ),
    ).toEqual({ active_run_id: null });
    const third = await user(env, "303", "third@example.invalid");
    await expect(startPersonalCollection(env, third)).rejects.toMatchObject({
      code: "configuration_required",
    });
    await expect(
      startPersonalCollection({ ...env, COLLECTION_EMAIL_KEY: "" }, first),
    ).rejects.toMatchObject({ code: "collection_unavailable" });
  });

  it.each(["missing", "corrupt"] as const)(
    "rejects a %s user credential without falling back or reserving a personal run",
    async (state) => {
      const { env, create } = fixture();
      const id = await user(env);
      const other = await user(env, "202", "second@example.invalid");
      const store = new CollectionStore(env.DB!, id);
      const revisionId = await store.saveConfig(config);
      if (state === "missing")
        await store
          .statement("DELETE FROM personal_github WHERE user_id=?", id)
          .run();
      else
        await store
          .statement(
            "UPDATE personal_github SET credential=? WHERE user_id=?",
            await encryptCredential(env, other, "other-user-token"),
            id,
          )
          .run();
      const request = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", request);
      expect(
        await (
          await call(env, "/personal/config", await session(id), "PUT", config)
        ).json(),
      ).toMatchObject({ code: "github_connection_required" });
      await expect(startPersonalCollection(env, id)).rejects.toMatchObject({
        code: "github_connection_required",
      });
      await expect(
        runCollection(
          env,
          {
            runId: "no-credential",
            revisionId,
            until: new Date().toISOString(),
            userId: id,
          },
          { do: (_name, callback) => callback() },
          request,
        ),
      ).rejects.toMatchObject({ code: "github_connection_required" });
      expect(request).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(
        await store.one(
          "SELECT active_run_id FROM personal_state WHERE id=?",
          id,
        ),
      ).toEqual({ active_run_id: null });
      expect((await store.activeConfig()).revisionId).toBe(revisionId);
    },
  );

  it("starts manual and scheduled personal collections without server collection tokens", async () => {
    const { env, create } = fixture();
    const id = await user(env);
    const other = await user(env, "202", "second@example.invalid");
    await new CollectionStore(env.DB!, id).saveConfig(config);
    await new CollectionStore(env.DB!, other).saveConfig({
      ...config,
      enabled: true,
    });
    const oauthEnv = { ...env };
    delete oauthEnv.GH_TOKEN;
    expect((await startPersonalCollection(oauthEnv, id))!.runId).toBeTruthy();
    expect(
      (await startPersonalCollection(oauthEnv, other, Date.now()))!.runId,
    ).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls)).not.toContain(
      "oauth-private-token",
    );
  });

  it("reports rate-limit waits and recovers externally stopped workflows without leaving a permanent personal lock", async () => {
    const { env, create } = fixture();
    const id = await user(env);
    const store = new CollectionStore(env.DB!, id);
    const revision = await store.saveConfig(config);
    const run = await startPersonalCollection(env, id);
    await store.begin(run!.runId, revision, new Date().toISOString(), "key");
    await store.startWait(run!.runId, "rate limit");
    const get = vi.fn().mockResolvedValue({
      status: () => Promise.resolve({ status: "waiting" }),
    });

    const bound = {
      ...env,
      COLLECTION: { create, get },
    } as unknown as Bindings;
    const cookie = await session(id);
    expect(
      await (
        await call(bound, `/personal/collection/${run!.runId}`, cookie)
      ).json(),
    ).toMatchObject({ waiting: true, status: "collecting" });
    get.mockResolvedValue({
      status: () => Promise.resolve({ status: "terminated" }),
    });
    const result = await (
      await call(bound, "/personal/collection", cookie)
    ).json<{ activeRunId: string | null; latestRun: { status: string } }>();
    expect(result).toMatchObject({
      activeRunId: null,
      latestRun: { status: "cancelled" },
    });
    expect((await store.run(run!.runId)).status).toBe("cancelled");
    await store
      .statement(
        "UPDATE personal_users SET last_refresh_at=NULL WHERE id=?",
        id,
      )
      .run();
    const second = await startPersonalCollection(bound, id);
    get.mockResolvedValue({
      status: () => Promise.resolve({ status: "errored" }),
    });
    expect(
      await (await call(bound, "/personal/collection", cookie)).json(),
    ).toMatchObject({
      activeRunId: null,
      latestRun: { runId: second!.runId, status: "failed" },
    });
  });

  it("returns explicit unavailable errors when workflow inspection fails, retaining state and scheduling other users", async () => {
    const { env, create, getWorkflow } = fixture();
    const first = await user(env);
    const second = await user(env, "202", "second@example.invalid");
    const a = new CollectionStore(env.DB!, first);
    await a.saveConfig(config);
    await new CollectionStore(env.DB!, second).saveConfig(config);
    const run = await startPersonalCollection(env, first);
    const cookie = await session(first);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    getWorkflow.mockRejectedValue(new Error("sensitive provider response"));
    for (const [path, method] of [
      ["/personal/collection", "GET"],
      [`/personal/collection/${run!.runId}`, "GET"],
      ["/personal/collection", "POST"],
    ]) {
      const response = await call(env, path!, cookie, method);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "workflow_status_unavailable",
      });
    }
    expect(await a.ownsRun(run!.runId)).toBe(true);
    expect((await a.run(run!.runId)).status).toBe("queued");
    expect(create).toHaveBeenCalledTimes(1);
    await schedulePersonalCollections(env, Date.now());
    expect(create).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "sensitive provider response",
    );
  });

  it("schedules independent users only when enabled and bounds each tick to four personal runs", async () => {
    const { env, create, store } = fixture();
    let fifth = "";
    for (let index = 0; index < 5; index++) {
      const id = await user(
        env,
        String(100 + index),
        `person${index}@example.invalid`,
      );
      await new CollectionStore(env.DB!, id).saveConfig({
        ...config,
        enabled: index !== 4,
      });
      if (index === 4) fifth = id;
    }
    await schedulePersonalCollections(
      { ...env, COLLECTION_ENABLED: "false" },
      Date.now(),
    );
    expect(create).not.toHaveBeenCalled();
    await schedulePersonalCollections(env, Date.now());
    expect(create).toHaveBeenCalledTimes(4);
    await expect(startPersonalCollection(env, fifth)).rejects.toMatchObject({
      code: "refresh_limited",
    });
    const scheduled = await store.one<{ last_scheduled_at: string }>(
      "SELECT last_scheduled_at FROM personal_users WHERE last_scheduled_at IS NOT NULL LIMIT 1",
    );
    await store.statement("UPDATE personal_state SET active_run_id=NULL").run();
    await schedulePersonalCollections(
      env,
      Date.parse(scheduled!.last_scheduled_at) + 3_600_000,
    );
    expect(create).toHaveBeenCalledTimes(8);
    await schedulePersonalCollections(env, Date.now());
    expect(create).toHaveBeenCalledTimes(8);
  });

  it("keeps per-scope publication locks independent, isolates snapshot publication and atomically denies stopped owners", async () => {
    const { env, store, put } = fixture();
    const first = await user(env);
    const second = await user(env, "202", "second@example.invalid");
    const a = new CollectionStore(env.DB!, first);
    const b = new CollectionStore(env.DB!, second);
    const aRevision = await a.saveConfig(config);
    const bRevision = await b.saveConfig(config);
    const until = new Date().toISOString();
    expect(await a.begin("a-run", aRevision, until, "key")).toBe(true);
    expect(await b.begin("b-run", bRevision, until, "key")).toBe(true);
    expect(
      await new CollectionStore(env.DB!).one(
        "SELECT active_run_id FROM collection_state WHERE id=1",
      ),
    ).toEqual({ active_run_id: null });
    await a.ready("a-run");
    const snapshot = { version: 1 } as ActivitySnapshot;
    await a.publishPersonal("a-run", snapshot);
    expect(
      await store.one(
        "SELECT snapshot_json FROM personal_state WHERE id=?",
        first,
      ),
    ).toEqual({ snapshot_json: JSON.stringify(snapshot) });
    expect(
      await store.one(
        "SELECT snapshot_json FROM personal_state WHERE id=?",
        second,
      ),
    ).toEqual({ snapshot_json: null });
    await a.published("a-run");
    await b.ready("b-run");
    await store
      .statement(
        "UPDATE personal_users SET status='suspended' WHERE id=?",
        second,
      )
      .run();
    await expect(b.publishPersonal("b-run", snapshot)).rejects.toThrow(
      "stopped",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("uses explicit scoped state queries without rewriting raw SQL or mutating another scope's runs", async () => {
    const { env } = fixture();
    const first = await user(env);
    const second = await user(env, "202", "second@example.invalid");
    const legacy = new CollectionStore(env.DB!);
    const a = new CollectionStore(env.DB!, first);
    const b = new CollectionStore(env.DB!, second);
    const legacyRevision = await legacy.saveConfig({
      ...config,
      enabled: false,
    });
    const aRevision = await a.saveConfig(config);
    const bRevision = await b.saveConfig(config);
    const until = new Date().toISOString();
    await legacy.begin("legacy-state", legacyRevision, until, "legacy-key");
    await a.begin("personal-a", aRevision, until, "a-key");
    await b.begin("personal-b", bRevision, until, "b-key");
    expect(
      await a.one(
        "SELECT active_run_id,'default' AS config_id FROM collection_state WHERE id=1",
      ),
    ).toEqual({
      active_run_id: "legacy-state",
      config_id: "default",
    });
    expect((await legacy.activeConfig()).revisionId).toBe(legacyRevision);
    expect((await a.activeConfig()).revisionId).toBe(aRevision);
    expect((await b.activeConfig()).revisionId).toBe(bRevision);
    await a.failed("personal-b", "Wrong scope.");
    await a.published("personal-b");
    await a.cancel("personal-b");
    expect((await b.run("personal-b")).status).toBe("collecting");
    expect(await b.ownsRun("personal-b")).toBe(true);
    await a.enqueue("wrong-revision", bRevision, until);
    expect(
      await a.one("SELECT id FROM collection_runs WHERE id='wrong-revision'"),
    ).toBeNull();
    await a.ready("personal-a");
    await a.published("personal-a");
    expect(await legacy.ownsRun("legacy-state")).toBe(true);
    expect(await b.ownsRun("personal-b")).toBe(true);
    expect(await a.ownsRun("personal-a")).toBe(false);
    await b.cancel("personal-b");
    vi.spyOn(b, "ownsRun").mockResolvedValue(true);
    await b.ready("personal-b");
    await b.failed("personal-b", "Late failure.");
    await b.published("personal-b");
    expect((await b.run("personal-b")).status).toBe("cancelled");
    expect(
      await b.one(
        "SELECT published_run_id FROM personal_state WHERE id=?",
        second,
      ),
    ).toEqual({ published_run_id: null });
  });

  it("enforces actual collector discovery and history budgets without limiting legacy default capacity", async () => {
    const { env } = fixture();
    const id = await user(env);
    const store = new CollectionStore(env.DB!, id);
    const revision = await store.saveConfig(config);
    await store.begin("run", revision, new Date().toISOString(), "key");
    const repositories = Array.from({ length: 201 }, (_, index) => ({
      ...publicRepository,
      id: 1000 + index,
    }));
    await expect(
      store.discover("run", publicRepository.owner, repositories.slice(0, 200)),
    ).resolves.toBeUndefined();
    expect((await store.repositories("run")).length).toBe(200);
    await expect(
      store.discover("run", publicRepository.owner, repositories.slice(200)),
    ).rejects.toThrow("200 repository");
    const repo = (await store.repositories("run"))[0]!;
    await store.plan(
      repo,
      {
        name: repo.full_name,
        url: publicRepository.html_url,
        defaultBranch: "main",
        head: null,
        description: "",
        fork: false,
        archived: false,
        latestCommit: null,
      },
      "full",
      null,
    );
    const planned = await store.repository("run", repo.repository_id);
    await expect(
      store.savePage(planned, [], [], () => Promise.resolve(""), {
        cursor: null,
        comparePage: 2,
        expected: null,
        received: 50_001,
      }),
    ).rejects.toThrow("50000");
    const legacy = new CollectionStore(env.DB!);
    const legacyRevision = await legacy.saveConfig(config);
    await legacy.begin(
      "legacy-run",
      legacyRevision,
      new Date().toISOString(),
      "key",
    );
    await expect(
      legacy.discover("legacy-run", publicRepository.owner, repositories),
    ).resolves.toBeUndefined();
    expect((await legacy.repositories("legacy-run")).length).toBe(201);
  });

  it("stops a queued/in-flight collector at live checkpoints without publishing after suspension", async () => {
    const { env, store, put } = fixture();
    const id = await user(env);
    const personal = new CollectionStore(env.DB!, id);
    const revision = await personal.saveConfig(config);
    const params = {
      runId: "stopped-run",
      revisionId: revision,
      until: new Date().toISOString(),
      userId: id,
    };
    await personal.enqueue(params.runId, revision, params.until);
    const steps = {
      do: async (_name: string, callback: () => Promise<void>) => {
        await store
          .statement(
            "UPDATE personal_users SET status='suspended' WHERE id=?",
            id,
          )
          .run();
        await callback();
      },
    };
    await expect(
      runCollection(env, params, steps, githubFetch()),
    ).rejects.toThrow("stopped");
    expect(put).not.toHaveBeenCalled();
    expect(
      await store.one(
        "SELECT snapshot_json FROM personal_state WHERE id=?",
        id,
      ),
    ).toEqual({ snapshot_json: null });
  });

  it.each(["explicit", "all_owned_public"] as const)(
    "collects %s personal history with only the user's OAuth token and public repositories",
    async (repositoryMode) => {
      const { env, store, put } = fixture();
      const id = await user(env);
      const other = await user(env, "202", "second@example.invalid");
      await retainGitHub(
        env,
        other,
        { ...github, id: "202" },
        "other-user-token",
        "read:user,user:email,read:org",
      );
      const oauthEnv = {
        ...env,
        GH_TOKEN_PRIMARY: "server-owner-token",
      };
      delete oauthEnv.GH_TOKEN;
      const personal = new CollectionStore(env.DB!, id);
      const revision = await personal.saveConfig({
        ...config,
        repositoryMode,
        accounts: ["primary"],
      });
      const until = "2026-11-12T04:00:00.000Z";
      const sha = "a".repeat(40);
      const collectedRepository = {
        ...publicRepository,
        owner: { ...publicRepository.owner, type: "Organization" },
      };
      let expectedToken = "oauth-private-token";
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation((input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${expectedToken}`,
          );
          if (url.endsWith("/users/primary"))
            return Promise.resolve(
              Response.json({
                ...publicRepository.owner,
                type: "Organization",
              }),
            );
          if (url.includes("/orgs/primary/repos")) {
            expect(new URL(url).searchParams.get("type")).toBe("public");
            return Promise.resolve(
              Response.json([
                collectedRepository,
                {
                  ...collectedRepository,
                  id: 502,
                  full_name: "primary/private",
                  private: true,
                },
              ]),
            );
          }
          if (url.includes("/repos/"))
            return Promise.resolve(Response.json(collectedRepository));
          const body = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as { query: string };
          if (body.query.includes("Metadata"))
            return Promise.resolve(
              Response.json({
                data: {
                  repository: {
                    databaseId: 501,
                    isPrivate: false,
                    nameWithOwner: "primary/public",
                    url: publicRepository.html_url,
                    description: "Public",
                    isFork: true,
                    isArchived: false,
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: sha,
                        committedDate: until,
                        messageHeadline: "Public activity",
                        url: `${publicRepository.html_url}/commit/${sha}`,
                      },
                    },
                  },
                },
              }),
            );
          return Promise.resolve(
            Response.json({
              data: {
                repository: {
                  isPrivate: false,
                  object: {
                    history: {
                      nodes: [
                        {
                          oid: sha,
                          committedDate: until,
                          additions: 12,
                          deletions: 3,
                          author: {
                            email: "history@example.invalid",
                            user: { login: "historical" },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          );
        });
      const params = {
        runId: "personal-complete",
        revisionId: revision,
        until,
        userId: id,
      };
      await runCollection(
        oauthEnv,
        params,
        { do: (_name, callback) => callback() },
        request,
      );
      expect((await personal.run(params.runId)).status).toBe("published");
      const result = await (
        await call(env, "/personal/activity", await session(id))
      ).json<{ snapshot: ActivitySnapshot }>();
      expect(result.snapshot.totals).toMatchObject({
        commits: 1,
        additions: 12,
        deletions: 3,
      });
      expect(result.snapshot.yearly).toHaveLength(365);
      expect(JSON.stringify(result.snapshot)).not.toContain(
        "history@example.invalid",
      );
      expect(JSON.stringify(result.snapshot)).not.toContain("primary/private");
      expect(JSON.stringify(result.snapshot)).not.toContain(
        "oauth-private-token",
      );
      expect(put).not.toHaveBeenCalled();
      expect(
        await store.one(
          "SELECT * FROM repository_sync_state WHERE repository_id=501",
        ),
      ).toBeNull();
      expect(await personal.syncState(501)).toMatchObject({ head_sha: sha });
      const calls = request.mock.calls.length;
      expectedToken = "renewed-oauth-token";
      await store
        .statement(
          "UPDATE personal_github SET credential=? WHERE user_id=?",
          await encryptCredential(env, id, expectedToken),
          id,
        )
        .run();
      await runCollection(
        oauthEnv,
        { ...params, runId: "personal-reuse" },
        { do: (_name, callback) => callback() },
        request,
      );
      expect(request.mock.calls.length - calls).toBe(
        repositoryMode === "explicit" ? 2 : 3,
      );
      expect((await personal.run("personal-reuse")).status).toBe("published");
    },
  );

  it("rebuilds the legacy config table without losing any references, runs, cache or public state", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const migration of [
      "0001_collection.sql",
      "0002_collection_performance.sql",
    ])
      sqlite.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    sqlite.exec(`
      INSERT INTO config_revisions VALUES ('old-revision','default','explicit','2026-01-01');
      UPDATE collection_configs SET active_revision_id='old-revision',enabled=1;
      INSERT INTO collection_runs VALUES ('old-run','old-revision','published','2026-01-01','2026-01-02','2026-01-02',NULL,'2026-01-02',NULL);
      UPDATE collection_state SET published_run_id='old-run',email_key_id='existing-key',publication_until='2026-01-02';
      INSERT INTO accounts VALUES (1,'legacy','User','2026-01-01');
      INSERT INTO repositories VALUES (2,1,'legacy/repo','2026-01-01');
      INSERT INTO repository_histories VALUES ('history',2,'2026-01-01');
      INSERT INTO commits VALUES (2,'sha','2026-01-01','legacy','hmac',3,4,'2026-01-01');
      INSERT INTO history_commits VALUES ('history',2,'sha');
      INSERT INTO repository_sync_state VALUES(2,'main','sha','history','old-run','2026-01-01');
      BEGIN;
    `);
    sqlite.exec(
      readFileSync(
        new URL("../migrations/0003_personal_workforce.sql", import.meta.url),
        "utf8",
      ),
    );
    sqlite.exec("COMMIT");
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      sqlite.prepare("SELECT * FROM collection_configs").get(),
    ).toMatchObject({
      id: "default",
      active_revision_id: "old-revision",
      enabled: 1,
    });
    expect(
      sqlite.prepare("SELECT * FROM collection_state").get(),
    ).toMatchObject({
      published_run_id: "old-run",
      email_key_id: "existing-key",
    });
    expect(sqlite.prepare("SELECT * FROM history_commits").get()).toMatchObject(
      { history_id: "history", sha: "sha" },
    );
    expect(sqlite.prepare("SELECT * FROM commits").get()).toMatchObject({
      additions: 3,
      deletions: 4,
      author_email_hmac: "hmac",
    });
    expect(
      sqlite.prepare("SELECT * FROM repository_sync_state").get(),
    ).toMatchObject({
      history_id: "history",
      last_successful_run_id: "old-run",
    });
    expect(parseConfig(config)).toEqual(config);
    sqlite.close();
  });
});
