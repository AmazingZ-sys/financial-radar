-- radar:nontransactional-indexes
-- Existing tables: build outside a transaction, verify definition/validity, then ledger.
CREATE INDEX CONCURRENTLY project_metrics_latest_participation ON project_metrics(project_id,observed_at DESC,source_id,id);
CREATE INDEX CONCURRENTLY project_metrics_participation_source ON project_metrics(source_id,project_id);
