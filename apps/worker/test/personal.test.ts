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
  } = {},
) {
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
            login: "primary",
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
      return Promise.resolve(Response.json([publicRepository]));
    if (url.includes("/repos/"))
      return Promise.resolve(Response.json(publicRepository));
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("personal access and invitations", () => {
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

  it("keeps basic GitHub connection returns separate from organization authorization context", async () => {
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
    expect(body).not.toContain("read%3Aorg");
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
    const repos = Array.from({ length: 51 }, (_, index) => ({
      ...publicRepository,
      id: 1000 + index,
      full_name: `primary/r${index}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((input: string) =>
          Promise.resolve(
            Response.json(input.includes("/repos?") ? repos : repos[0]),
          ),
        ),
    );
    const large = {
      ...config,
      repositoryMode: "all_owned_public",
      includeRepositories: [],
    };
    expect(
      (await call(env, "/personal/config", cookie, "PUT", large)).status,
    ).toBe(422);
    expect(
      (
        await call(env, "/personal/config", cookie, "PUT", {
          ...large,
          excludeRepositories: ["old/renamed"],
        })
      ).status,
    ).toBe(200);
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
      startPersonalCollection({ ...env, GH_TOKEN: "" }, first),
    ).rejects.toMatchObject({ code: "collection_unavailable" });
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
    const repositories = Array.from({ length: 51 }, (_, index) => ({
      ...publicRepository,
      id: 1000 + index,
    }));
    await expect(
      store.discover("run", publicRepository.owner, repositories),
    ).rejects.toThrow("50 repository");
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
    expect((await legacy.repositories("legacy-run")).length).toBe(51);
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

  it("collects complete personal history and yearly statistics without touching the public KV or another user's sync watermark", async () => {
    const { env, store, put } = fixture();
    const id = await user(env);
    const personal = new CollectionStore(env.DB!, id);
    const revision = await personal.saveConfig(config);
    const until = "2026-11-12T04:00:00.000Z";
    const sha = "a".repeat(40);
    const request = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/repos/"))
        return Promise.resolve(Response.json(publicRepository));
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
      env,
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
    expect(put).not.toHaveBeenCalled();
    expect(
      await store.one(
        "SELECT * FROM repository_sync_state WHERE repository_id=501",
      ),
    ).toBeNull();
    expect(await personal.syncState(501)).toMatchObject({ head_sha: sha });
    const calls = request.mock.calls.length;
    await runCollection(
      env,
      { ...params, runId: "personal-reuse" },
      { do: (_name, callback) => callback() },
      request,
    );
    expect(request.mock.calls.length - calls).toBe(2);
    expect((await personal.run("personal-reuse")).status).toBe("published");
  });

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
