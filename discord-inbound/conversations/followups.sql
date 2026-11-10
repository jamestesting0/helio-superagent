CREATE TABLE IF NOT EXISTS followups (
    repo TEXT NOT NULL,
    issue INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'announced', 'done')),
    announcement TEXT,
    delivery_version INTEGER NOT NULL DEFAULT 0,
    delivered_reply_id TEXT,
    delivery_disposition TEXT,
    observed_at INTEGER,
    PRIMARY KEY (repo, issue, user_id)
);
