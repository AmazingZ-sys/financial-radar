import { appendFileSync, writeFileSync } from 'node:fs';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid stable semantic version');
const metadata = {
  version: `v${version}`,
  commit: process.env.GITHUB_SHA,
  builtAt: new Date().toISOString(),
};
writeFileSync('release-metadata.json', JSON.stringify(metadata, null, 2));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=v${version}\ncommit=${process.env.GITHUB_SHA}\n`,
  );
