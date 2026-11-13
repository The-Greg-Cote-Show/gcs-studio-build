-- GCS Studio Build: database tables.
-- Paste this whole file into the D1 Console and press Execute.
-- Safe to run more than once. It never deletes anything.

CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  key_hash    TEXT    NOT NULL UNIQUE,   -- SHA-256 of the private key. Never the key itself.
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  note         TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL,          -- a status id from STATUSES in worker/src/index.js
  custom_json  TEXT    NOT NULL DEFAULT '{}',  -- custom field values keyed by field id
  created_by   INTEGER NOT NULL REFERENCES people(id),
  updated_by   INTEGER NOT NULL REFERENCES people(id),
  created_at   INTEGER NOT NULL,          -- milliseconds since 1970
  updated_at   INTEGER NOT NULL,          -- also the version check for edits
  archived_at  INTEGER,
  archived_by  INTEGER REFERENCES people(id)
);
CREATE INDEX IF NOT EXISTS items_archived ON items (archived_at);

CREATE TABLE IF NOT EXISTS fields (
  id            TEXT    PRIMARY KEY,
  label         TEXT    NOT NULL,
  type          TEXT    NOT NULL,         -- text, link, number, price, date, dropdown, checkbox, person
  options_json  TEXT    NOT NULL DEFAULT '[]',  -- dropdown choices
  sort_order    INTEGER NOT NULL,
  hidden_at     INTEGER                   -- hidden fields keep their values
);

-- Failed key attempts, for the rate limit. Salted hash of the IP only.
CREATE TABLE IF NOT EXISTS auth_failures (
  ip_hash  TEXT    NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_ip ON auth_failures (ip_hash, at);

-- Small settings the Worker manages itself (the IP salt lives here).
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Starter custom fields.
INSERT OR IGNORE INTO fields (id, label, type, options_json, sort_order) VALUES
  ('f_link',  'Link',          'link',   '[]', 1),
  ('f_price', 'Price',         'price',  '[]', 2),
  ('f_buyer', 'Who is buying', 'person', '[]', 3),
  ('f_qty',   'Quantity',      'number', '[]', 4);
