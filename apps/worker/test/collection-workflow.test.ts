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
import { PersonalError, registerIdentity } from "../src/platform.js";

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
  it("runs isolated private collection in a bounded step without durable sensitive outputs", async () => {
    const { env, event, step, execute } = setup();
    const callback = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runCollection).mockImplementation(
      async (_env, _params, steps) => {
        await steps.do("private repository 0", callback);
      },
    );
    const payload = {
      ...event.payload,
      userId: crypto.randomUUID(),
      privateGeneration: "generation",
    };
    const workflow = new ActivityCollection({} as ExecutionContext, env);
    await workflow.run({ ...event, payload }, step);
    expect(callback).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe("private repository 0");
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      timeout: "5 minutes",
      retries: { limit: 0 },
    });
  });

  it("sanitizes private Workflow failures and releases only the matching generation", async () => {
    const { env, event, step } = setup();
    const db = new TestD1();
    databases.push(db);
    const personalEnv = { ...env, DB: db, COLLECTION_ADMIN_GITHUB_IDS: "101" };
    const userId = (await registerIdentity(personalEnv, "github", "101", []))!;
    const store = new CollectionStore(db);
    await store
      .statement(
        "INSERT INTO personal_private_repositories(user_id,generation,credential,repositories_json,active_run_id,snapshot_json) VALUES (?,?,?,'[]',?,?)",
        userId,
        "generation",
        "encrypted",
        "run",
        "old private snapshot",
      )
      .run();
    vi.mocked(runCollection).mockRejectedValue(
      new Error("sensitive repository name and credential"),
    );
    const workflow = new ActivityCollection(
      {} as ExecutionContext,
      personalEnv,
    );
    await expect(
      workflow.run(
        {
          ...event,
          payload: {
            ...event.payload,
            userId,
            privateGeneration: "generation",
          },
        },
        step,
      ),
    ).rejects.toThrow("Private collection failed");
    const state = await store.one<{
      active_run_id: string | null;
      snapshot_json: string | null;
      error_message: string;
    }>(
      "SELECT active_run_id,snapshot_json,error_message FROM personal_private_repositories WHERE user_id=?",
      userId,
    );
    expect(state).toMatchObject({
      active_run_id: null,
      snapshot_json: "old private snapshot",
    });
    expect(state?.error_message).not.toContain("sensitive");
  });

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

  it.each(["rejected", "unreadable", "forbidden", "refresh"] as const)(
    "records actionable personal credential failures without exposing provider details: %s",
    async (failure) => {
      const { env, event, step, execute, sleepUntil } = setup();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const db = new TestD1();
      databases.push(db);
      const personalEnv = {
        ...env,
        DB: db,
        COLLECTION_ADMIN_GITHUB_IDS: "101",
      };
      const userId = await registerIdentity(personalEnv, "github", "101", []);
      if (!userId) throw new Error("Personal test user was not created.");
      const store = new CollectionStore(db, userId);
      const revisionId = await store.saveConfig(
        parseConfig({
          enabled: true,
          accounts: ["owner"],
          authorLogins: ["owner"],
          authorEmails: [],
          repositoryMode: "all_owned_public",
          includeRepositories: [],
          excludeRepositories: [],
        }),
      );
      await store.begin("run", revisionId, event.payload.until, "key");
      await store
        .statement(
          "UPDATE personal_state SET snapshot_json=? WHERE id=?",
          '{"retained":true}',
          userId,
        )
        .run();
      const error =
        failure === "refresh"
          ? new PersonalError(
              "github_refresh_unavailable",
              "GitHub renewal unavailable.",
              503,
            )
          : failure === "unreadable"
            ? new PersonalError(
                "github_connection_required",
                "Stored credential is unavailable.",
                409,
              )
            : new GitHubError(
                failure === "rejected" ? 401 : 403,
                null,
                "/orgs/private-scope/repos",
                null,
                "sensitive-provider-detail",
              );
      // Workflow replay can restore a step failure as a plain Error.
      execute.mockImplementation(
        async (
          _name: string,
          _options: unknown,
          callback: () => Promise<void>,
        ) => {
          try {
            await callback();
          } catch (error) {
            throw new Error(`NonRetryableError: ${String(error)}`, {
              cause: error,
            });
          }
        },
      );
      const callback = vi.fn().mockRejectedValue(error);
      vi.mocked(runCollection).mockImplementation(
        async (_env, _params, steps) => {
          if (failure === "unreadable") throw error;
          await steps.do("discover page", callback);
        },
      );
      const workflow = new ActivityCollection(
        {} as ExecutionContext,
        personalEnv,
      );
      await expect(
        workflow.run(
          {
            ...event,
            payload: {
              ...event.payload,
              revisionId,
              userId,
              progressive: failure !== "forbidden",
            },
          },
          step,
        ),
      ).rejects.toThrow();
      const run = await store.one<{ status: string; error_message: string }>(
        "SELECT status,error_message FROM collection_runs WHERE id='run'",
      );
      expect(run?.status).toBe("failed");
      expect(run?.error_message).toContain(
        failure === "forbidden"
          ? "check repository visibility"
          : failure === "refresh"
            ? "GitHub token renewal is temporarily unavailable"
            : "Reconnect GitHub in settings",
      );
      expect(run?.error_message).not.toMatch(
        /private-scope|sensitive-provider-detail/,
      );
      expect(
        await store.one(
          "SELECT active_run_id,snapshot_json FROM personal_state WHERE id=?",
          userId,
        ),
      ).toEqual({ active_run_id: null, snapshot_json: '{"retained":true}' });
      expect(sleepUntil).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledTimes(failure === "unreadable" ? 0 : 1);
    },
  );

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
