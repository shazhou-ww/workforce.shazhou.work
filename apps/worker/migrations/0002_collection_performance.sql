CREATE TABLE collection_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_runs(id),
  step_name TEXT NOT NULL,
  phase TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  active_ms REAL NOT NULL CHECK (active_ms >= 0),
  rest_requests INTEGER NOT NULL CHECK (rest_requests >= 0),
  graphql_requests INTEGER NOT NULL CHECK (graphql_requests >= 0),
  http_errors INTEGER NOT NULL CHECK (http_errors >= 0),
  network_errors INTEGER NOT NULL CHECK (network_errors >= 0)
);
CREATE INDEX collection_attempts_run ON collection_attempts(run_id);

CREATE TABLE collection_waits (
  run_id TEXT NOT NULL REFERENCES collection_runs(id),
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (run_id, name)
);
