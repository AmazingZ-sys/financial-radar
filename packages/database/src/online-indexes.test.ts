import { describe, expect, it } from 'vitest';
import { canonicalIndexDefinition, parseOnlineIndexes } from './online-indexes.js';

describe('nontransactional migration boundary', () => {
  it('accepts only concurrent btree column indexes and rejects mixed DDL', () => {
    expect(
      parseOnlineIndexes(
        `-- radar:nontransactional-indexes\nCREATE INDEX CONCURRENTLY metrics_latest ON project_metrics(project_id,observed_at DESC);`,
      ),
    ).toEqual([
      {
        name: 'metrics_latest',
        table: 'project_metrics',
        statement:
          'CREATE INDEX CONCURRENTLY metrics_latest ON project_metrics(project_id,observed_at DESC)',
      },
    ]);
    for (const body of [
      'CREATE INDEX ordinary ON project_metrics(project_id);',
      'CREATE INDEX CONCURRENTLY metrics_latest ON project_metrics(project_id); DELETE FROM project_metrics;',
      "CREATE INDEX CONCURRENTLY metrics_latest ON project_metrics((data->>'evidenceId'));",
      'CREATE INDEX CONCURRENTLY metrics_latest ON project_metrics(project_id) WHERE observed_at<now();',
      '-- empty migration',
    ])
      expect(() => parseOnlineIndexes(body)).toThrow();
  });
  it('compares catalog definitions without losing column order, uniqueness, or direction', () => {
    const migration = canonicalIndexDefinition(
      'CREATE INDEX CONCURRENTLY metrics_latest ON project_metrics(project_id ASC,observed_at DESC)',
    );
    expect(
      canonicalIndexDefinition(
        'CREATE INDEX metrics_latest ON public.project_metrics USING btree (project_id, observed_at DESC)',
      ),
    ).toBe(migration);
    for (const definition of [
      'CREATE UNIQUE INDEX metrics_latest ON public.project_metrics USING btree (project_id, observed_at DESC)',
      'CREATE INDEX metrics_latest ON public.project_metrics USING btree (observed_at DESC, project_id)',
      'CREATE INDEX metrics_latest ON public.project_metrics USING btree (project_id, observed_at)',
      'CREATE INDEX metrics_latest ON public.project_metrics USING hash (project_id, observed_at DESC)',
    ])
      expect(canonicalIndexDefinition(definition)).not.toBe(migration);
  });
});
