CREATE TABLE IF NOT EXISTS source_pending_batches (
  source_id text PRIMARY KEY REFERENCES data_sources(id) ON DELETE CASCADE,
  integration_scope text,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
