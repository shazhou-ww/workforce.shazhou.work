import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityCollection } from "../src/collection-workflow.js";
import { runCollection, type CollectionParams } from "../src/collection.js";
import { GitHubError, createGitHubClient } from "../src/github-client.js";
import { CollectionStore } from "../src/collection-store.js";
import { parseConfig } from "../src/collection-config.js";
import entry from "../src/entry.js";
import type { Bindings } from "../src/env.js";
import { TestD1 } from "./d1.js";

vi.mock("../src/collection.js", () => ({ runCollection: vi.fn() }));

const databases: TestD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  vi.restoreAllMocks();
  vi.mocked(runCollection).mockReset();
});

function setup() {
  const env = {
    APP_NAME: "Workforce",
    AUTH_SECRET: "test-auth-secret",
  } as Bindings;
  const sleepUntil = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn();
  execute.mockImplementation(
    async (
      _name: string,
      _options: unknown,
      callback: () => Promise<{ retryAt: number | null }>,
    ) => callback(),
  );
  const step: WorkflowStep = {
    do: execute,
    sleepUntil,
    sleep: vi.fn(),
    waitForEvent: vi.fn(),
  };
  const event = {
    payload: {
      runId: "run",
      revisionId: "revision",
      until: "2026-11-09T05:00:00Z",
    },
  } as WorkflowEvent<CollectionParams>;
  const workflow = new ActivityCollection({} as ExecutionContext, env);
  return { env, step, event, workflow, sleepUntil, execute };
}

describe("durable collection orchestration", () => {
  it("delegates ordinary steps without persisting their sensitive outputs", async () => {
    const { workflow, event, step, execute } = setup();
    const callback = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runCollection).mockImplementation(
      async (_env, _params, steps) => {
        await steps.do("page", callback);
      },
    );
    await workflow.run(event, step);
    expect(callback).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("sleeps until a rate limit reset, then resumes the same logical step", async () => {
    const { workflow, event, step, sleepUntil } = setup();
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new GitHubError(429, 1000, "/graphql", null))
      .mockResolvedValue(undefined);
    vi.mocked(runCollection).mockImplementation(
      async (_env, _params, steps) => {
        await steps.do("page", callback);
      },
    );
    await workflow.run(event, step);
    expect(sleepUntil).toHaveBeenCalledWith("page rate limit 0", 2000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it.each([
    new GitHubError(401, null, "/graphql", null),
    new GitHubError(500, null, "/graphql", null),
    new Error("Network unavailable"),
  ])("surfaces exhausted or permanent failures: %s", async (error) => {
    const { workflow, event, step } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runCollection).mockImplementation(
      async (_env, _params, steps) => {
        await steps.do("page", () => Promise.reject(error));
      },
    );
    await expect(workflow.run(event, step)).rejects.toThrow();
  });

  it("bounds repeated rate-limit waits and records failure without releasing the lock", async () => {
    const { env, event, step, sleepUntil } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new TestD1();
    databases.push(db);
    const store = new CollectionStore(db);
    const revisionId = await store.saveConfig(
      parseConfig({
        enabled: false,
        accounts: ["owner"],
        authorLogins: ["owner"],
        authorEmails: [],
        repositoryMode: "all_owned_public",
        includeRepositories: [],
        excludeRepositories: [],
      }),
    );
    await store.begin("run", revisionId, event.payload.until, "key");
    const workflow = new ActivityCollection({} as ExecutionContext, {
      ...env,
      DB: db,
    });
    vi.mocked(runCollection).mockImplementation(
      async (_env, _params, steps) => {
        await steps.do("page", () =>
          Promise.reject(new GitHubError(403, 1000, "/graphql", null)),
        );
      },
    );
    await expect(workflow.run(event, step)).rejects.toThrow("retry budget");
    expect(sleepUntil).toHaveBeenCalledTimes(8);
    expect((await store.run("run")).status).toBe("failed");
    expect(await store.ownsRun("run")).toBe(true);
  });

  it("keeps scheduled collection disabled by default", async () => {
    const { env } = setup();
    await entry.scheduled({ scheduledTime: 0 } as ScheduledController, env);
    await expect(
      entry.scheduled({ scheduledTime: 0 } as ScheduledController, {
        ...env,
        COLLECTION_ENABLED: "true",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("GitHub rate-limit signals", () => {
  it.each([
    ["Bad credentials", "rejected the credential"],
    [
      "Resource not accessible by personal access token",
      "Resource not accessible by personal access token",
    ],
    [
      "Resource not accessible by integration",
      "Resource not accessible by integration",
    ],
    [
      "The organization has enabled OAuth App access restrictions",
      "restricts OAuth application",
    ],
    ["SAML enforcement requires authorization", "SAML authorization"],
    ["IP allow list denied 192.0.2.1", "IP allowlist"],
    ["This endpoint rejects fine-grained tokens", "fine-grained token"],
    ["API rate limit exceeded", "rate limit exceeded"],
    ["secret-value-must-not-be-logged", "Unrecognized GitHub rejection"],
    [null, "No GitHub rejection reason"],
  ])(
    "surfaces safe GitHub rejection details: %s",
    async (message, expected) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          { message },
          {
            status: 403,
            headers: { "x-accepted-github-permissions": "members=read" },
          },
        ),
      );
      const rejected = createGitHubClient("test-token", request).github(
        "/users/org",
      );
      await expect(rejected).rejects.toThrow(expected);
      await expect(rejected).rejects.toThrow(
        "Required permissions: members=read",
      );
      await expect(rejected).rejects.not.toThrow(
        "secret-value-must-not-be-logged",
      );
      await expect(rejected).rejects.not.toThrow("192.0.2.1");
    },
  );

  it.each([
    { status: 429, headers: {} },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2000000000",
      },
    },
    { status: 403, headers: { "retry-after": "120" } },
    {
      status: 429,
      headers: { "retry-after": "invalid", "x-ratelimit-reset": "invalid" },
    },
  ])(
    "provides a finite retry deadline for HTTP $status",
    async ({ status, headers }) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status, headers }));
      const client = createGitHubClient("test-token", request);
      const error = await client
        .github("/repos/owner/project")
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(GitHubError);
      if (!(error instanceof GitHubError))
        throw new Error("Missing GitHub error");
      expect(Number.isFinite(error.retryAt)).toBe(true);
    },
  );

  it("recognizes GraphQL rate limiting even with HTTP 200", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        errors: [{ type: "RATE_LIMITED", message: "Rate limited" }],
      }),
    );
    await expect(
      createGitHubClient("test-token", request).graphql("query {}", {}),
    ).rejects.toMatchObject({ status: 429 });
  });
});
