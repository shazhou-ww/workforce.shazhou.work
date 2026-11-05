import { describe, expect, it, vi } from "vitest";

import { collectActivity } from "../src/github.js";

const now = new Date("2026-11-05T08:00:00Z");
const repository = {
  name: "project",
  private: false,
  owner: { login: "owner" },
};

function graph({
  nodes = [
    {
      oid: "sha",
      committedDate: now.toISOString(),
      additions: 20,
      deletions: 10,
    },
  ],
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
        since: "2026-10-06T16:00:00.000Z",
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
