import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const skip = new Set([
  'node_modules',
  '.git',
  '.local',
  '.turbo',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  'generated',
]);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /gh[pousr]_[a-zA-Z0-9]{30,}/,
  /sk-(?:proj-)?[a-zA-Z0-9_-]{40,}/,
  /[0-9]{8,12}:AA[a-zA-Z0-9_-]{30,}/,
];
const issues: string[] = [];
async function scan(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      skip.has(entry.name) ||
      entry.name === '.env' ||
      (entry.name.startsWith('.env.') && entry.name !== '.env.example')
    )
      continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.(?:ts|vue|js|json|yml|yaml|md|sh|env|example)$/.test(path)) {
      const text = await readFile(path, 'utf8');
      if (patterns.some((p) => p.test(text))) issues.push(path);
      if (/\.(?:ts|js|vue)$/.test(path) && !path.endsWith('security-check.ts')) {
        const source = path.endsWith('.vue')
          ? (text.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '')
          : text;
        const file = ts.createSourceFile(
          path,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        const visit = (node: ts.Node) => {
          if (
            (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
            ts.isIdentifier(node.expression) &&
            ['eval', 'Function'].includes(node.expression.text)
          )
            issues.push(`${path}: dynamic code execution is forbidden`);
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
  }
}
await scan('.');
if (issues.length) {
  console.error('Security scan failed:', issues.join('\n'));
  process.exit(1);
}
console.log(
  'Security scan passed: no known credential signatures or eval execution. Dependency audit runs separately.',
);
