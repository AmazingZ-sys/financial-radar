import prettier from 'prettier';
import { mkdir, writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';
import { createApp } from '../apps/api/src/app.js';
import { closeDatabase } from '../packages/database/src/index.js';
import { redis } from '../apps/api/src/security.js';
try {
  const app = createApp();
  const response = await app.request('/openapi.json');
  if (!response.ok) throw new Error('OpenAPI generation failed');
  const spec = await response.json();
  const ast = await openapiTS(spec);
  await mkdir('apps/web/src/generated', { recursive: true });
  const formatting = await prettier.resolveConfig(process.cwd());
  await writeFile(
    'apps/web/src/generated/api.d.ts',
    await prettier.format(astToString(ast), { ...formatting, parser: 'typescript' }),
  );
  await writeFile(
    'docs/openapi.json',
    await prettier.format(JSON.stringify(spec), { ...formatting, parser: 'json' }),
  );
  console.log('OpenAPI spec and frontend types generated from actual API schemas.');
} finally {
  redis.disconnect();
  await closeDatabase();
}
