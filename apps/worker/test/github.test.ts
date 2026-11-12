import { describe, expect, it, vi } from "vitest";

import { collectActivity } from "../src/github.js";

const now = new Date("2026-11-05T08:00:00Z");
const repository = {
  name: "project",
  private: false,
  owner: { login: "owner" },
};
interface TestCommit {
  oid: string;
  committedDate: string;
  additions: number;
  deletions: number;
  author: { email: string; user: { login: string } | null } | null;
}
const ownCommit: TestCommit = {
  oid: "sha",
  committedDate: now.toISOString(),
  additions: 20,
  deletions: 10,
  author: { email: "author@example.com", user: { login: "shazhou-ww" } },
};

function graph({
  nodes = [ownCommit],
  next = false,
  cursor = null as string | null,
  empty = false,
  name = "owner/project",
  privateRepo = false,
} = {}) {
  return {
    data: {
      repository: {
        isPrivate: privateRepo,
        nameWithOwner: name,
        url: `https://github.com/${name}`,
        description: null,
        isFork: true,
        isArchived: false,
        defaultBranchRef: empty
          ? null
          : {
              name: "main",
              target: {
                oid: "original-head",
                committedDate: now.toISOString(),
                messageHeadline: "Update project",
                url: `https://github.com/${name}/commit/sha`,
                history: {
                  nodes,
                  pageInfo: { hasNextPage: next, endCursor: cursor },
                },
              },
            },
        object: empty
          ? null
          : {
              history: {
                nodes,
                pageInfo: { hasNextPage: next, endCursor: cursor },
              },
            },
      },
    },
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("public GitHub collector", () => {
  it("requests a full year for offline collection but preserves the 30-day dashboard window", async () => {
    const warmup = {
      ...ownCommit,
      oid: "warmup",
      committedDate: "2026-10-06T15:00:00Z",
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([repository]))
      .mockResolvedValueOnce(
        response(
          graph({
            nodes: [
              ownCommit,
              warmup,
              warmup,
              {
                ...ownCommit,
                oid: "older",
                committedDate: "2026-03-01T16:00:00Z",
              },
              {
                ...ownCommit,
                oid: "outside",
                committedDate: "2020-01-01T00:00:00Z",
              },
            ],
          }),
        ),
      );
    const result = await collectActivity({
      accounts: ["owner"],
      token: "token",
      now,
      request,
    });
    expect(result.daily).toHaveLength(30);
    expect(result.totals.commits).toBe(1);
    expect(result.yearly).toHaveLength(365);
    expect(
      result.yearly?.find((day) => day.date === "2026-03-02")?.commits,
    ).toBe(1);
    expect(result.yearly?.reduce((sum, day) => sum + day.commits, 0)).toBe(3);
    const body = request.mock.calls[1]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Missing GraphQL body");
    expect(JSON.parse(body)).toMatchObject({
      variables: { since: "2025-11-05T16:00:00.000Z" },
    });
    expect(result.rolling?.[0]).toMatchObject({
      at: result.since,
      commits: 1,
      additions: 20,
      deletions: 10,
    });
    expect(result.rolling?.at(-1)).toMatchObject({
      at: "2026-11-05T08:00:00.000Z",
      commits: 1,
    });
  });
  it("counts only the primary account or confirmed author emails, keeping forks and filtering every page", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([repository]))
      .mockResolvedValueOnce(
        response(
          graph({
            nodes: [
              {
                ...ownCommit,
                author: {
                  email: "different@example.com",
                  user: { login: "SHAZHOU-WW" },
                },
              },
              {
                ...ownCommit,
                oid: "upstream",
                additions: 9999,
                author: {
                  email: "upstream@example.com",
                  user: { login: "upstream" },
                },
              },
              {
                ...ownCommit,
                oid: "bot",
                author: {
                  email: "bot@example.com",
                  user: { login: "Copilot" },
                },
              },
              { ...ownCommit, oid: "unknown", author: null },
            ],
            next: true,
            cursor: "next",
          }),
        ),
      )
      .mockResolvedValueOnce(
        response(
          graph({
            nodes: [
              {
                ...ownCommit,
                oid: "email-one",
                author: { email: " FIRST@example.com ", user: null },
              },
              {
                ...ownCommit,
                oid: "email-two",
                author: { email: "second@example.com", user: null },
              },
              {
                ...ownCommit,
                oid: "unconfirmed",
                author: { email: "unknown@example.com", user: null },
              },
              {
                ...ownCommit,
                oid: "upstream-page",
                author: {
                  email: "upstream@example.com",
                  user: { login: "upstream" },
                },
              },
              ownCommit,
            ],
          }),
        ),
      );
    const result = await collectActivity({
      accounts: ["owner"],
      authorLogin: "shazhou-ww",
      authorEmails: ["first@example.com", "SECOND@example.com"],
      token: "token",
      now,
      request,
    });
    expect(result.authorFilter).toEqual({
      login: "shazhou-ww",
      emailMatching: true,
    });
    expect(result.repositories[0]?.fork).toBe(true);
    expect(result.repositories[0]?.latestCommit?.message).toBe(
      "Update project",
    );
    expect(result.totals).toEqual({
      commits: 3,
      additions: 60,
      deletions: 30,
      averageLines: 30,
    });
    expect(result.repositories[0]?.commits).toBe(3);
    expect(result.daily.at(-1)?.commits).toBe(3);
    expect(JSON.stringify(result)).not.toContain("@example.com");
    for (const call of request.mock.calls.slice(1)) {
      const body = call[1]?.body;
      if (typeof body !== "string") throw new Error("Missing GraphQL body");
      expect(body).toContain("author { email user { login } }");
      expect(body).not.toContain("committer");
    }
  });

  it("returns real zero totals when no primary author matches and supports a different configured author", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([repository]))
      .mockResolvedValueOnce(response(graph()));
    const result = await collectActivity({
      accounts: ["owner"],
      authorLogin: "another-user",
      token: "token",
      now,
      request,
    });
    expect(result.totals.commits).toBe(0);
    expect(result.repositories).toHaveLength(1);
    expect(result.authorFilter).toEqual({
      login: "another-user",
      emailMatching: false,
    });
  });

  it.each([
    {
      authorLogin: "bad/name",
      authorEmails: [],
      message: "GITHUB_AUTHOR_LOGIN",
    },
    {
      authorLogin: "shazhou-ww",
      authorEmails: ["invalid"],
      message: "GITHUB_AUTHOR_EMAILS",
    },
  ])(
    "rejects invalid author configuration: $message",
    async ({ authorLogin, authorEmails, message }) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        collectActivity({
          accounts: ["owner"],
          authorLogin,
          authorEmails,
          token: "token",
          now,
          request,
        }),
      ).rejects.toThrow(message);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("retries transient GraphQL failures without duplicating history", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([repository]))
        .mockResolvedValueOnce(response({}, 502))
        .mockResolvedValueOnce(response({}, 503))
        .mockResolvedValueOnce(response(graph()));
      const result = collectActivity({
        accounts: ["owner"],
        token: "token",
        now,
        request,
      });
      await vi.runAllTimersAsync();
      expect((await result).totals.commits).toBe(1);
      expect(request).toHaveBeenCalledTimes(4);
      expect(request.mock.calls[1]?.[1]?.body).toBe(
        request.mock.calls[3]?.[1]?.body,
      );
      expect(warning).toHaveBeenNthCalledWith(
        1,
        "GitHub /graphql: HTTP 502; retry 1/2 in 1000ms.",
      );
      expect(warning).toHaveBeenNthCalledWith(
        2,
        "GitHub /graphql: HTTP 503; retry 2/2 in 2000ms.",
      );
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([500, 502, 503, 504])(
    "stops after three attempts on HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const request = vi
          .fn<typeof fetch>()
          .mockImplementation(() => Promise.resolve(response({}, status)));
        const rejected = expect(
          collectActivity({
            accounts: ["owner"],
            token: "token",
            now,
            request,
          }),
        ).rejects.toThrow(`HTTP ${status}`);
        await vi.runAllTimersAsync();
        await rejected;
        expect(request).toHaveBeenCalledTimes(3);
        expect(warning).toHaveBeenCalledTimes(2);
      } finally {
        warning.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("collects all repository and history pages and never counts a SHA twice per repository", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(Array.from({ length: 100 }, () => repository)),
      )
      .mockResolvedValueOnce(
        response([
          { ...repository, name: "empty" },
          { ...repository, name: "private", private: true },
        ]),
      )
      .mockResolvedValueOnce(response(graph({ next: true, cursor: "next" })))
      .mockResolvedValueOnce(response(graph()))
      .mockResolvedValueOnce(
        response(graph({ empty: true, name: "owner/empty" })),
      );
    const result = await collectActivity({
      accounts: ["owner", "owner"],
      token: "test-token",
      now,
      request,
    });

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[1]?.[0]).toContain("page=2");
    const pageBody = request.mock.calls[3]?.[1]?.body;
    if (typeof pageBody !== "string")
      throw new Error("Missing GraphQL request body");
    expect(JSON.parse(pageBody)).toMatchObject({
      variables: {
        head: "original-head",
        cursor: "next",
        since: "2025-11-05T16:00:00.000Z",
      },
    });
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories[0]?.name).toBe("owner/project");
    expect(result.repositories[0]?.fork).toBe(true);
    expect(result.repositories[1]).toMatchObject({
      defaultBranch: null,
      latestCommit: null,
      commits: 0,
    });
    expect(result.totals).toEqual({
      commits: 1,
      additions: 20,
      deletions: 10,
      averageLines: 30,
    });
    expect(result.daily).toHaveLength(30);
    expect(result.accounts).toEqual(["owner"]);
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer test-token",
    });
  });

  it("supports multiple accounts, zero public repositories, and a default collection time", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response([])));
    const result = await collectActivity({
      accounts: ["owner", "org"],
      token: "token",
      request,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.repositories).toEqual([]);
    expect(result.totals.commits).toBe(0);
  });

  it("uses repository name to break sorting ties and counts shared commits across repositories", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([repository, { ...repository, name: "a" }]),
      )
      .mockResolvedValueOnce(response(graph()))
      .mockResolvedValueOnce(response(graph({ name: "owner/a" })));
    const result = await collectActivity({
      accounts: ["owner"],
      token: "token",
      now,
      request,
    });
    expect(result.repositories.map((repo) => repo.name)).toEqual([
      "owner/a",
      "owner/project",
    ]);
    expect(result.totals.commits).toBe(2);
  });

  it.each([
    { accounts: ["owner"], token: "", message: "GH_TOKEN" },
    { accounts: [], token: "token", message: "valid GitHub account" },
    { accounts: ["bad/name"], token: "token", message: "valid GitHub account" },
  ])(
    "rejects invalid collection configuration: $message",
    async ({ accounts, token, message }) => {
      await expect(collectActivity({ accounts, token })).rejects.toThrow(
        message,
      );
    },
  );

  it.each([null, "12345"])(
    "reports HTTP failure with reset information: %s",
    async (reset) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("Rate limited", {
          status: 403,
          ...(reset ? { headers: { "x-ratelimit-reset": reset } } : {}),
        }),
      );
      await expect(
        collectActivity({ accounts: ["owner"], token: "token", request }),
      ).rejects.toThrow("HTTP 403");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { errors: [{ message: "Rate limit exceeded" }] },
    { data: { repository: null } },
    {},
    graph({ privateRepo: true }),
    graph({ next: true }),
  ])(
    "fails the entire snapshot on an incomplete or non-public repository",
    async (body) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([repository]))
        .mockResolvedValueOnce(response(body));
      await expect(
        collectActivity({ accounts: ["owner"], token: "token", now, request }),
      ).rejects.toThrow();
    },
  );

  it("rejects repeated pagination cursors instead of looping forever", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([repository]))
      .mockImplementation(() =>
        Promise.resolve(response(graph({ next: true, cursor: "same" }))),
      );
    await expect(
      collectActivity({ accounts: ["owner"], token: "token", now, request }),
    ).rejects.toThrow("pagination cursor");
  });

  it("does not suppress network failures", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network unavailable"));
    await expect(
      collectActivity({ accounts: ["owner"], token: "token", request }),
    ).rejects.toThrow("network unavailable");
  });

  it.each([
    { data: { repository: null } },
    { data: { repository: { isPrivate: true } } },
    { data: { repository: { isPrivate: false, object: null } } },
  ])(
    "rejects inaccessible pinned history rather than publishing a partial snapshot",
    async (page) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([repository]))
        .mockResolvedValueOnce(response(graph({ next: true, cursor: "next" })))
        .mockResolvedValueOnce(response(page));
      await expect(
        collectActivity({ accounts: ["owner"], token: "token", now, request }),
      ).rejects.toThrow("pinned history");
    },
  );
});
