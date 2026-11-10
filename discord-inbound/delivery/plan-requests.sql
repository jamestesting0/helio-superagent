CREATE TABLE IF NOT EXISTS plan_requests (
  repo TEXT NOT NULL, issue INTEGER NOT NULL, message TEXT NOT NULL,
  channel TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL,
  source_hash TEXT NOT NULL, accepted_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','posted','cancelled')),
  comment_id TEXT, settled_at TEXT, cancel_message TEXT,
  PRIMARY KEY(repo, issue, message)
);
