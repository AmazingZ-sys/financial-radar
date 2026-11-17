-- Additive structures; the preceding deployment can keep writing JSON observations.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE project_metrics ADD COLUMN evidence_id uuid REFERENCES raw_items(id);
ALTER TABLE project_metrics ADD COLUMN available_at timestamptz;

CREATE TABLE participation_window_plans (
  data_mode text NOT NULL CHECK(data_mode IN ('live','fixture')),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_key text NOT NULL,
  source_id text REFERENCES data_sources(id),
  observation_id uuid,
  evidence_id uuid REFERENCES raw_items(id),
  observation_snapshot jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  detector_version text NOT NULL,
  next_check_at timestamptz,
  status text NOT NULL DEFAULT 'IDLE' CHECK(status IN ('WAITING','PROCESSING','IDLE','FAILED')),
  claim_token uuid,
  locked_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(data_mode,project_id)
);
CREATE INDEX participation_due_idx ON participation_window_plans(data_mode,next_check_at,project_id)
  WHERE status='WAITING' AND next_check_at IS NOT NULL;
CREATE INDEX participation_lease_idx ON participation_window_plans(locked_until,data_mode,project_id)
  WHERE status='PROCESSING';
CREATE INDEX participation_source_idx ON participation_window_plans(source_id,data_mode,project_id);

CREATE TABLE participation_refresh_requests (
  data_mode text NOT NULL CHECK(data_mode IN ('live','fixture')),
  asset_key text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error_code text,
  PRIMARY KEY(data_mode,asset_key)
);
CREATE INDEX participation_refresh_due_idx ON participation_refresh_requests(data_mode,next_attempt_at,asset_key);

CREATE TABLE participation_source_refreshes (
  data_mode text NOT NULL CHECK(data_mode IN ('live','fixture')),
  source_id text NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  cursor uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(data_mode,source_id)
);

CREATE TABLE participation_deferred_observations (
  raw_item_id uuid PRIMARY KEY REFERENCES raw_items(id) ON DELETE CASCADE,
  data_mode text NOT NULL CHECK(data_mode IN ('live','fixture')),
  asset_key text NOT NULL,
  source_id text NOT NULL REFERENCES data_sources(id),
  available_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_error_code text
);
CREATE INDEX participation_deferred_due_idx ON participation_deferred_observations(data_mode,next_attempt_at,raw_item_id);

CREATE TABLE participation_repair_state (
  data_mode text PRIMARY KEY CHECK(data_mode IN ('live','fixture')),
  cursor uuid,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  detector_version text NOT NULL
);

-- Never cast unvalidated imported JSON UUIDs, and never cast the indexed raw_items.id.
CREATE FUNCTION radar_participation_evidence_uuid(value text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN value::uuid ELSE NULL END
$$;
CREATE FUNCTION radar_participation_timestamp(value text) RETURNS timestamptz
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE parsed timestamptz;
BEGIN
  parsed := value::timestamptz;
  RETURN CASE WHEN isfinite(parsed) THEN parsed ELSE NULL END;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END
$$;

-- Backfill only actual same-source references; malformed/missing references stay NULL
-- and can be counted by operators without aborting an entire migration.
UPDATE project_metrics m SET
  evidence_id = r.id,
  available_at = CASE WHEN m.data->>'availableAt' IS NULL THEN m.observed_at
    ELSE radar_participation_timestamp(m.data->>'availableAt') END
FROM raw_items r
WHERE r.id = radar_participation_evidence_uuid(m.data->>'evidenceId')
  AND r.source_id=m.source_id;

CREATE FUNCTION radar_participation_metric_types() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.evidence_id IS NULL THEN
      SELECT r.id INTO NEW.evidence_id FROM raw_items r
      WHERE r.id=radar_participation_evidence_uuid(NEW.data->>'evidenceId') AND r.source_id=NEW.source_id;
    END IF;
    IF NEW.available_at IS NULL THEN
      NEW.available_at := CASE WHEN NEW.data->>'availableAt' IS NULL THEN NEW.observed_at
        ELSE radar_participation_timestamp(NEW.data->>'availableAt') END;
    END IF;
  ELSE
    IF (NEW.data->>'evidenceId') IS DISTINCT FROM (OLD.data->>'evidenceId') OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
      SELECT r.id INTO NEW.evidence_id FROM raw_items r
      WHERE r.id=radar_participation_evidence_uuid(NEW.data->>'evidenceId') AND r.source_id=NEW.source_id;
    END IF;
    IF (NEW.data->>'availableAt') IS DISTINCT FROM (OLD.data->>'availableAt') OR NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN
      NEW.available_at := CASE WHEN NEW.data->>'availableAt' IS NULL THEN NEW.observed_at
        ELSE radar_participation_timestamp(NEW.data->>'availableAt') END;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER participation_metric_types BEFORE INSERT OR UPDATE ON project_metrics
FOR EACH ROW EXECUTE FUNCTION radar_participation_metric_types();

CREATE FUNCTION radar_participation_metric_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_project uuid; affected_mode text; affected_asset text;
BEGIN
  affected_project := CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  SELECT p.data->>'dataMode',p.asset_key INTO affected_mode,affected_asset FROM projects p WHERE p.id=affected_project;
  IF affected_mode IN ('live','fixture') THEN
    INSERT INTO participation_refresh_requests(data_mode,asset_key) VALUES(affected_mode,affected_asset)
    ON CONFLICT(data_mode,asset_key) DO UPDATE SET requested_at=clock_timestamp(),next_attempt_at=clock_timestamp(),attempts=0,last_error_code=NULL;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER participation_metric_refresh AFTER INSERT OR UPDATE OR DELETE ON project_metrics
FOR EACH ROW EXECUTE FUNCTION radar_participation_metric_refresh();

CREATE FUNCTION radar_participation_source_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.mode IS DISTINCT FROM NEW.mode THEN
    INSERT INTO participation_source_refreshes(data_mode,source_id) VALUES(OLD.mode,NEW.id)
    ON CONFLICT(data_mode,source_id) DO UPDATE SET cursor=NULL,requested_at=clock_timestamp();
    IF OLD.mode IS DISTINCT FROM NEW.mode THEN
      INSERT INTO participation_source_refreshes(data_mode,source_id) VALUES(NEW.mode,NEW.id)
      ON CONFLICT(data_mode,source_id) DO UPDATE SET cursor=NULL,requested_at=clock_timestamp();
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER participation_source_refresh AFTER UPDATE OF enabled,mode ON data_sources
FOR EACH ROW EXECUTE FUNCTION radar_participation_source_refresh();
