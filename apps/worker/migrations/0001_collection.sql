CREATE TABLE accounts (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repositories (
  github_id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES accounts(github_id),
  full_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX repositories_owner ON repositories(owner_id);

CREATE TABLE collection_configs (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  active_revision_id TEXT REFERENCES config_revisions(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
);

CREATE TABLE config_revisions (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES collection_configs(id),
  repository_mode TEXT NOT NULL CHECK (repository_mode IN ('all_owned_public', 'explicit')),
  created_at TEXT NOT NULL
);

CREATE TABLE config_identities (
  revision_id TEXT NOT NULL REFERENCES config_revisions(id),
  identity_type TEXT NOT NULL CHECK (identity_type IN ('github_login', 'email')),
  normalized_value TEXT NOT NULL,
  PRIMARY KEY (revision_id, identity_type, normalized_value)
);

CREATE TABLE config_accounts (
  revision_id TEXT NOT NULL REFERENCES config_revisions(id),
  login TEXT NOT NULL,
  PRIMARY KEY (revision_id, login)
);

CREATE TABLE config_repository_rules (
  revision_id TEXT NOT NULL REFERENCES config_revisions(id),
  full_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('include', 'exclude')),
  PRIMARY KEY (revision_id, full_name, action)
);

CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES config_revisions(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'collecting', 'ready', 'published', 'failed', 'blocked', 'cancelled')),
  since_at TEXT NOT NULL,
  until_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  published_at TEXT,
  error_message TEXT
);
CREATE INDEX collection_runs_status ON collection_runs(status, until_at);

CREATE TABLE collection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_run_id TEXT REFERENCES collection_runs(id),
  email_key_id TEXT,
  publication_until TEXT,
  published_run_id TEXT REFERENCES collection_runs(id)
);
INSERT INTO collection_state(id) VALUES (1);
INSERT INTO collection_configs(id) VALUES ('default');

CREATE TABLE run_accounts (
  run_id TEXT NOT NULL REFERENCES collection_runs(id),
  account_id INTEGER NOT NULL REFERENCES accounts(github_id),
  PRIMARY KEY (run_id, account_id)
);

CREATE TABLE discovery_pages (
  run_id TEXT NOT NULL REFERENCES collection_runs(id),
  scope TEXT NOT NULL,
  page INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (run_id, scope, page)
);

CREATE TABLE repository_histories (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(github_id),
  created_at TEXT NOT NULL
);

CREATE TABLE commits (
  repository_id INTEGER NOT NULL REFERENCES repositories(github_id),
  sha TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  author_login TEXT,
  author_email_hmac TEXT,
  additions INTEGER NOT NULL CHECK (additions >= 0),
  deletions INTEGER NOT NULL CHECK (deletions >= 0),
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, sha)
);
CREATE INDEX commits_date ON commits(repository_id, committed_at);

CREATE TABLE history_commits (
  history_id TEXT NOT NULL REFERENCES repository_histories(id),
  repository_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (history_id, repository_id, sha),
  FOREIGN KEY (repository_id, sha) REFERENCES commits(repository_id, sha)
);

CREATE TABLE run_repositories (
  run_id TEXT NOT NULL REFERENCES collection_runs(id),
  repository_id INTEGER NOT NULL REFERENCES repositories(github_id),
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collecting', 'complete')),
  metadata_json TEXT,
  default_branch TEXT,
  head_sha TEXT,
  history_id TEXT REFERENCES repository_histories(id),
  sync_mode TEXT CHECK (sync_mode IN ('full', 'incremental', 'reuse')),
  base_sha TEXT,
  history_cursor TEXT,
  compare_page INTEGER NOT NULL DEFAULT 1,
  expected_commits INTEGER,
  received_commits INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  PRIMARY KEY (run_id, repository_id)
);

CREATE TABLE repository_sync_state (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(github_id),
  default_branch TEXT,
  head_sha TEXT,
  history_id TEXT NOT NULL REFERENCES repository_histories(id),
  last_successful_run_id TEXT NOT NULL REFERENCES collection_runs(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE run_commits (
  run_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  author_matched INTEGER NOT NULL CHECK (author_matched IN (0, 1)),
  PRIMARY KEY (run_id, repository_id, sha),
  FOREIGN KEY (run_id, repository_id) REFERENCES run_repositories(run_id, repository_id),
  FOREIGN KEY (repository_id, sha) REFERENCES commits(repository_id, sha)
);
CREATE INDEX run_commits_matched ON run_commits(run_id, author_matched, repository_id);

CREATE TABLE pending_history_commits (
  run_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (run_id, repository_id, sha),
  FOREIGN KEY (run_id, repository_id) REFERENCES run_repositories(run_id, repository_id),
  FOREIGN KEY (repository_id, sha) REFERENCES commits(repository_id, sha)
);

CREATE TABLE daily_activity (
  run_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  commit_count INTEGER NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  PRIMARY KEY (run_id, repository_id, date),
  FOREIGN KEY (run_id, repository_id) REFERENCES run_repositories(run_id, repository_id)
);
CREATE INDEX daily_activity_date ON daily_activity(run_id, date, repository_id);
