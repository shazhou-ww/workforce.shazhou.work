PRAGMA defer_foreign_keys = ON;

CREATE TABLE collection_configs_new (
  id TEXT PRIMARY KEY,
  active_revision_id TEXT REFERENCES config_revisions(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
);
INSERT INTO collection_configs_new SELECT * FROM collection_configs;
DROP TABLE collection_configs;
ALTER TABLE collection_configs_new RENAME TO collection_configs;
ALTER TABLE config_revisions ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1));
UPDATE config_revisions SET enabled=COALESCE((SELECT enabled FROM collection_configs WHERE id=config_revisions.config_id),0);

CREATE TABLE personal_users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  last_refresh_at TEXT,
  last_scheduled_at TEXT
);
CREATE TABLE personal_identities (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES personal_users(id),
  PRIMARY KEY(provider, provider_id),
  UNIQUE(user_id, provider)
);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'revoked')),
  user_id TEXT UNIQUE REFERENCES personal_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE personal_github (
  user_id TEXT PRIMARY KEY REFERENCES personal_users(id),
  github_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  credential TEXT NOT NULL,
  scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE github_link_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES personal_users(id),
  session_binding TEXT NOT NULL,
  organizations INTEGER NOT NULL CHECK (organizations IN (0, 1)),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE personal_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES personal_users(id),
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE personal_state (
  id TEXT PRIMARY KEY REFERENCES personal_users(id),
  active_run_id TEXT REFERENCES collection_runs(id),
  email_key_id TEXT,
  publication_until TEXT,
  published_run_id TEXT REFERENCES collection_runs(id),
  snapshot_json TEXT
);
CREATE INDEX identities_user ON personal_identities(user_id);
CREATE INDEX personal_due ON personal_users(status, last_scheduled_at);
CREATE INDEX revisions_scope ON config_revisions(config_id, created_at);
CREATE TABLE personal_repository_sync_state (
  scope_id TEXT NOT NULL REFERENCES personal_users(id),
  repository_id INTEGER NOT NULL REFERENCES repositories(github_id),
  default_branch TEXT,
  head_sha TEXT,
  history_id TEXT NOT NULL REFERENCES repository_histories(id),
  last_successful_run_id TEXT NOT NULL REFERENCES collection_runs(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope_id, repository_id)
);
-- SQLite retains deferred DROP-parent counters even after the replacement has
-- restored every reference. Validate the rebuilt graph before clearing them.
CREATE TABLE personal_migration_fk_check (violations INTEGER CHECK (violations=0));
INSERT INTO personal_migration_fk_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE personal_migration_fk_check;
PRAGMA defer_foreign_keys = OFF;
