import { describe, expect, it, vi } from "vitest";
import {
  createGitHubClient,
  createOwnerGitHubClient,
  createOrganizationGitHubClient,
} from "../src/github-client.js";

describe("owner-specific GitHub credentials", () => {
  it("normalizes owner names and selects only the matching GitHub secret", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({})));
    const credentials = {
      GH_TOKEN: "default-test-token",
      GH_TOKEN_SILVERMOON_WORK: "organization-test-token",
      AUTH_SECRET: "unrelated-authentication-secret",
    };
    await createOwnerGitHubClient(
      credentials,
      "Silvermoon-Work",
      request,
    ).github("/repos/org/repo");
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer organization-test-token");
    await createOwnerGitHubClient(credentials, "other-owner", request).github(
      "/repos/org/repo",
    );
    expect(
      new Headers(request.mock.calls[1]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer default-test-token");
    await createOwnerGitHubClient(credentials, "auth-secret", request).github(
      "/repos/org/repo",
    );
    expect(
      new Headers(request.mock.calls[2]?.[1]?.headers).get("Authorization"),
    ).not.toContain("unrelated-authentication-secret");
  });

  it("keeps managed-user overrides distinct from hyphenated owner overrides", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({})));
    const credentials = {
      GH_TOKEN: "default-test-token",
      GH_TOKEN_MANAGED_USER__ENTERPRISE: "managed-test-token",
      GH_TOKEN_MANAGED_USER_ENTERPRISE: "ordinary-test-token",
    };
    for (const owner of [
      "Managed-User_Enterprise",
      "managed-user-enterprise",
    ]) {
      await createOwnerGitHubClient(credentials, owner, request).github(
        "/user",
      );
    }
    expect(
      request.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("Authorization"),
      ),
    ).toEqual(["Bearer managed-test-token", "Bearer ordinary-test-token"]);
  });

  it.each(["", "bad/name", "bad name", "bad--name"])(
    "rejects invalid owner %s",
    (owner) => {
      expect(() =>
        createOwnerGitHubClient({ GH_TOKEN: "default-test-token" }, owner),
      ).toThrow("valid GitHub owner");
    },
  );

  it("rejects empty overrides rather than masking a configuration error", () => {
    expect(() =>
      createOwnerGitHubClient(
        {
          GH_TOKEN: "default-test-token",
          GH_TOKEN_OWNER: " ",
        },
        "owner",
      ),
    ).toThrow("GH_TOKEN_OWNER is empty");
    expect(() => createOwnerGitHubClient({}, "owner")).toThrow("GH_TOKEN");
  });
});

describe("organization discovery credentials", () => {
  it("uses only the matching override and otherwise remains anonymous", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json([])));
    const credentials = {
      GH_TOKEN: "personal-test-token",
      GH_TOKEN_SILVERMOON_WORK: "organization-test-token",
    };
    await createOrganizationGitHubClient(
      credentials,
      "Silvermoon-Work",
      request,
    ).github("/orgs/Silvermoon-Work/repos?type=public");
    const authorization = new Headers(request.mock.calls[0]?.[1]?.headers).get(
      "Authorization",
    );
    expect(authorization).toBe(
      new Headers({
        Authorization: `Bearer ${credentials.GH_TOKEN_SILVERMOON_WORK}`,
      }).get("Authorization"),
    );
    await createOrganizationGitHubClient(
      credentials,
      "other-owner",
      request,
    ).github("/orgs/other-owner/repos?type=public");
    expect(
      new Headers(request.mock.calls[1]?.[1]?.headers).has("Authorization"),
    ).toBe(false);
  });

  it("rejects an empty organization override", () => {
    expect(() =>
      createOrganizationGitHubClient({ GH_TOKEN_OWNER: " " }, "owner"),
    ).toThrow("GH_TOKEN_OWNER is empty");
  });

  it("surfaces permission errors without retrying anonymously", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        ),
      );
    await expect(
      createOrganizationGitHubClient(
        { GH_TOKEN_OWNER: "organization-test-token" },
        "owner",
        request,
      ).github("/orgs/owner/repos?type=public"),
    ).rejects.toMatchObject({ status: 403, retryAt: null });
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("safe GraphQL diagnostics", () => {
  it("classifies forbidden GraphQL access as permanent without exposing response text", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        errors: [
          {
            type: "FORBIDDEN",
            message:
              "Resource not accessible by personal access token: secret-value",
          },
        ],
      }),
    );
    const result = createGitHubClient("test-token", request).graphql(
      "query {}",
      {},
    );
    await expect(result).rejects.toMatchObject({ status: 403, retryAt: null });
    await expect(result).rejects.toThrow("FORBIDDEN");
    await expect(result).rejects.not.toThrow("secret-value");
  });

  it.each(["NOT_FOUND", undefined, "private-secret-type"])(
    "sanitizes GraphQL error type %s",
    async (type) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          errors: [{ type, message: "private-error-message" }],
        }),
      );
      const result = createGitHubClient("test-token", request).graphql(
        "query {}",
        {},
      );
      await expect(result).rejects.toThrow(
        type === "NOT_FOUND" ? "NOT_FOUND" : "UNKNOWN",
      );
      await expect(result).rejects.not.toThrow("private-error-message");
      await expect(result).rejects.not.toThrow("private-secret-type");
    },
  );
});
