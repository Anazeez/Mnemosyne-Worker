PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS specialist_principals (
  principal_id TEXT PRIMARY KEY,
  specialist_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  domain_ids_json TEXT NOT NULL,
  memory_domains_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  lane_permissions_json TEXT NOT NULL,
  grant_version TEXT NOT NULL CHECK (length(grant_version) = 64),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_principal_identity
ON specialist_principals (tenant_id, specialist_id, principal_id);

CREATE TABLE IF NOT EXISTS specialist_assistant_bindings (
  assistant_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('custom-gpt', 'api-email')),
  package_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  FOREIGN KEY (principal_id) REFERENCES specialist_principals(principal_id)
);

CREATE TABLE IF NOT EXISTS legacy_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  rotated_at TEXT,
  FOREIGN KEY (principal_id) REFERENCES specialist_principals(principal_id)
);

CREATE TABLE IF NOT EXISTS mesh_messages (
  message_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('chatgpt', 'email', 'mesh', 'api')),
  principal_id TEXT NOT NULL,
  target_specialist TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('root-local', 'savae-routed')),
  project_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  security_state TEXT NOT NULL CHECK (security_state IN ('pending', 'cleared', 'quarantined', 'blocked')),
  status TEXT NOT NULL CHECK (status IN ('received', 'accepted', 'running', 'completed', 'failed', 'expired')),
  forwarded_by_architectus INTEGER NOT NULL DEFAULT 0 CHECK (forwarded_by_architectus IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_inbox
ON mesh_messages (target_specialist, status, created_at);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_correlation
ON mesh_messages (correlation_id, created_at);

CREATE TABLE IF NOT EXISTS security_preflights (
  preflight_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('clear', 'warning', 'critical')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'alarm', 'block')),
  reason_codes_json TEXT NOT NULL,
  override_actor TEXT,
  override_scope TEXT,
  overridden_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES mesh_messages(message_id)
);

CREATE INDEX IF NOT EXISTS idx_security_preflights_message
ON security_preflights (message_id, created_at);
