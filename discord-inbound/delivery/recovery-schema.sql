CREATE TABLE IF NOT EXISTS inbound_recovery (
  id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  required_at TEXT NOT NULL,
  reviewed_at TEXT,
  outcome TEXT CHECK (outcome IN ('resume','settled','informational','needs-review')),
  reason TEXT,
  evidence TEXT
);
CREATE TABLE IF NOT EXISTS recovery_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
