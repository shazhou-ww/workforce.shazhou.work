import { describe, expect, it, vi } from "vitest";
import {
  readAccount,
  readComparison,
  readCommitDetails,
  readHistory,
  readMetadata,
  readMetadataBatch,
} from "../src/collection-github.js";
import {
  createGitHubClient,
  createPublicGitHubClient,
} from "../src/github-client.js";

const head = "1".repeat(40);
const repository = { repository_id: 1, full_name: "owner/repo" };
function client(body: unknown, status = 200) {
  return createGitHubClient(
    "test-token",
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })),
  );
}

describe("incremental GitHub validation", () => {
  it("batches metadata using variables and checks every repository identity", async () => {
    const metadata = {
      databaseId: 1,
      isPrivate: false,
      nameWithOwner: "owner/repo",
      url: "https://github.com/owner/repo",
      description: null,
      isFork: false,
      isArchived: true,
      defaultBranchRef: null,
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          r0: metadata,
          r1: {
            ...metadata,
            databaseId: 2,
            nameWithOwner: "owner/renamed",
            defaultBranchRef: {
              name: "main",
              target: {
                oid: head,
                committedDate: "2026-11-09T00:00:00Z",
                messageHeadline: "Latest",
                url: `https://github.com/owner/renamed/commit/${head}`,
              },
            },
          },
        },
      }),
    );
    const result = await readMetadataBatch(
      createGitHubClient("test-token", request),
      [repository, { repository_id: 2, full_name: 'owner/repo"quoted' }],
    );
    expect(result[0]).toMatchObject({
      head: null,
      defaultBranch: null,
      latestCommit: null,
    });
    expect(result[1]).toMatchObject({
      name: "owner/renamed",
      head,
      defaultBranch: "main",
    });
    const payload = request.mock.calls[0]?.[1]?.body;
    if (typeof payload !== "string") throw new Error("Missing GraphQL payload");
    const body = JSON.parse(payload) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(body.variables).toEqual({
      owner: "owner",
      name0: "repo",
      name1: 'repo"quoted',
    });
    expect(body.query).not.toContain('repo"quoted');
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([0, 11])(
    "rejects metadata batch size %s before requesting GitHub",
    async (size) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        readMetadataBatch(
          createGitHubClient("test-token", request),
          Array.from({ length: size }, () => repository),
        ),
      ).rejects.toThrow("1-10 repositories");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed owners before making a credential-scoped request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      readMetadataBatch(createGitHubClient("test-token", request), [
        repository,
        { repository_id: 2, full_name: "other/repo" },
      ]),
    ).rejects.toThrow("one repository owner");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects missing aliases and partial GraphQL responses", async () => {
    const repositories = [
      repository,
      { repository_id: 2, full_name: "owner/other" },
    ];
    await expect(
      readMetadataBatch(client({ data: {} }), repositories),
    ).rejects.toThrow("Repository");
    await expect(
      readMetadataBatch(
        client({
          data: { r0: { databaseId: 1, isPrivate: false } },
          errors: [{ type: "FORBIDDEN", message: "private-message" }],
        }),
        repositories,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(["User", "Organization"])(
    "resolves a public %s without requesting private profile access",
    async (type) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: 1,
          login: "owner",
          type,
        }),
      );
      expect(
        await readAccount(createPublicGitHubClient(request), "owner"),
      ).toEqual({ id: 1, login: "owner", type });
      expect(
        new Headers(request.mock.calls[0]?.[1]?.headers).has("Authorization"),
      ).toBe(false);
    },
  );

  it.each([
    null,
    { id: null, type: "User" },
    { id: 0, type: "User" },
    { id: 1.5, type: "User" },
    { id: 1, type: "Unknown" },
  ])(
    "rejects missing or invalid public account identity %#",
    async (account) => {
      await expect(readAccount(client(account), "owner")).rejects.toThrow(
        "public identity",
      );
    },
  );

  it.each([
    null,
    { databaseId: 1, isPrivate: true },
    { databaseId: 2, isPrivate: false },
  ])("rejects missing, private or replaced repositories %#", async (repo) => {
    await expect(
      readMetadata(client({ data: { repository: repo } }), repository),
    ).rejects.toThrow("Repository");
  });

  it.each([null, { isPrivate: true }, { isPrivate: false, object: null }])(
    "rejects unavailable pinned history %#",
    async (repo) => {
      await expect(
        readHistory(
          client({ data: { repository: repo } }),
          repository.full_name,
          head,
          null,
        ),
      ).rejects.toThrow("Pinned history");
    },
  );

  it.each([null, "same"])(
    "rejects invalid history cursors: %s",
    async (cursor) => {
      await expect(
        readHistory(
          client({
            data: {
              repository: {
                isPrivate: false,
                object: {
                  history: {
                    nodes: [],
                    pageInfo: { hasNextPage: true, endCursor: cursor },
                  },
                },
              },
            },
          }),
          repository.full_name,
          head,
          cursor,
        ),
      ).rejects.toThrow("pagination");
    },
  );

  it("accepts a valid next history page", async () => {
    const history = {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "next" },
    };
    expect(
      await readHistory(
        client({
          data: {
            repository: {
              isPrivate: false,
              object: { history },
            },
          },
        }),
        repository.full_name,
        head,
        null,
      ),
    ).toEqual(history);
  });

  it("explicitly falls back when a previous head is gone, but not for authorization errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await readComparison(
        client({}, 404),
        repository.full_name,
        head,
        head,
        1,
      ),
    ).toBeNull();
    await expect(
      readComparison(client({}, 401), repository.full_name, head, head, 1),
    ).rejects.toThrow("401");
    vi.restoreAllMocks();
  });

  it.each([
    { status: "invalid", total_commits: 1, ahead_by: 1 },
    { status: "ahead", total_commits: -1, ahead_by: -1 },
    { status: "ahead", total_commits: 1, ahead_by: 2 },
    { status: "ahead", total_commits: 1.5, ahead_by: 1.5 },
  ])("rejects malformed comparison %#", async (result) => {
    await expect(
      readComparison(client(result), repository.full_name, head, head, 1),
    ).rejects.toThrow("comparison");
  });

  it("skips fetching already cached details and validates comparison IDs", async () => {
    expect(
      await readCommitDetails(client({}), repository.full_name, []),
    ).toEqual([]);
    await expect(
      readCommitDetails(client({}), repository.full_name, ["invalid"]),
    ).rejects.toThrow("IDs");
    await expect(
      readCommitDetails(
        client({}),
        repository.full_name,
        Array.from({ length: 101 }, () => head),
      ),
    ).rejects.toThrow("IDs");
  });

  it.each([
    null,
    { isPrivate: true },
    { isPrivate: false, c0: null },
    { isPrivate: false, c0: true },
    { isPrivate: false, c0: { oid: "other" } },
  ])("rejects incomplete or nonpublic commit details %#", async (repo) => {
    await expect(
      readCommitDetails(
        client({ data: { repository: repo } }),
        repository.full_name,
        [head],
      ),
    ).rejects.toThrow();
  });
});
