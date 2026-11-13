import {
  isGitHubRepository,
  type PrivateActivityResponse,
  type PrivateRepositorySelection,
} from "@shazhou-work/workforce-contracts";
import type { Bindings } from "./env.js";
import {
  assertPersonalActive,
  database,
  decryptCredential,
  encryptCredential,
  githubConnection,
  PersonalError,
} from "./platform.js";
import { createGitHubClient, GitHubError } from "./github-client.js";
import { readMetadata, type RepositoryMetadata } from "./collection-github.js";
import type { CollectionParams, CollectionSteps } from "./collection.js";
import {
  collectProgressively,
  type RepositoryProgress,
} from "./progressive-collection.js";

interface PrivateState {
  generation: string;
  credential: string;
  repositories_json: string;
  active_run_id: string | null;
  last_refresh_at: string | null;
  snapshot_json: string | null;
  error_message: string | null;
  progress_json: string | null;
  pinned_json: string | null;
}

const accessMessage =
  "私有仓库授权不可用：请检查令牌有效期、Contents 只读权限、组织审批及所选仓库，然后重新连接。已有结果已隐藏。";

function accessError() {
  return new PersonalError(
    "private_authorization_required",
    accessMessage,
    409,
  );
}

async function assertPrivateActive(env: Bindings, userId: string) {
  await assertPersonalActive(env, userId);
  if (
    !(await database(env).one(
      "SELECT id FROM personal_users WHERE id=? AND status='active'",
      userId,
    ))
  )
    throw new PersonalError("access_stopped", "个人资格已停用。", 403);
}

export async function privateState(env: Bindings, userId: string) {
  return database(env).one<PrivateState>(
    "SELECT * FROM personal_private_repositories WHERE user_id=?",
    userId,
  );
}

// Credentials use an authenticated namespace distinct from the OAuth credential.
const credentialOwner = (userId: string) => `private-repositories:v1:${userId}`;

async function authorized(
  env: Bindings,
  userId: string,
  state: PrivateState,
  request: typeof fetch = fetch,
  bound = true,
) {
  const checkBinding = async () => {
    await assertPrivateActive(env, userId);
    if (
      bound &&
      (await privateState(env, userId))?.generation !== state.generation
    )
      throw accessError();
  };
  await checkBinding();
  await assertPrivateActive(env, userId);
  const connection = await githubConnection(env, userId);
  const identity = await database(env).one<{ provider_id: string }>(
    "SELECT provider_id FROM personal_identities WHERE user_id=? AND provider='github'",
    userId,
  );
  const token = await decryptCredential(
    env,
    credentialOwner(userId),
    state.credential,
  );
  const client = createGitHubClient(token, request, true);
  try {
    const viewer = await client.github<{ id: number }>("/user");
    if (
      !connection ||
      String(viewer.id) !== connection.id ||
      String(viewer.id) !== identity?.provider_id
    )
      throw accessError();
    const repositories = JSON.parse(
      state.repositories_json,
    ) as PrivateRepositorySelection[];
    for (const selection of repositories) {
      await checkBinding();
      const repo = await client.github<{
        id: number;
        private: boolean;
        full_name: string;
        visibility?: string;
      }>(`/repos/${selection.name}`);
      if (
        repo.id !== selection.id ||
        !repo.private ||
        repo.visibility === "internal" ||
        repo.full_name.toLowerCase() !== selection.name.toLowerCase()
      )
        throw accessError();
      // Metadata access alone does not demonstrate access to repository contents.
      try {
        await client.github(`/repos/${selection.name}/commits?per_page=1`);
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 409))
          throw error;
      }
      await checkBinding();
    }
    return { client, login: connection.login, repositories };
  } catch (error) {
    if (
      error instanceof GitHubError &&
      (error.retryAt !== null || error.status >= 500)
    )
      throw new PersonalError(
        "private_temporarily_unavailable",
        "GitHub 暂时不可用或请求受限，请稍后重试；近月结果保留。",
        503,
      );
    throw accessError();
  }
}

export async function savePrivateRepositories(
  env: Bindings,
  userId: string,
  input: unknown,
  request: typeof fetch = fetch,
) {
  if (!input || typeof input !== "object")
    throw new PersonalError(
      "private_configuration_invalid",
      "请输入令牌和明确选择的私有仓库。",
      422,
    );
  const value = input as { token?: unknown; repositories?: unknown };
  const previous = await privateState(env, userId);
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (
    (token && !/^github_pat_[A-Za-z0-9_]+$/.test(token)) ||
    (!token && !previous)
  )
    throw new PersonalError(
      "private_token_invalid",
      "仅支持 fine-grained PAT（github_pat_）；不接受 classic PAT 或 OAuth 令牌。",
      422,
    );
  if (
    !Array.isArray(value.repositories) ||
    value.repositories.length < 1 ||
    value.repositories.length > 10 ||
    value.repositories.some((name) => !isGitHubRepository(name))
  )
    throw new PersonalError(
      "private_configuration_invalid",
      "请明确选择 1–10 个 owner/name 格式的私有仓库。",
      422,
    );
  const names = [
    ...new Set(
      (value.repositories as string[]).map((name) => name.toLowerCase()),
    ),
  ];
  const credential = token
    ? await encryptCredential(env, credentialOwner(userId), token)
    : previous!.credential;
  const client = createGitHubClient(
    token ||
      (await decryptCredential(env, credentialOwner(userId), credential)),
    request,
    true,
  );
  const repositories: PrivateRepositorySelection[] = [];
  try {
    for (const name of names) {
      const repo = await client.github<{
        id: number;
        private: boolean;
        visibility?: string;
        full_name: string;
      }>(`/repos/${name}`);
      if (
        !Number.isSafeInteger(repo.id) ||
        !repo.private ||
        repo.visibility === "internal" ||
        repo.full_name.toLowerCase() !== name
      )
        throw accessError();
      repositories.push({ id: repo.id, name });
    }
  } catch {
    throw accessError();
  }
  const state: PrivateState = {
    generation: crypto.randomUUID(),
    credential,
    repositories_json: JSON.stringify(repositories),
    active_run_id: null,
    last_refresh_at: null,
    snapshot_json: null,
    error_message: null,
    progress_json: null,
    pinned_json: null,
  };
  await authorized(env, userId, state, request, false);
  const saved = previous
    ? await database(env).one(
        `UPDATE personal_private_repositories SET generation=?,credential=?,repositories_json=?,
         active_run_id=NULL,last_refresh_at=NULL,snapshot_json=NULL,error_message=NULL,progress_json=NULL,pinned_json=NULL
         WHERE user_id=? AND generation=? RETURNING user_id`,
        state.generation,
        credential,
        state.repositories_json,
        userId,
        previous.generation,
      )
    : await database(env).one(
        `INSERT INTO personal_private_repositories(user_id,generation,credential,repositories_json)
         VALUES (?,?,?,?) ON CONFLICT(user_id) DO NOTHING RETURNING user_id`,
        userId,
        state.generation,
        credential,
        state.repositories_json,
      );
  if (!saved)
    throw new PersonalError(
      "private_configuration_changed",
      "私有授权已在另一窗口修改，请重新读取后保存。",
      409,
    );
}

export async function disconnectPrivateRepositories(
  env: Bindings,
  userId: string,
) {
  await database(env)
    .statement(
      "DELETE FROM personal_private_repositories WHERE user_id=?",
      userId,
    )
    .run();
}

export async function readPrivateActivity(
  env: Bindings,
  userId: string,
  request: typeof fetch = fetch,
): Promise<PrivateActivityResponse> {
  await assertPrivateActive(env, userId);
  let state = await privateState(env, userId);
  if (!state)
    return {
      connected: false,
      repositories: [],
      snapshot: null,
      activeRunId: null,
      nextRefreshAt: null,
      error: null,
    };
  if (state.active_run_id && env.COLLECTION) {
    try {
      const workflow = await env.COLLECTION.get(state.active_run_id);
      if (
        ["complete", "errored", "terminated"].includes(
          (await workflow.status()).status,
        )
      ) {
        await failPrivateCollection(
          env,
          userId,
          state.generation,
          state.active_run_id,
        );
        state = await privateState(env, userId);
        if (!state) throw accessError();
      }
    } catch {
      throw new PersonalError(
        "private_workflow_unavailable",
        "暂时无法确认私有采集任务状态，请重试。",
        503,
      );
    }
  }
  await authorized(env, userId, state, request);
  const fresh = await database(env).one<PrivateState>(
    `SELECT * FROM personal_private_repositories WHERE user_id=? AND generation=?
     AND EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active')`,
    userId,
    state.generation,
    userId,
  );
  if (!fresh) throw accessError();
  state = fresh;
  return {
    connected: true,
    repositories: JSON.parse(
      state.repositories_json,
    ) as PrivateRepositorySelection[],
    snapshot: state.snapshot_json
      ? (JSON.parse(state.snapshot_json) as PrivateActivityResponse["snapshot"])
      : null,
    activeRunId: state.active_run_id,
    nextRefreshAt: state.last_refresh_at
      ? new Date(Date.parse(state.last_refresh_at) + 900_000).toISOString()
      : null,
    error: state.error_message,
  };
}

export async function startPrivateCollection(env: Bindings, userId: string) {
  const state = await privateState(env, userId);
  if (!state) throw accessError();
  await authorized(env, userId, state);
  if (!env.COLLECTION)
    throw new PersonalError("unavailable", "采集服务未配置。", 503);
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const claimed = await database(env).one(
    `UPDATE personal_private_repositories SET active_run_id=?,last_refresh_at=?,error_message=NULL
     WHERE user_id=? AND generation=? AND active_run_id IS NULL
     AND (last_refresh_at IS NULL OR last_refresh_at<=?)
     AND EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active')
     AND (SELECT count(*) FROM personal_private_repositories WHERE active_run_id IS NOT NULL)<4 RETURNING user_id`,
    runId,
    now,
    userId,
    state.generation,
    new Date(Date.now() - 900_000).toISOString(),
    userId,
  );
  if (!claimed)
    throw new PersonalError(
      "refresh_limited",
      "私有采集进行中，或尚未过 15 分钟冷却期。",
      429,
    );
  try {
    await env.COLLECTION.create({
      id: runId,
      params: {
        userId,
        runId,
        revisionId: state.generation,
        privateGeneration: state.generation,
        until: now,
      },
    });
  } catch {
    await failPrivateCollection(env, userId, state.generation, runId);
    throw new PersonalError(
      "unavailable",
      "私有采集未能启动，请稍后重试。",
      503,
    );
  }
  return { runId };
}

export async function failPrivateCollection(
  env: Bindings,
  userId: string,
  generation: string,
  runId: string,
) {
  await database(env)
    .statement(
      "UPDATE personal_private_repositories SET active_run_id=NULL,error_message=? WHERE user_id=? AND generation=? AND active_run_id=?",
      "年度补采未完成；已完成的近月结果保留。检查权限后重试以继续补齐。",
      userId,
      generation,
      runId,
    )
    .run();
}

export async function collectPrivateRepositories(
  env: Bindings,
  params: CollectionParams,
  steps: CollectionSteps,
  request: typeof fetch = fetch,
) {
  const userId = params.userId!;
  const state = await privateState(env, userId);
  if (
    !state ||
    state.generation !== params.privateGeneration ||
    state.active_run_id !== params.runId
  )
    throw accessError();
  const { client, login, repositories } = await authorized(
    env,
    userId,
    state,
    request,
  );
  const assertOwner = async () => {
    await assertPrivateActive(env, userId);
    const current = await privateState(env, userId);
    if (
      !current ||
      current.generation !== state.generation ||
      current.active_run_id !== params.runId
    )
      throw accessError();
  };
  const guard = async () => {
    await assertOwner();
    await authorized(env, userId, state, request);
    const after = await privateState(env, userId);
    if (
      !after ||
      after.generation !== state.generation ||
      after.active_run_id !== params.runId
    )
      throw accessError();
  };
  const progress = JSON.parse(state.progress_json ?? "{}") as Record<
    string,
    RepositoryProgress
  >;
  const pinned = state.pinned_json
    ? (JSON.parse(state.pinned_json) as {
        runId: string;
        metadata: RepositoryMetadata[];
      })
    : null;
  const selected = [];
  for (const [index, selection] of repositories.entries()) {
    await steps.do(`private repository ${index}`, guard);
    await guard();
    const metadata =
      (pinned?.runId === params.runId ? pinned.metadata[index] : null) ??
      (await readMetadata(
        client,
        { repository_id: selection.id, full_name: selection.name },
        true,
      ));
    await guard();
    selected.push({ id: selection.id, metadata, client });
  }
  await guard();
  const pinnedSaved = await database(env).one(
    `UPDATE personal_private_repositories SET pinned_json=? WHERE user_id=? AND generation=? AND active_run_id=?
     AND EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active') RETURNING user_id`,
    JSON.stringify({
      runId: params.runId,
      metadata: selected.map((repo) => repo.metadata),
    }),
    userId,
    state.generation,
    params.runId,
    userId,
  );
  if (!pinnedSaved) throw accessError();
  await collectProgressively({
    runId: params.runId,
    until: params.until,
    repositories: selected,
    steps,
    private: true,
    assertOwner,
    accounts: [
      ...new Set(repositories.map((repo) => repo.name.split("/")[0]!)),
    ],
    authorFilter: { login, emailMatching: false },
    authorize: guard,
    matches: (commit) =>
      commit.author?.user?.login.toLowerCase() === login.toLowerCase(),
    load: async (id) => {
      await assertOwner();
      const current = await privateState(env, userId);
      if (
        !current ||
        current.generation !== state.generation ||
        current.active_run_id !== params.runId
      )
        throw accessError();
      return (
        (
          JSON.parse(current.progress_json ?? "{}") as Record<
            string,
            RepositoryProgress
          >
        )[id] ?? null
      );
    },
    save: async (id, value) => {
      if ((value.received ?? 0) > 50_000)
        throw new PersonalError(
          "private_history_limit",
          "单仓库本次采集超过 50000 次提交；已完成近月保留，请缩小范围后重试。",
          422,
        );
      progress[id] = value;
      const saved = await database(env).one(
        `UPDATE personal_private_repositories SET progress_json=?
         WHERE user_id=? AND generation=? AND active_run_id=?
         AND EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active') RETURNING user_id`,
        JSON.stringify(progress),
        userId,
        state.generation,
        params.runId,
        userId,
      );
      if (!saved) throw accessError();
    },
    publish: async (snapshot, complete) => {
      await guard();
      const published = await database(env).one(
        `UPDATE personal_private_repositories SET snapshot_json=?,error_message=NULL
         WHERE user_id=? AND generation=? AND active_run_id=?
         AND EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active') RETURNING user_id`,
        JSON.stringify({ ...snapshot, visibility: "private" }),
        userId,
        state.generation,
        params.runId,
        userId,
      );
      if (!published) throw accessError();
      if (complete)
        await database(env)
          .statement(
            "UPDATE personal_private_repositories SET active_run_id=NULL WHERE user_id=? AND generation=? AND active_run_id=?",
            userId,
            state.generation,
            params.runId,
          )
          .run();
    },
  });
}
