CREATE TABLE personal_private_repositories (
  user_id TEXT PRIMARY KEY REFERENCES personal_users(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  credential TEXT NOT NULL,
  repositories_json TEXT NOT NULL,
  active_run_id TEXT,
  last_refresh_at TEXT,
  snapshot_json TEXT,
  error_message TEXT
);
