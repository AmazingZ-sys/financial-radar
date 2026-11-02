CREATE TABLE economic_calendar (
  id uuid PRIMARY KEY,
  source_id text NOT NULL,
  external_id text NOT NULL,
  country text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  data_mode text NOT NULL CHECK(data_mode IN ('fixture','live')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,external_id,data_mode)
);
CREATE INDEX calendar_time ON economic_calendar(data_mode,scheduled_at);
