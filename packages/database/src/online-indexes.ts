import type { ReservedSql } from 'postgres';

/** Deliberately narrow: nontransactional migrations may only contain named, plain
 * btree column indexes. DDL/data updates still belong in transactional migrations. */
export function parseOnlineIndexes(body: string) {
  const statements = body
    .replace(/^\s*--[^\n]*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (!statements.length) throw new Error('Online index migration is empty');
  return statements.map((statement) => {
    const parsed =
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+([a-z_][a-z0-9_]*)\s+ON\s+([a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*(?:\s+(?:ASC|DESC))?(?:\s*,\s*[a-z_][a-z0-9_]*(?:\s+(?:ASC|DESC))?)*)\s*\)$/i.exec(
        statement,
      );
    if (!parsed)
      throw new Error('Online migration only supports CREATE INDEX CONCURRENTLY on named columns');
    return { name: parsed[2]!, table: parsed[3]!, statement };
  });
}

export function canonicalIndexDefinition(definition: string) {
  return definition
    .replace(/"/g, '')
    .replace(/\bCONCURRENTLY\b/gi, '')
    .replace(/\bUSING\s+btree\b/gi, '')
    .replace(/\bON\s+[^\s.]+\./i, 'ON ')
    .replace(/\bASC\b/gi, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export async function applyOnlineIndexes(connection: ReservedSql, body: string) {
  for (const index of parseOnlineIndexes(body)) {
    const inspect = () => connection<
      {
        valid: boolean;
        ready: boolean;
        correct_table: boolean;
        definition: string;
      }[]
    >`
      SELECT i.indisvalid AS valid,i.indisready AS ready,
        i.indrelid=to_regclass(${index.table}) AS correct_table,
        pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i WHERE i.indexrelid=to_regclass(${index.name})`;
    const before = (await inspect())[0];
    if (before) {
      if (
        !before.correct_table ||
        canonicalIndexDefinition(before.definition) !== canonicalIndexDefinition(index.statement)
      )
        throw new Error(`Existing index definition mismatch: ${index.name}`);
      if (before.valid && before.ready) continue;
      // PostgreSQL can retain an invalid index if concurrent creation was
      // interrupted. Only this exact migration-owned, verified index is removed.
      await connection.unsafe(`DROP INDEX CONCURRENTLY ${index.name}`);
    }
    await connection.unsafe(index.statement);
    const after = (await inspect())[0];
    if (
      !after?.valid ||
      !after.ready ||
      !after.correct_table ||
      canonicalIndexDefinition(after.definition) !== canonicalIndexDefinition(index.statement)
    )
      throw new Error(`Online index did not become valid: ${index.name}`);
  }
}
