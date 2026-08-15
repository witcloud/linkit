-- Migration number: 0001 	 2026-08-15T18:29:38.442Z

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short_code TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  last_visited_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code);
CREATE INDEX IF NOT EXISTS idx_links_expires_at ON links(expires_at);
