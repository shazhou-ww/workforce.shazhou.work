ALTER TABLE personal_private_repositories ADD COLUMN progress_json TEXT;
ALTER TABLE personal_private_repositories ADD COLUMN pinned_json TEXT;

CREATE TABLE public_collection_progress (
  scope_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES config_revisions(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL,
  progress_json TEXT NOT NULL,
  PRIMARY KEY(scope_id, revision_id, repository_id)
);
