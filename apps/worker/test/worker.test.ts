import type {
  BootstrapResponse,
  HealthResponse,
} from "@shazhou-work/workforce-contracts";
import { describe, expect, it, vi } from "vitest";
import { encode } from "@auth/core/jwt";

import { createAuthConfig } from "../src/auth.js";
import type { Bindings } from "../src/env.js";
import app, { toSessionResponse } from "../src/index.js";

const baseBindings = {
  APP_NAME: "Signal Desk",
  AUTH_SECRET: "test-secret-that-is-long-enough-for-auth",
} as Bindings;

describe("Worker", () => {
  const oauthBindings = {
    ...baseBindings,
    AUTH_GITHUB_ID: "github-id",
    AUTH_GITHUB_SECRET: "github-secret",
  };

  it("redirects legacy authentication links to branded pages without signing out on GET", async () => {
    for (const [action, page] of [
      ["signin", "/signin"],
      ["signout", "/signout"],
    ]) {
      const response = await app.request(
        `https://example.test/api/auth/${action}?callbackUrl=%2F`,
        {},
        oauthBindings,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        action === "signin"
          ? `${page}?callbackUrl=https%3A%2F%2Fexample.test%2F`
          : page,
      );
      expect(response.headers.getSetCookie().join(";")).not.toContain(
        "session-token=;",
      );
    }
  });

  it("starts GitHub OAuth from a CSRF-protected POST and rejects an external callback", async () => {
    const csrf = await app.request(
      "https://example.test/api/auth/csrf",
      {},
      oauthBindings,
    );
    const { csrfToken } = await csrf.json<{ csrfToken: string }>();
    const response = await app.request(
      "https://example.test/api/auth/signin/github",
      {
        method: "POST",
        headers: {
          Cookie: csrf.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0])
            .join("; "),
        },
        body: new URLSearchParams({
          csrfToken,
          callbackUrl: "https://untrusted.test/",
        }),
      },
      oauthBindings,
    );
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("Location") ?? "");
    expect(destination.origin).toBe("https://github.com");
    expect(destination.searchParams.get("redirect_uri")).toBe(
      "https://example.test/api/auth/callback/github",
    );
    expect(response.headers.getSetCookie().join(";")).not.toContain(
      "untrusted.test",
    );
  });

  it("clears an authenticated session only after a CSRF-protected signout POST", async () => {
    const sessionName = "__Secure-authjs.session-token";
    const session = await encode({
      token: { sub: "administrator", githubAccountId: "123" },
      secret: baseBindings.AUTH_SECRET,
      salt: sessionName,
    });
    const csrf = await app.request(
      "https://example.test/api/auth/csrf",
      {},
      oauthBindings,
    );
    const { csrfToken } = await csrf.json<{ csrfToken: string }>();
    const cookies = [
      `${sessionName}=${session}`,
      ...csrf.headers.getSetCookie().map((cookie) => cookie.split(";")[0]),
    ].join("; ");
    const valid = await app.request(
      "https://example.test/api/auth/signout",
      {
        method: "POST",
        headers: { Cookie: cookies },
        body: new URLSearchParams({ csrfToken, callbackUrl: "/" }),
      },
      oauthBindings,
    );
    expect(valid.status).toBe(302);
    expect(valid.headers.get("Location")).toBe("https://example.test/");
    expect(valid.headers.getSetCookie().join(";")).toContain(
      `${sessionName}=;`,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invalid = await app.request(
        "https://example.test/api/auth/signout",
        {
          method: "POST",
          headers: { Cookie: cookies },
          body: new URLSearchParams({ csrfToken: "forged-token" }),
        },
        oauthBindings,
      );
      expect(invalid.status).toBe(302);
      expect(invalid.headers.get("Location")).toBe(
        "https://example.test/signin?error=MissingCSRF",
      );
      expect(invalid.headers.getSetCookie().join(";")).not.toContain(
        `${sessionName}=;`,
      );
    } finally {
      log.mockRestore();
    }
  });

  it("serves the public snapshot without requiring a session", async () => {
    const snapshot = { version: 1, repositories: [], daily: [] };
    const get = vi.fn().mockResolvedValue(snapshot);
    const response = await app.request(
      "http://example.test/api/activity",
      {},
      {
        ...baseBindings,
        STATS: { get },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(get).toHaveBeenCalledWith("activity:v1", "json");
    await expect(response.json()).resolves.toEqual(snapshot);
  });

  it("distinguishes an uninitialized KV from a real zero-activity snapshot", async () => {
    const response = await app.request(
      "http://example.test/api/activity",
      {},
      {
        ...baseBindings,
        STATS: { get: vi.fn().mockResolvedValue(null) },
      },
    );
    expect(response.status).toBe(503);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("快照");
  });

  it("logs storage failures and returns an explicit error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request(
        "http://example.test/api/activity",
        {},
        {
          ...baseBindings,
          STATS: {
            get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
          },
        },
      );
      expect(response.status).toBe(500);
      expect(log).toHaveBeenCalled();
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("失败");
    } finally {
      log.mockRestore();
    }
  });

  it("reports health", async () => {
    const response = await app.request(
      "http://example.test/api/health",
      {},
      baseBindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json<HealthResponse>()).resolves.toEqual({
      service: "Signal Desk",
      status: "ok",
    });
  });

  it("only exposes configured identity providers", async () => {
    const response = await app.request(
      "http://example.test/api/bootstrap",
      {},
      {
        ...baseBindings,
        AUTH_GITHUB_ID: "github-id",
        AUTH_GITHUB_SECRET: "github-secret",
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        AUTH_MICROSOFT_ENTRA_ID_ID: "microsoft-id",
        AUTH_MICROSOFT_ENTRA_ID_ISSUER:
          "https://login.microsoftonline.com/common/v2.0",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "microsoft-secret",
      },
    );

    const body = await response.json<BootstrapResponse>();
    expect(body.providers).toEqual([
      { id: "github", label: "GitHub" },
      { id: "google", label: "Google" },
      { id: "microsoft-entra-id", label: "Microsoft" },
    ]);
  });

  it("ignores incomplete credentials and supports the default Microsoft issuer", async () => {
    const bindings: Bindings = {
      ...baseBindings,
      AUTH_GITHUB_ID: "github-without-a-secret",
      AUTH_GOOGLE_ID: " ",
      AUTH_GOOGLE_SECRET: "google-secret",
      AUTH_MICROSOFT_ENTRA_ID_ID: "microsoft-id",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "microsoft-secret",
    };
    const response = await app.request(
      "http://example.test/api/bootstrap",
      {},
      bindings,
    );

    await expect(response.json<BootstrapResponse>()).resolves.toMatchObject({
      providers: [{ id: "microsoft-entra-id", label: "Microsoft" }],
    });
    expect(createAuthConfig(bindings).providers).toHaveLength(1);
  });

  it("protects the current-user endpoint", async () => {
    const response = await app.request(
      "http://example.test/api/me",
      {},
      baseBindings,
    );

    expect(response.status).toBe(401);
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const response = await app.request(
      "http://example.test/api/unknown",
      {},
      baseBindings,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("maps Auth.js sessions to the public contract", () => {
    expect(
      toSessionResponse({
        expires: "2099-01-01T00:00:00.000Z",
        user: {
          email: "operator@example.test",
          name: "Operator",
        },
      }),
    ).toEqual({
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        email: "operator@example.test",
        name: "Operator",
      },
    });
    expect(
      toSessionResponse({
        expires: "2099-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      expires: "2099-01-01T00:00:00.000Z",
    });
  });
});
