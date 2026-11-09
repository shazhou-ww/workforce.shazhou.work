import {
  activityTotals,
  activityWindow,
  combineDaily,
  type ActivitySnapshot,
  type DailyActivity,
  type RepositoryActivity,
} from "@workspace/contracts";
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

export class CollectionStore {
  private readonly db: D1DatabaseSession;

  constructor(db: D1Database) {
    this.db = db.withSession("first-primary");
  }

  statement(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).bind(...values);
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

  async saveConfig(config: CollectionConfig): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.batch([
      this.statement(
        "INSERT INTO config_revisions(id,config_id,repository_mode,created_at) VALUES (?,'default',?,?)",
        id,
        config.repositoryMode,
        now,
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
        "UPDATE collection_configs SET active_revision_id=?,enabled=? WHERE id='default'",
        id,
        Number(config.enabled),
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
      "SELECT active_revision_id AS revisionId,enabled FROM collection_configs WHERE id='default'",
    );
    if (!result)
      throw new Error("Apply the collection D1 migrations before use.");
    return result;
  }

  async config(revisionId: string): Promise<CollectionConfig> {
    const revision = await this.one<{
      repository_mode: CollectionConfig["repositoryMode"];
    }>("SELECT repository_mode FROM config_revisions WHERE id=?", revisionId);
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
    const active = await this.activeConfig();
    return {
      enabled: active.enabled === 1,
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
      "SELECT * FROM collection_runs WHERE id=?",
      runId,
    );
    if (
      existing &&
      ["published", "blocked", "cancelled"].includes(existing.status)
    )
      return false;
    const window = activityWindow(new Date(until));
    const state = await this.one<{ email_key_id: string | null }>(
      "SELECT email_key_id FROM collection_state WHERE id=1",
    );
    if (!state) throw new Error("Collection state is uninitialized.");
    if (state.email_key_id !== null && state.email_key_id !== keyId) {
      throw new Error(
        "COLLECTION_EMAIL_KEY changed; rebuild the database before rotating this key.",
      );
    }
    await this.batch([
      this.statement(
        "INSERT OR IGNORE INTO collection_runs(id,revision_id,status,since_at,until_at,started_at) VALUES (?,?,'queued',?,?,?)",
        runId,
        revisionId,
        window.since,
        window.until,
        new Date().toISOString(),
      ),
      this.statement(
        "UPDATE collection_state SET active_run_id=?,email_key_id=? WHERE id=1 AND (active_run_id IS NULL OR active_run_id=?) AND ? >= COALESCE(publication_until,'')",
        runId,
        keyId,
        runId,
        window.until,
      ),
      this.statement(
        "UPDATE collection_runs SET status=CASE WHEN (SELECT active_run_id FROM collection_state WHERE id=1)=id THEN 'collecting' ELSE 'blocked' END,error_message=NULL WHERE id=? AND status IN ('queued','failed')",
        runId,
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
      "INSERT OR IGNORE INTO collection_runs(id,revision_id,status,since_at,until_at,started_at) VALUES (?,?,'queued',?,?,?)",
      runId,
      revisionId,
      window.since,
      window.until,
      new Date().toISOString(),
    ).run();
  }

  async ownsRun(runId: string): Promise<boolean> {
    const state = await this.one<{ active_run_id: string | null }>(
      "SELECT active_run_id FROM collection_state WHERE id=1",
    );
    return state?.active_run_id === runId;
  }

  async run(id: string): Promise<CollectionRun> {
    const row = await this.one<CollectionRun>(
      "SELECT * FROM collection_runs WHERE id=?",
      id,
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
  }

  repositories(runId: string) {
    return this.rows<RunRepository>(
      "SELECT * FROM run_repositories WHERE run_id=? ORDER BY repository_id",
      runId,
    );
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
    await this.batch(statements);
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
        run.since_at,
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
         WHERE r.run_id=? AND r.repository_id=? AND r.author_matched=1
         GROUP BY date(c.committed_at,'+8 hours')`,
        repo.run_id,
        repo.repository_id,
      ),
      this.statement(
        "INSERT INTO repository_sync_state VALUES (?,?,?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET default_branch=excluded.default_branch,head_sha=excluded.head_sha,history_id=excluded.history_id,last_successful_run_id=excluded.last_successful_run_id,updated_at=excluded.updated_at",
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
    await this.batch(statements);
  }

  async snapshot(runId: string): Promise<ActivitySnapshot> {
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
      repositories,
      totals: activityTotals(daily),
    };
  }

  async ready(runId: string): Promise<void> {
    if (!(await this.ownsRun(runId)))
      throw new Error("Collection no longer owns the publication lock.");
    await this.batch([
      this.statement(
        "UPDATE collection_runs SET status='ready',completed_at=? WHERE id=?",
        new Date().toISOString(),
        runId,
      ),
      this.statement(
        "UPDATE collection_state SET publication_until=(SELECT until_at FROM collection_runs WHERE id=?) WHERE id=1 AND active_run_id=?",
        runId,
        runId,
      ),
    ]);
  }

  async published(runId: string): Promise<void> {
    await this.batch([
      this.statement(
        "UPDATE collection_runs SET status='published',published_at=? WHERE id=?",
        new Date().toISOString(),
        runId,
      ),
      this.statement(
        "UPDATE collection_state SET active_run_id=NULL,published_run_id=? WHERE id=1 AND active_run_id=?",
        runId,
        runId,
      ),
    ]);
  }

  async failed(runId: string, message: string): Promise<void> {
    await this.statement(
      "UPDATE collection_runs SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'failed' END,error_message=? WHERE id=? AND status NOT IN ('published','blocked','cancelled')",
      message,
      runId,
    ).run();
  }

  async cancel(runId: string): Promise<void> {
    await this.batch([
      this.statement(
        "UPDATE collection_runs SET status='cancelled' WHERE id=? AND id=(SELECT active_run_id FROM collection_state WHERE id=1)",
        runId,
      ),
      this.statement(
        "UPDATE collection_state SET active_run_id=NULL WHERE id=1 AND active_run_id=?",
        runId,
      ),
    ]);
  }
}
