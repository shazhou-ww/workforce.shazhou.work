import {
  activityTotals,
  activityWindow,
  activityAnchors,
  combineDaily,
  type ActivitySnapshot,
  type DailyActivity,
  type RepositoryActivity,
  type RollingActivity,
  collectionPhases,
  personalRepositoryLimit,
  type CollectionPhase,
  type CollectionPerformance,
} from "@shazhou-work/workforce-contracts";
import type { CollectionConfig } from "./collection-config.js";
import type {
  Comparison,
  GitHubAccount,
  GitHubRepository,
  RawCommit,
  RepositoryMetadata,
} from "./collection-github.js";

export interface CollectionRun {
  id: string;
  revision_id: string;
  status:
    | "queued"
    | "collecting"
    | "ready"
    | "published"
    | "failed"
    | "blocked"
    | "cancelled";
  since_at: string;
  until_at: string;
}

export interface RunRepository {
  run_id: string;
  repository_id: number;
  full_name: string;
  status: "pending" | "collecting" | "complete";
  metadata_json: string | null;
  default_branch: string | null;
  head_sha: string | null;
  history_id: string | null;
  sync_mode: "full" | "incremental" | "reuse" | null;
  base_sha: string | null;
  history_cursor: string | null;
  compare_page: number;
  expected_commits: number | null;
  received_commits: number;
}

export interface SyncState {
  head_sha: string | null;
  default_branch: string | null;
  history_id: string;
}

export interface ReuseCandidate extends RunRepository {
  cached_metadata: string;
  previous_head: string | null;
  previous_branch: string | null;
  previous_history: string;
}

export const repositoryBatchSize = 10;

export interface CollectionAttempt {
  readonly id: string;
  readonly step: string;
  readonly phase: CollectionPhase;
  readonly finishedAt: string;
  readonly activeMs: number;
  readonly rest: number;
  readonly graphql: number;
  readonly httpErrors: number;
  readonly networkErrors: number;
}

export class CollectionStore {
  private readonly db: D1DatabaseSession;

  constructor(
    db: D1Database,
    readonly scopeId: string = "default",
  ) {
    if (scopeId !== "default" && !/^[a-f\d-]{36}$/i.test(scopeId))
      throw new Error("Invalid personal collection scope.");
    this.db = db.withSession("first-primary");
  }

  statement(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...values);
  }

  private get stateTable(): "collection_state" | "personal_state" {
    return this.scopeId === "default" ? "collection_state" : "personal_state";
  }

  private get stateId(): string | number {
    return this.scopeId === "default" ? 1 : this.scopeId;
  }

  async one<T>(
    sql: string,
    ...values: (string | number | null)[]
  ): Promise<T | null> {
    return this.statement(sql, ...values).first<T>();
  }

  async rows<T>(
    sql: string,
    ...values: (string | number | null)[]
  ): Promise<T[]> {
    return (await this.statement(sql, ...values).all<T>()).results;
  }

  async batch(statements: D1PreparedStatement[]): Promise<void> {
    await this.db.batch(statements);
  }

  async recordAttempt(
    runId: string,
    attempt: CollectionAttempt,
  ): Promise<void> {
    // Failures before a run is created have no parent record to attach metrics to.
    await this.statement(
      "INSERT OR IGNORE INTO collection_attempts SELECT ?,id,?,?,?,?,?,?,?,? FROM collection_runs WHERE id=?",
      attempt.id,
      attempt.step,
      attempt.phase,
      attempt.finishedAt,
      attempt.activeMs,
      attempt.rest,
      attempt.graphql,
      attempt.httpErrors,
      attempt.networkErrors,
      runId,
    ).run();
  }

  async startWait(runId: string, name: string): Promise<void> {
    await this.statement(
      "INSERT OR IGNORE INTO collection_waits(run_id,name,started_at) VALUES (?,?,?)",
      runId,
      name,
      new Date().toISOString(),
    ).run();
  }

  async finishWait(runId: string, name: string): Promise<void> {
    await this.statement(
      "UPDATE collection_waits SET finished_at=COALESCE(finished_at,?) WHERE run_id=? AND name=?",
      new Date().toISOString(),
      runId,
      name,
    ).run();
  }

  async performance(
    runId: string,
    terminal: boolean,
    now = Date.now(),
  ): Promise<CollectionPerformance | null> {
    const run = await this.one<{
      started_at: string;
      published_at: string | null;
    }>("SELECT started_at,published_at FROM collection_runs WHERE id=?", runId);
    if (!run)
      throw new Error("Cannot read performance for a missing collection.");
    const totals = await this.one<{
      attempts: number;
      activeMs: number | null;
      rest: number | null;
      graphql: number | null;
      httpErrors: number | null;
      networkErrors: number | null;
      retries: number;
      updatedAt: string | null;
    }>(
      "SELECT count(*) AS attempts,sum(active_ms) AS activeMs,sum(rest_requests) AS rest,sum(graphql_requests) AS graphql,sum(http_errors) AS httpErrors,sum(network_errors) AS networkErrors,count(*)-count(DISTINCT step_name) AS retries,max(finished_at) AS updatedAt FROM collection_attempts WHERE run_id=?",
      runId,
    );
    if (!totals)
      throw new Error("Collection performance query returned no result.");
    if (totals.attempts === 0) return null;
    const waits = await this.rows<{
      started_at: string;
      finished_at: string | null;
    }>(
      "SELECT started_at,finished_at FROM collection_waits WHERE run_id=?",
      runId,
    );
    const phases = await this.rows<{
      phase: CollectionPhase;
      attempts: number;
      activeMs: number;
    }>(
      "SELECT phase,count(*) AS attempts,sum(active_ms) AS activeMs FROM collection_attempts WHERE run_id=? GROUP BY phase",
      runId,
    );
    const updatedAt =
      [
        totals.updatedAt ?? run.started_at,
        run.published_at ?? "",
        ...waits.map((wait) => wait.finished_at ?? wait.started_at),
      ]
        .sort()
        .at(-1) ?? run.started_at;
    const end = terminal ? Date.parse(updatedAt) : now;
    return {
      startedAt: run.started_at,
      updatedAt,
      elapsedMs: Math.max(0, end - Date.parse(run.started_at)),
      activeMs: totals.activeMs ?? 0,
      restRequests: totals.rest ?? 0,
      graphqlRequests: totals.graphql ?? 0,
      httpErrors: totals.httpErrors ?? 0,
      networkErrors: totals.networkErrors ?? 0,
      stepRetries: totals.retries,
      rateLimitWaits: waits.length,
      rateLimitWaitMs: waits.reduce(
        (sum, wait) =>
          sum +
          Math.max(
            0,
            Math.min(
              end,
              wait.finished_at ? Date.parse(wait.finished_at) : end,
            ) - Date.parse(wait.started_at),
          ),
        0,
      ),
      phases: collectionPhases.flatMap((phase) =>
        phases.filter((timing) => timing.phase === phase),
      ),
    };
  }

  async saveConfig(config: CollectionConfig): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.batch([
      this.statement(
        "INSERT INTO config_revisions(id,config_id,repository_mode,created_at,enabled) VALUES (?,?,?,?,?)",
        id,
        this.scopeId,
        config.repositoryMode,
        now,
        Number(config.enabled),
      ),
      this.statement(
        "INSERT INTO config_accounts SELECT ?,value FROM json_each(?)",
        id,
        JSON.stringify(config.accounts),
      ),
      this.statement(
        "INSERT INTO config_identities SELECT ?,'github_login',value FROM json_each(?)",
        id,
        JSON.stringify(config.authorLogins),
      ),
      this.statement(
        "INSERT INTO config_identities SELECT ?,'email',value FROM json_each(?)",
        id,
        JSON.stringify(config.authorEmails),
      ),
      this.statement(
        "INSERT INTO config_repository_rules SELECT ?,value,'include' FROM json_each(?)",
        id,
        JSON.stringify(config.includeRepositories),
      ),
      this.statement(
        "INSERT INTO config_repository_rules SELECT ?,value,'exclude' FROM json_each(?)",
        id,
        JSON.stringify(config.excludeRepositories),
      ),
      this.statement(
        "UPDATE collection_configs SET active_revision_id=?,enabled=? WHERE id=?",
        id,
        Number(config.enabled),
        this.scopeId,
      ),
    ]);
    return id;
  }

  async activeConfig(): Promise<{
    revisionId: string | null;
    enabled: number;
  }> {
    const result = await this.one<{
      revisionId: string | null;
      enabled: number;
    }>(
      "SELECT active_revision_id AS revisionId,enabled FROM collection_configs WHERE id=?",
      this.scopeId,
    );
    if (!result)
      throw new Error("Apply the collection D1 migrations before use.");
    return result;
  }

  async config(revisionId: string): Promise<CollectionConfig> {
    const revision = await this.one<{
      repository_mode: CollectionConfig["repositoryMode"];
      enabled: number;
    }>(
      "SELECT repository_mode,enabled FROM config_revisions WHERE id=? AND config_id=?",
      revisionId,
      this.scopeId,
    );
    if (!revision)
      throw new Error("Collection configuration revision does not exist.");
    const identities = await this.rows<{
      identity_type: string;
      normalized_value: string;
    }>(
      "SELECT * FROM config_identities WHERE revision_id=? ORDER BY normalized_value",
      revisionId,
    );
    const accounts = await this.rows<{ login: string }>(
      "SELECT login FROM config_accounts WHERE revision_id=? ORDER BY login",
      revisionId,
    );
    const rules = await this.rows<{ full_name: string; action: string }>(
      "SELECT * FROM config_repository_rules WHERE revision_id=? ORDER BY full_name",
      revisionId,
    );
    return {
      enabled: revision.enabled === 1,
      repositoryMode: revision.repository_mode,
      accounts: accounts.map((row) => row.login),
      authorLogins: identities
        .filter((row) => row.identity_type === "github_login")
        .map((row) => row.normalized_value),
      authorEmails: identities
        .filter((row) => row.identity_type === "email")
        .map((row) => row.normalized_value),
      includeRepositories: rules
        .filter((row) => row.action === "include")
        .map((row) => row.full_name),
      excludeRepositories: rules
        .filter((row) => row.action === "exclude")
        .map((row) => row.full_name),
    };
  }

  async begin(
    runId: string,
    revisionId: string,
    until: string,
    keyId: string,
  ): Promise<boolean> {
    const existing = await this.one<CollectionRun>(
      "SELECT r.* FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id=?",
      runId,
      this.scopeId,
    );
    if (
      existing &&
      ["published", "blocked", "cancelled"].includes(existing.status)
    )
      return false;
    const window = activityWindow(new Date(until));
    const state = await this.one<{ email_key_id: string | null }>(
      `SELECT email_key_id FROM ${this.stateTable} WHERE id=?`,
      this.stateId,
    );
    if (!state) throw new Error("Collection state is uninitialized.");
    if (state.email_key_id !== null && state.email_key_id !== keyId) {
      throw new Error(
        "COLLECTION_EMAIL_KEY changed; rebuild the database before rotating this key.",
      );
    }
    await this.batch([
      this.statement(
        "INSERT OR IGNORE INTO collection_runs(id,revision_id,status,since_at,until_at,started_at) SELECT ?,?,'queued',?,?,? FROM config_revisions WHERE id=? AND config_id=?",
        runId,
        revisionId,
        window.since,
        window.until,
        new Date().toISOString(),
        revisionId,
        this.scopeId,
      ),
      this.statement(
        `UPDATE ${this.stateTable} SET active_run_id=?,email_key_id=? WHERE id=? AND (active_run_id IS NULL OR active_run_id=?) AND ? >= COALESCE(publication_until,'')
         AND EXISTS(SELECT 1 FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id=? AND r.status NOT IN ('published','blocked','cancelled'))`,
        runId,
        keyId,
        this.stateId,
        runId,
        window.until,
        runId,
        this.scopeId,
      ),
      this.statement(
        `UPDATE collection_runs SET status=CASE WHEN (SELECT active_run_id FROM ${this.stateTable} WHERE id=?)=id THEN 'collecting' ELSE 'blocked' END,error_message=NULL WHERE id=? AND status IN ('queued','failed') AND revision_id IN (SELECT id FROM config_revisions WHERE config_id=?)`,
        this.stateId,
        runId,
        this.scopeId,
      ),
    ]);
    return await this.ownsRun(runId);
  }

  async enqueue(
    runId: string,
    revisionId: string,
    until: string,
  ): Promise<void> {
    const window = activityWindow(new Date(until));
    await this.statement(
      "INSERT OR IGNORE INTO collection_runs(id,revision_id,status,since_at,until_at,started_at) SELECT ?,?,'queued',?,?,? FROM config_revisions WHERE id=? AND config_id=?",
      runId,
      revisionId,
      window.since,
      window.until,
      new Date().toISOString(),
      revisionId,
      this.scopeId,
    ).run();
  }

  async ownsRun(runId: string): Promise<boolean> {
    const state = await this.one<{ active_run_id: string | null }>(
      `SELECT active_run_id FROM ${this.stateTable} WHERE id=?`,
      this.stateId,
    );
    return state?.active_run_id === runId;
  }

  async run(id: string): Promise<CollectionRun> {
    const row = await this.one<CollectionRun>(
      "SELECT r.* FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id WHERE r.id=? AND c.config_id=?",
      id,
      this.scopeId,
    );
    if (!row) throw new Error("Collection run does not exist.");
    return row;
  }

  accountStatement(account: GitHubAccount) {
    return this.statement(
      "INSERT INTO accounts VALUES (?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,account_type=excluded.account_type,updated_at=excluded.updated_at",
      account.id,
      account.login,
      account.type,
      new Date().toISOString(),
    );
  }

  async discover(
    runId: string,
    account: GitHubAccount | null,
    repositories: readonly GitHubRepository[],
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    if (account) {
      statements.push(
        this.accountStatement(account),
        this.statement(
          "INSERT OR IGNORE INTO run_accounts VALUES (?,?)",
          runId,
          account.id,
        ),
      );
    }
    const publicRepositories = repositories.filter(
      (repository) => !repository.private,
    );
    if (publicRepositories.length > 0) {
      statements.push(
        this.statement(
          `INSERT INTO accounts SELECT json_extract(value,'$.owner.id'),json_extract(value,'$.owner.login'),json_extract(value,'$.owner.type'),?
          FROM json_each(?) WHERE 1 ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,account_type=excluded.account_type,updated_at=excluded.updated_at`,
          new Date().toISOString(),
          JSON.stringify(publicRepositories),
        ),
        this.statement(
          `INSERT INTO repositories SELECT json_extract(value,'$.id'),json_extract(value,'$.owner.id'),json_extract(value,'$.full_name'),?
          FROM json_each(?) WHERE 1 ON CONFLICT(github_id) DO UPDATE SET owner_id=excluded.owner_id,full_name=excluded.full_name,updated_at=excluded.updated_at`,
          new Date().toISOString(),
          JSON.stringify(publicRepositories),
        ),
        this.statement(
          "INSERT OR IGNORE INTO run_repositories(run_id,repository_id,full_name) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.full_name') FROM json_each(?)",
          runId,
          JSON.stringify(publicRepositories),
        ),
      );
    }
    if (statements.length > 0) await this.batch(statements);
    if (this.scopeId !== "default") {
      const count = await this.one<{ count: number }>(
        "SELECT count(*) AS count FROM run_repositories WHERE run_id=?",
        runId,
      );
      if ((count?.count ?? 0) > personalRepositoryLimit)
        throw new Error(
          `Expanded repository scope exceeds the ${personalRepositoryLimit} repository limit. Narrow the scope; previous results are retained.`,
        );
    }
  }

  repositories(runId: string) {
    return this.rows<RunRepository>(
      "SELECT * FROM run_repositories WHERE run_id=? ORDER BY repository_id",
      runId,
    );
  }

  pendingMetadata(runId: string, repositoryIds: readonly number[]) {
    return this.rows<RunRepository>(
      "SELECT r.* FROM run_repositories r WHERE run_id=? AND status='pending' AND repository_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM discovery_pages d WHERE d.run_id=r.run_id AND d.scope='metadata:' || r.repository_id AND d.page=0) ORDER BY repository_id",
      runId,
      JSON.stringify(repositoryIds),
    );
  }

  async saveMetadata(
    repositories: readonly RunRepository[],
    metadata: readonly RepositoryMetadata[],
  ): Promise<void> {
    if (repositories.length !== metadata.length) {
      throw new Error("Metadata checkpoint does not cover every repository.");
    }
    await this.batch(
      repositories.map((repository, index) =>
        this.statement(
          "INSERT OR IGNORE INTO discovery_pages(run_id,scope,page,item_count,payload_json) VALUES (?,?,0,1,?)",
          repository.run_id,
          `metadata:${repository.repository_id}`,
          JSON.stringify(metadata[index]),
        ),
      ),
    );
  }

  async metadata(runId: string, repositoryId: number) {
    const row = await this.one<{ payload_json: string }>(
      "SELECT payload_json FROM discovery_pages WHERE run_id=? AND scope=? AND page=0",
      runId,
      `metadata:${repositoryId}`,
    );
    return row ? (JSON.parse(row.payload_json) as RepositoryMetadata) : null;
  }

  async repository(
    runId: string,
    repositoryId: number,
  ): Promise<RunRepository> {
    const row = await this.one<RunRepository>(
      "SELECT * FROM run_repositories WHERE run_id=? AND repository_id=?",
      runId,
      repositoryId,
    );
    if (!row) throw new Error("Repository is outside this collection run.");
    return row;
  }

  syncState(repositoryId: number) {
    if (this.scopeId !== "default")
      return this.one<SyncState>(
        "SELECT * FROM personal_repository_sync_state WHERE scope_id=? AND repository_id=?",
        this.scopeId,
        repositoryId,
      );
    return this.one<SyncState>(
      "SELECT * FROM repository_sync_state WHERE repository_id=?",
      repositoryId,
    );
  }

  async plan(
    repo: RunRepository,
    metadata: RepositoryMetadata,
    mode: "full" | "incremental" | "reuse",
    state: SyncState | null,
    comparison: Comparison | null = null,
  ): Promise<void> {
    await this.batch(
      this.planStatements(repo, metadata, mode, state, comparison),
    );
  }

  private planStatements(
    repo: RunRepository,
    metadata: RepositoryMetadata,
    mode: "full" | "incremental" | "reuse",
    state: SyncState | null,
    comparison: Comparison | null = null,
  ): D1PreparedStatement[] {
    const historyId =
      mode === "full"
        ? `${repo.run_id}:${repo.repository_id}`
        : state?.history_id;
    if (!historyId)
      throw new Error("Missing complete history for incremental collection.");
    const statements = [
      this.statement(
        "INSERT OR IGNORE INTO repository_histories VALUES (?,?,?)",
        historyId,
        repo.repository_id,
        new Date().toISOString(),
      ),
      this.statement(
        "UPDATE run_repositories SET status='collecting',metadata_json=?,default_branch=?,head_sha=?,history_id=?,sync_mode=?,base_sha=?,history_cursor=NULL,compare_page=1,expected_commits=NULL,received_commits=0 WHERE run_id=? AND repository_id=?",
        JSON.stringify(metadata),
        metadata.defaultBranch,
        metadata.head,
        historyId,
        mode,
        state?.head_sha ?? null,
        repo.run_id,
        repo.repository_id,
      ),
    ];
    if (mode === "incremental" && comparison) {
      statements.push(
        this.statement(
          "INSERT OR REPLACE INTO discovery_pages(run_id,scope,page,item_count,payload_json) VALUES (?,?,1,?,?)",
          repo.run_id,
          `comparison:${repo.repository_id}`,
          comparison.commits.length,
          JSON.stringify(comparison),
        ),
      );
    }
    return statements;
  }

  async planReuseBatch(runId: string, repositoryIds: readonly number[]) {
    if (repositoryIds.length > repositoryBatchSize)
      throw new Error("Repository batch exceeds its bounded budget.");
    const candidates = await this.rows<ReuseCandidate>(
      `SELECT r.*,d.payload_json AS cached_metadata,
       s.head_sha AS previous_head,s.default_branch AS previous_branch,s.history_id AS previous_history
       FROM run_repositories r
       JOIN discovery_pages d ON d.run_id=r.run_id AND d.scope='metadata:' || r.repository_id AND d.page=0
       JOIN ${this.scopeId === "default" ? "repository_sync_state" : "personal_repository_sync_state"} s
         ON s.repository_id=r.repository_id ${this.scopeId === "default" ? "" : "AND s.scope_id=?"}
       WHERE r.run_id=? AND r.status='pending' AND r.repository_id IN (SELECT value FROM json_each(?))
       ORDER BY r.repository_id`,
      ...(this.scopeId === "default" ? [] : [this.scopeId]),
      runId,
      JSON.stringify(repositoryIds),
    );
    const statements: D1PreparedStatement[] = [];
    for (const repo of candidates) {
      const metadata = JSON.parse(repo.cached_metadata) as RepositoryMetadata;
      if (
        repo.previous_branch === metadata.defaultBranch &&
        repo.previous_head === metadata.head
      )
        statements.push(
          ...this.planStatements(repo, metadata, "reuse", {
            head_sha: repo.previous_head,
            default_branch: repo.previous_branch,
            history_id: repo.previous_history,
          }),
        );
    }
    if (statements.length) await this.batch(statements);
  }

  async initializeReusePlan(runId: string): Promise<void> {
    if (await this.reusePlan(runId)) return;
    const ids = await this.reusableRepositoryIds(runId);
    await this.statement(
      "INSERT OR IGNORE INTO discovery_pages(run_id,scope,page,item_count,payload_json) VALUES (?,'reuse-plan:v1',0,?,?)",
      runId,
      ids.length,
      JSON.stringify(ids),
    ).run();
  }

  async reusePlan(runId: string): Promise<number[] | null> {
    const row = await this.one<{ payload_json: string }>(
      "SELECT payload_json FROM discovery_pages WHERE run_id=? AND scope='reuse-plan:v1' AND page=0",
      runId,
    );
    if (!row) return null;
    const ids: unknown = JSON.parse(row.payload_json);
    if (
      !Array.isArray(ids) ||
      (this.scopeId !== "default" && ids.length > personalRepositoryLimit) ||
      !ids.every((id): id is number => Number.isSafeInteger(id) && id > 0) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid reusable repository manifest.");
    return ids;
  }

  private async reusableRepositoryIds(runId: string): Promise<number[]> {
    const candidates = await this.rows<ReuseCandidate>(
      `SELECT r.*,d.payload_json AS cached_metadata,
       s.head_sha AS previous_head,s.default_branch AS previous_branch,s.history_id AS previous_history
       FROM run_repositories r
       JOIN discovery_pages d ON d.run_id=r.run_id AND d.scope='metadata:' || r.repository_id AND d.page=0
       JOIN ${this.scopeId === "default" ? "repository_sync_state" : "personal_repository_sync_state"} s
         ON s.repository_id=r.repository_id ${this.scopeId === "default" ? "" : "AND s.scope_id=?"}
       WHERE r.run_id=? ORDER BY r.repository_id`,
      ...(this.scopeId === "default" ? [] : [this.scopeId]),
      runId,
    );
    return candidates
      .filter((repo) => {
        if (repo.sync_mode === "reuse") return true;
        if (repo.status !== "pending") return false;
        const metadata = JSON.parse(repo.cached_metadata) as RepositoryMetadata;
        return (
          repo.previous_branch === metadata.defaultBranch &&
          repo.previous_head === metadata.head
        );
      })
      .map((repo) => repo.repository_id);
  }

  async finishReuseBatch(
    run: CollectionRun,
    repositoryIds: readonly number[],
    emails: readonly string[],
  ): Promise<void> {
    if (repositoryIds.length > repositoryBatchSize)
      throw new Error("Repository batch exceeds its bounded budget.");
    const repositories = await this.rows<RunRepository>(
      `SELECT * FROM run_repositories WHERE run_id=? AND sync_mode='reuse'
       AND status='collecting' AND repository_id IN (SELECT value FROM json_each(?)) ORDER BY repository_id`,
      run.id,
      JSON.stringify(repositoryIds),
    );
    if (repositories.length)
      await this.batch(
        repositories.flatMap((repo) =>
          this.finishStatements(repo, run, emails),
        ),
      );
  }

  async missingCommits(
    repositoryId: number,
    shas: readonly string[],
  ): Promise<string[]> {
    if (shas.length === 0) return [];
    const existing = await this.rows<{ sha: string }>(
      "SELECT sha FROM commits WHERE repository_id=? AND sha IN (SELECT value FROM json_each(?))",
      repositoryId,
      JSON.stringify(shas),
    );
    const seen = new Set(existing.map((row) => row.sha));
    return shas.filter((sha) => !seen.has(sha));
  }

  async savePage(
    repo: RunRepository,
    commits: readonly RawCommit[],
    shas: readonly string[],
    hashEmail: (email: string) => Promise<string>,
    next: {
      cursor: string | null;
      comparePage: number;
      expected: number | null;
      received: number;
    },
  ): Promise<void> {
    if (!repo.history_id) throw new Error("History was not initialized.");
    if (this.scopeId !== "default") {
      const used = await this.one<{ count: number }>(
        "SELECT COALESCE(sum(received_commits),0) AS count FROM run_repositories WHERE run_id=?",
        repo.run_id,
      );
      if ((used?.count ?? 0) - repo.received_commits + next.received > 50_000)
        throw new Error(
          "History budget exceeded (50000 commits per run). Narrow the repository scope; previous results are retained.",
        );
    }
    const rows: {
      sha: string;
      committedAt: string;
      authorLogin: string | null;
      authorEmailHmac: string | null;
      additions: number;
      deletions: number;
    }[] = [];
    for (const commit of commits) {
      if (
        !/^[a-f\d]{40}$/i.test(commit.oid) ||
        !Number.isFinite(Date.parse(commit.committedDate)) ||
        !Number.isSafeInteger(commit.additions) ||
        commit.additions < 0 ||
        !Number.isSafeInteger(commit.deletions) ||
        commit.deletions < 0
      ) {
        throw new Error("GitHub returned invalid commit activity.");
      }
      rows.push({
        sha: commit.oid,
        committedAt: new Date(commit.committedDate).toISOString(),
        authorLogin: commit.author?.user?.login.toLowerCase() ?? null,
        authorEmailHmac: commit.author
          ? await hashEmail(commit.author.email)
          : null,
        additions: commit.additions,
        deletions: commit.deletions,
      });
    }
    await this.batch([
      this.statement(
        `INSERT INTO commits SELECT ?,json_extract(value,'$.sha'),json_extract(value,'$.committedAt'),
        json_extract(value,'$.authorLogin'),json_extract(value,'$.authorEmailHmac'),
        json_extract(value,'$.additions'),json_extract(value,'$.deletions'),?
        FROM json_each(?) WHERE 1 ON CONFLICT(repository_id,sha) DO UPDATE SET author_login=excluded.author_login,author_email_hmac=excluded.author_email_hmac`,
        repo.repository_id,
        new Date().toISOString(),
        JSON.stringify(rows),
      ),
      this.statement(
        "INSERT OR IGNORE INTO pending_history_commits SELECT ?,?,value FROM json_each(?)",
        repo.run_id,
        repo.repository_id,
        JSON.stringify([...new Set(shas)]),
      ),
      this.statement(
        "UPDATE run_repositories SET history_cursor=?,compare_page=?,expected_commits=?,received_commits=? WHERE run_id=? AND repository_id=?",
        next.cursor,
        next.comparePage,
        next.expected,
        next.received,
        repo.run_id,
        repo.repository_id,
      ),
    ]);
  }

  async finishRepository(
    repo: RunRepository,
    config: CollectionConfig,
    hashEmail: (email: string) => Promise<string>,
  ): Promise<void> {
    if (!repo.history_id) throw new Error("History was not initialized.");
    const run = await this.run(repo.run_id);
    const emails = await Promise.all(config.authorEmails.map(hashEmail));
    await this.batch(this.finishStatements(repo, run, emails));
  }

  private finishStatements(
    repo: RunRepository,
    run: CollectionRun,
    emails: readonly string[],
  ): D1PreparedStatement[] {
    if (!repo.history_id) throw new Error("History was not initialized.");
    if (repo.run_id !== run.id)
      throw new Error("Repository is outside this collection run.");
    const statements = [
      this.statement(
        "INSERT OR IGNORE INTO history_commits SELECT ?,repository_id,sha FROM pending_history_commits WHERE run_id=? AND repository_id=?",
        repo.history_id,
        repo.run_id,
        repo.repository_id,
      ),
      this.statement(
        "DELETE FROM run_commits WHERE run_id=? AND repository_id=?",
        repo.run_id,
        repo.repository_id,
      ),
      this.statement(
        `INSERT INTO run_commits SELECT ?,c.repository_id,c.sha,
          CASE WHEN c.author_login IN (SELECT normalized_value FROM config_identities WHERE revision_id=? AND identity_type='github_login')
            OR c.author_email_hmac IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END
         FROM history_commits h JOIN commits c ON c.repository_id=h.repository_id AND c.sha=h.sha
         WHERE h.history_id=? AND c.repository_id=? AND c.committed_at>=? AND c.committed_at<=?`,
        repo.run_id,
        run.revision_id,
        JSON.stringify(emails),
        repo.history_id,
        repo.repository_id,
        new Date(Date.parse(run.since_at) - 86_400_000).toISOString(),
        run.until_at,
      ),
      this.statement(
        "DELETE FROM daily_activity WHERE run_id=? AND repository_id=?",
        repo.run_id,
        repo.repository_id,
      ),
      this.statement(
        `INSERT INTO daily_activity
         SELECT r.run_id,r.repository_id,date(c.committed_at,'+8 hours'),count(*),sum(c.additions),sum(c.deletions)
         FROM run_commits r JOIN commits c ON c.repository_id=r.repository_id AND c.sha=r.sha
         WHERE r.run_id=? AND r.repository_id=? AND r.author_matched=1 AND c.committed_at>=?
         GROUP BY date(c.committed_at,'+8 hours')`,
        repo.run_id,
        repo.repository_id,
        run.since_at,
      ),
      this.statement(
        this.scopeId === "default"
          ? "INSERT INTO repository_sync_state VALUES (?,?,?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET default_branch=excluded.default_branch,head_sha=excluded.head_sha,history_id=excluded.history_id,last_successful_run_id=excluded.last_successful_run_id,updated_at=excluded.updated_at"
          : "INSERT INTO personal_repository_sync_state VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_id,repository_id) DO UPDATE SET default_branch=excluded.default_branch,head_sha=excluded.head_sha,history_id=excluded.history_id,last_successful_run_id=excluded.last_successful_run_id,updated_at=excluded.updated_at",
        ...(this.scopeId === "default" ? [] : [this.scopeId]),
        repo.repository_id,
        repo.default_branch,
        repo.head_sha,
        repo.history_id,
        repo.run_id,
        new Date().toISOString(),
      ),
      this.statement(
        "UPDATE run_repositories SET status='complete',completed_at=? WHERE run_id=? AND repository_id=?",
        new Date().toISOString(),
        repo.run_id,
        repo.repository_id,
      ),
      this.statement(
        "DELETE FROM pending_history_commits WHERE run_id=? AND repository_id=?",
        repo.run_id,
        repo.repository_id,
      ),
    ];
    return statements;
  }

  async snapshot(
    runId: string,
    hashEmail: (email: string) => Promise<string>,
  ): Promise<ActivitySnapshot> {
    const run = await this.run(runId);
    const config = await this.config(run.revision_id);
    const window = activityWindow(new Date(run.until_at));
    const repositories: RepositoryActivity[] = [];
    const dailyRows = await this.rows<{
      repository_id: number;
      date: string;
      commit_count: number;
      additions: number;
      deletions: number;
    }>("SELECT * FROM daily_activity WHERE run_id=?", runId);
    for (const repo of await this.repositories(runId)) {
      if (repo.status !== "complete" || !repo.metadata_json) {
        throw new Error("Cannot publish an incomplete collection.");
      }
      const metadata = JSON.parse(repo.metadata_json) as RepositoryMetadata;
      const rows = dailyRows.filter(
        (row) => row.repository_id === repo.repository_id,
      );
      const byDate = new Map(rows.map((row) => [row.date, row]));
      const daily: DailyActivity[] = window.dates.map((date) => {
        const row = byDate.get(date);
        return {
          date,
          ...activityTotals([
            {
              commits: row?.commit_count ?? 0,
              additions: row?.additions ?? 0,
              deletions: row?.deletions ?? 0,
            },
          ]),
        };
      });
      repositories.push({
        name: metadata.name,
        url: metadata.url,
        description: metadata.description,
        fork: metadata.fork,
        archived: metadata.archived,
        defaultBranch: metadata.defaultBranch,
        latestCommit: metadata.latestCommit,
        daily,
        ...activityTotals(daily),
      });
    }
    repositories.sort(
      (left, right) =>
        (right.latestCommit?.committedAt ?? "").localeCompare(
          left.latestCommit?.committedAt ?? "",
        ) || left.name.localeCompare(right.name),
    );
    const daily = combineDaily(repositories, window.dates);
    const yearlyWindow = activityWindow(new Date(run.until_at), 365);
    const emails = await Promise.all(config.authorEmails.map(hashEmail));
    const yearlyRows = await this.rows<{ date: string; commits: number }>(
      `SELECT date(c.committed_at,'+8 hours') AS date,count(*) AS commits
       FROM run_repositories r
       JOIN commits c ON c.repository_id=r.repository_id
       JOIN history_commits h ON h.history_id=r.history_id AND h.repository_id=c.repository_id AND h.sha=c.sha
       WHERE r.run_id=? AND c.committed_at>=? AND c.committed_at<=?
         AND (c.author_login IN (SELECT normalized_value FROM config_identities WHERE revision_id=? AND identity_type='github_login')
           OR c.author_email_hmac IN (SELECT value FROM json_each(?)))
       GROUP BY date(c.committed_at,'+8 hours')`,
      runId,
      yearlyWindow.since,
      yearlyWindow.until,
      run.revision_id,
      JSON.stringify(emails),
    );
    const yearlyCounts = new Map(
      yearlyRows.map((row) => [row.date, row.commits]),
    );
    const rollingRows = await this.rows<{
      at: string;
      commits: number;
      additions: number;
      deletions: number;
    }>(
      `WITH matched AS (
        SELECT c.sha,c.committed_at,c.additions,c.deletions
        FROM run_commits r JOIN commits c ON c.repository_id=r.repository_id AND c.sha=r.sha
        WHERE r.run_id=? AND r.author_matched=1
      )
      SELECT a.value AS at,count(c.sha) AS commits,
        COALESCE(sum(c.additions),0) AS additions,COALESCE(sum(c.deletions),0) AS deletions
      FROM json_each(?) a LEFT JOIN matched c
        ON c.committed_at>strftime('%Y-%m-%dT%H:%M:%fZ',a.value,'-24 hours')
        AND c.committed_at<=a.value
      GROUP BY a.value ORDER BY a.value`,
      runId,
      JSON.stringify(activityAnchors(window)),
    );
    const rolling: RollingActivity[] = rollingRows.map((row) => ({
      at: row.at,
      ...activityTotals([row]),
    }));
    return {
      version: 1,
      accounts: config.accounts,
      authorFilter: {
        login: config.authorLogins.join(" / ") || "已配置邮箱",
        emailMatching: config.authorEmails.length > 0,
      },
      generatedAt: new Date().toISOString(),
      since: window.since,
      until: window.until,
      timezone: "Asia/Shanghai",
      days: 30,
      daily,
      rolling,
      repositories,
      totals: activityTotals(daily),
      yearly: yearlyWindow.dates.map((date) => ({
        date,
        commits: yearlyCounts.get(date) ?? 0,
      })),
    };
  }

  async ready(runId: string): Promise<void> {
    if (!(await this.ownsRun(runId)))
      throw new Error("Collection no longer owns the publication lock.");
    await this.batch([
      this.statement(
        "UPDATE collection_runs SET status='ready',completed_at=? WHERE id=? AND status!='cancelled' AND revision_id IN (SELECT id FROM config_revisions WHERE config_id=?)",
        new Date().toISOString(),
        runId,
        this.scopeId,
      ),
      this.statement(
        `UPDATE ${this.stateTable} SET publication_until=(SELECT until_at FROM collection_runs WHERE id=?) WHERE id=? AND active_run_id=?`,
        runId,
        this.stateId,
        runId,
      ),
    ]);
  }

  async publishPersonal(
    runId: string,
    snapshot: ActivitySnapshot,
  ): Promise<void> {
    if (this.scopeId === "default")
      throw new Error("Personal publication requires a personal scope.");
    const updated = await this.one<{ id: string }>(
      `UPDATE personal_state SET snapshot_json=?,published_run_id=?
       WHERE id=? AND active_run_id=?
       AND EXISTS(SELECT 1 FROM personal_users WHERE id=? AND status='active')
       AND EXISTS(SELECT 1 FROM collection_runs r JOIN config_revisions c ON c.id=r.revision_id
         WHERE r.id=? AND r.status='ready' AND c.config_id=?)
       RETURNING id`,
      JSON.stringify(snapshot),
      runId,
      this.scopeId,
      runId,
      this.scopeId,
      runId,
      this.scopeId,
    );
    if (!updated)
      throw new Error(
        "Personal publication was stopped by current authorization or run ownership.",
      );
  }

  async published(runId: string): Promise<void> {
    await this.batch([
      this.statement(
        "UPDATE collection_runs SET status='published',published_at=? WHERE id=? AND status!='cancelled' AND revision_id IN (SELECT id FROM config_revisions WHERE config_id=?)",
        new Date().toISOString(),
        runId,
        this.scopeId,
      ),
      this.statement(
        `UPDATE ${this.stateTable} SET active_run_id=NULL,published_run_id=? WHERE id=? AND active_run_id=?`,
        runId,
        this.stateId,
        runId,
      ),
    ]);
  }

  async failed(runId: string, message: string): Promise<void> {
    await this.statement(
      "UPDATE collection_runs SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'failed' END,error_message=? WHERE id=? AND status NOT IN ('published','blocked','cancelled') AND revision_id IN (SELECT id FROM config_revisions WHERE config_id=?)",
      message,
      runId,
      this.scopeId,
    ).run();
  }

  async cancel(runId: string): Promise<void> {
    await this.batch([
      this.statement(
        `UPDATE collection_runs SET status='cancelled' WHERE id=? AND id=(SELECT active_run_id FROM ${this.stateTable} WHERE id=?) AND revision_id IN (SELECT id FROM config_revisions WHERE config_id=?)`,
        runId,
        this.stateId,
        this.scopeId,
      ),
      this.statement(
        `UPDATE ${this.stateTable} SET active_run_id=NULL WHERE id=? AND active_run_id=?`,
        this.stateId,
        runId,
      ),
    ]);
  }
}
