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
  const [typesFormatting, specFormatting] = await Promise.all([
    prettier.resolveConfig('apps/web/src/generated/api.d.ts'),
    prettier.resolveConfig('docs/openapi.json'),
  ]);
  await writeFile(
    'apps/web/src/generated/api.d.ts',
    await prettier.format(astToString(ast), {
      ...typesFormatting,
      filepath: 'apps/web/src/generated/api.d.ts',
    }),
  );
  await writeFile(
    'docs/openapi.json',
    await prettier.format(JSON.stringify(spec), {
      ...specFormatting,
      filepath: 'docs/openapi.json',
    }),
  );
  console.log('OpenAPI spec and frontend types generated from actual API schemas.');
} finally {
  redis.disconnect();
  await closeDatabase();
}
