PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visual_skill_consumers (
  assistant_id TEXT PRIMARY KEY CHECK (
    substr(assistant_id, 1, 6) = 'oauth-'
    AND length(assistant_id) = 38
    AND substr(assistant_id, 7) NOT GLOB '*[^0-9a-f]*'
  ),
  consumer_id TEXT NOT NULL CHECK (consumer_id = 'general-assistant'),
  tenant_id TEXT NOT NULL CHECK (tenant_id = 'personal'),
  project_id TEXT NOT NULL CHECK (project_id = 'project-infinitum'),
  domain_id TEXT NOT NULL CHECK (domain_id = 'visual-design-expression'),
  allowed_scopes_json TEXT NOT NULL,
  grant_version TEXT NOT NULL CHECK (length(grant_version) = 64),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_visual_skill_consumers_active
ON visual_skill_consumers (consumer_id, active, project_id, domain_id);
