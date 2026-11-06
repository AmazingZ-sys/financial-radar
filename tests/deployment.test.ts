import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function harness(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'radar-deploy-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, '.deploy'));
  mkdirSync(join(root, '.deploy/images'));
  const apiDigest = 'ghcr.io/test/radar/api@sha256:' + 'a'.repeat(64);
  const workerDigest = 'ghcr.io/test/radar/worker@sha256:' + 'b'.repeat(64);
  const collectorDigest = 'ghcr.io/test/radar/x-collector@sha256:' + '9'.repeat(64);
  const fixtureDir = join(root, 'fixtures');
  mkdirSync(fixtureDir);
  const fixture = (name: string, value: unknown) =>
    writeFileSync(join(fixtureDir, name + '.json'), JSON.stringify(value));
  const releases = ['v0.1.0', 'v0.2.0', 'v0.3.0'].map((version, index) => {
    const metadataId = (index + 1) * 100;
    const release = {
      tag_name: version,
      draft: false,
      prerelease: false,
      published_at: `2026-11-0${index + 1}T00:00:00Z`,
      assets: [
        { id: metadataId, name: 'release-metadata.json', state: 'uploaded' },
        ...(index === 2
          ? []
          : [{ id: metadataId + 1, name: 'image-manifest.json', state: 'uploaded' }]),
      ],
    };
    fixture(version, release);
    fixture(String(metadataId), { version, commit: 'c'.repeat(40) });
    fixture(String(metadataId + 1), {
      images: [
        { target: 'api', image: apiDigest, version, commit: 'c'.repeat(40) },
        { target: 'worker', image: workerDigest, version, commit: 'c'.repeat(40) },
      ],
    });
    return release;
  });
  fixture('releases', releases.reverse());
  const withCollector = () => {
    const manifest = JSON.parse(readFileSync(join(fixtureDir, '201.json'), 'utf8'));
    manifest.images = manifest.images.filter(
      (entry: { target: string }) => entry.target !== 'x-collector',
    );
    manifest.images.push({
      target: 'x-collector',
      image: collectorDigest,
      version: 'v0.2.0',
      commit: 'c'.repeat(40),
    });
    fixture('201', manifest);
    return manifest;
  };
  writeFileSync(
    join(root, '.deploy/images/v0.1.0'),
    apiDigest + '\n' + workerDigest + '\n' + 'c'.repeat(40) + '\n',
  );
  writeFileSync(join(root, '.env'), 'TEST_ONLY=true\n');
  writeFileSync(join(root, '.deploy/current'), 'v0.1.0\n');
  const executable = (name: string, body: string) =>
    writeFileSync(join(bin, name), '#!/usr/bin/env bash\nset -eu\n' + body, { mode: 0o755 });
  executable(
    'docker',
    `printf '%s|%s\\n' "\${APP_VERSION:-none}" "$*" >> "$TEST_LOG"
if [[ "$*" == *'config --format json'* ]]; then printf '{"services":{"api":{"image":"ghcr.io/test/radar/api:test"},"worker":{"image":"ghcr.io/test/radar/worker:test"},"x-collector":{"environment":{"X_COLLECTOR_SECRET":"%s"}}}}' "\${X_COLLECTOR_SECRET:-\${CONFIGURED_COLLECTOR_SECRET:-}}"; fi
if [[ "$*" == *'pull api worker'* ]]; then printf 'images:%s|%s\\n' "\${API_IMAGE:-none}" "\${WORKER_IMAGE:-none}" >> "$TEST_LOG"; fi
if [[ "$*" == *'pull api worker x-collector'* ]]; then printf 'collector-image:%s\\n' "\${X_COLLECTOR_IMAGE:-none}" >> "$TEST_LOG"; fi
if [[ "$*" == 'image inspect'* && "$*" == *org.opencontainers.image.version* ]]; then printf '%s' "\${IMAGE_VERSION_OVERRIDE:-$APP_VERSION}";
elif [[ "$*" == 'image inspect'* && "$*" == *org.opencontainers.image.revision* ]]; then if [[ "\${FAIL_REVISION:-false}" == true && "$*" == *'/worker@'* || "\${FAIL_COLLECTOR_REVISION:-false}" == true && "$*" == *'/x-collector@'* || "\${FAIL_ALL_REVISIONS:-false}" == true ]]; then printf 'dddddddddddddddddddddddddddddddddddddddd'; else printf 'cccccccccccccccccccccccccccccccccccccccc'; fi
elif [[ "$*" == 'image inspect'* ]]; then if [[ "$*" == *'/api:'* ]]; then printf 'ghcr.io/test/radar/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; else printf 'ghcr.io/test/radar/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; fi; fi
if [[ "$*" == *dist/migrate.js* ]]; then printf 'migration-commit:%s\\n' "\${COMMIT_SHA:-missing}" >> "$TEST_LOG"; fi
if [[ "$*" == *pg_dump* ]]; then [[ "\${FAIL_BACKUP:-false}" != true ]] || exit 1; printf 'mock-backup-archive'; fi
if [[ "$*" == *'worker node apps/worker/dist/health.js'* && "\${APP_VERSION:-}" == "\${FAIL_VERSION:-none}" ]]; then exit 1; fi
if [[ "$*" == *'up -d --no-deps --wait --wait-timeout 60 x-collector'* && "\${FAIL_COLLECTOR_START:-false}" == true ]]; then exit 1; fi
if [[ "$*" == *'exec -T x-collector python'* && "\${FAIL_COLLECTOR_HEALTH:-false}" == true ]]; then exit 1; fi
if [[ "$*" == *'up -d --no-deps api worker'* ]] && [[ -n "\${X_COLLECTOR_IMAGE:-}" || -f "$DEPLOY_ROOT/.deploy/x-collector.secret" ]]; then
  expected="\${EXPECTED_COLLECTOR_SECRET:-}"
  if [[ -z "$expected" && -f "$DEPLOY_ROOT/.deploy/x-collector.secret" ]]; then expected=$(cat "$DEPLOY_ROOT/.deploy/x-collector.secret"); fi
  [[ -n "$expected" && "\${X_COLLECTOR_SECRET:-}" == "$expected" ]] || exit 1
  printf 'collector-secret:matched\\n' >> "$TEST_LOG"
fi
`,
  );
  executable(
    'curl',
    `printf 'curl:%s\\n' "$*" >> "$TEST_LOG"
if [[ "$*" == *'--config -'* ]]; then cat >/dev/null; printf 'curl-auth:configured\\n' >> "$TEST_LOG"; elif [[ "\${REQUIRE_AUTH:-false}" == true && "$*" == *api.github.com* ]]; then exit 22; fi
url="\${!#}"
if [[ "$url" == *'/releases/assets/'* ]]; then [[ "\${FAIL_ASSET_DOWNLOAD:-false}" != true ]] || exit 22; cat "$TEST_FIXTURES/\${url##*/}.json";
elif [[ "$url" == *'/releases/tags/'* ]]; then cat "$TEST_FIXTURES/\${url##*/}.json";
elif [[ "$url" == *'/releases?'* ]]; then cat "$TEST_FIXTURES/releases.json"; fi
`,
  );
  executable(
    'nginx',
    'printf "nginx:%s\\n" "$*" >> "$TEST_LOG"\n[[ "${FAIL_NGINX:-false}" != true ]]\n',
  );
  executable('systemctl', 'printf "systemctl:%s\\n" "$*" >> "$TEST_LOG"\n');
  executable('sleep', 'exit 0\n');
  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    DEPLOY_ROOT: root,
    BACKUP_DIR: join(root, 'backup'),
    TEST_LOG: join(root, 'calls'),
    TEST_FIXTURES: fixtureDir,
    GITHUB_REPOSITORY: 'test/radar',
    NGINX_RELOAD: 'true',
    X_COLLECTOR_SECRET: '',
    ...extra,
  };
  const run = (script: string, args: string[] = []) =>
    spawnSync('bash', [resolve('infra/scripts/' + script), ...args], {
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
  return {
    root,
    run,
    fixture,
    withCollector,
    collectorDigest,
    log: () => readFileSync(join(root, 'calls'), 'utf8'),
  };
}
describe('deployment application transaction', () => {
  it('deploys and pins all three release images, waiting for the collector before replacing applications', () => {
    const h = harness();
    h.withCollector();
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).toContain('pull api worker x-collector');
    expect(h.log()).toContain('collector-image:' + h.collectorDigest);
    expect(h.log().indexOf('up -d --no-deps --wait --wait-timeout 60 x-collector')).toBeLessThan(
      h.log().indexOf('up -d --no-deps api worker'),
    );
    expect(h.log()).toContain('exec -T x-collector python');
    expect(h.log()).toContain('collector-secret:matched');
    expect(readFileSync(join(h.root, '.deploy/images/v0.2.0'), 'utf8').trim().split('\n')).toEqual([
      'ghcr.io/test/radar/api@sha256:' + 'a'.repeat(64),
      'ghcr.io/test/radar/worker@sha256:' + 'b'.repeat(64),
      'c'.repeat(40),
      h.collectorDigest,
    ]);
  });
  it('creates a private shared secret once and reuses it during deployment and standalone health checks', () => {
    const h = harness();
    h.withCollector();
    const deployed = h.run('deploy.sh', ['v0.2.0']);
    expect(deployed.status, deployed.stderr).toBe(0);
    const secretPath = join(h.root, '.deploy/x-collector.secret');
    const secret = readFileSync(secretPath, 'utf8').trim();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    const redeployed = h.run('deploy.sh', ['v0.2.0']);
    expect(redeployed.status, redeployed.stderr).toBe(0);
    const health = h.run('check-health.sh');
    expect(health.status, health.stderr).toBe(0);
    expect(readFileSync(secretPath, 'utf8').trim()).toBe(secret);
    expect(
      h.log() +
        deployed.stdout +
        deployed.stderr +
        redeployed.stdout +
        redeployed.stderr +
        health.stdout +
        health.stderr,
    ).not.toContain(secret);
  });
  it('preserves an existing configured shared secret without disclosing it', () => {
    const secret = 'synthetic-existing-collector-secret-1234567890';
    const h = harness({ CONFIGURED_COLLECTOR_SECRET: secret, EXPECTED_COLLECTOR_SECRET: secret });
    h.withCollector();
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).toContain('collector-secret:matched');
    expect(h.log() + result.stdout + result.stderr).not.toContain(secret);
  });
  it('refuses a short configured collector secret before backup or migration', () => {
    const h = harness({ CONFIGURED_COLLECTOR_SECRET: 'too-short' });
    h.withCollector();
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('pg_dump');
    expect(h.log()).not.toContain('dist/migrate.js');
    expect(result.stdout + result.stderr).not.toContain('too-short');
  });
  it('retains all three immutable digests if the same release is rebuilt', () => {
    const h = harness();
    h.withCollector();
    const first = h.run('deploy.sh', ['v0.2.0']);
    expect(first.status, first.stderr).toBe(0);
    const statePath = join(h.root, '.deploy/images/v0.2.0');
    const original = readFileSync(statePath, 'utf8');
    const manifest = h.withCollector();
    for (const image of manifest.images)
      image.image = image.image.split('@')[0] + '@sha256:' + 'e'.repeat(64);
    h.fixture('201', manifest);
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).toContain('collector-image:' + h.collectorDigest);
    expect(readFileSync(statePath, 'utf8')).toBe(original);
  });
  it.each(['FAIL_COLLECTOR_START', 'FAIL_COLLECTOR_HEALTH'])(
    'restores the previous applications after %s and retains the verified state',
    (failure) => {
      const h = harness({ [failure]: 'true' });
      h.withCollector();
      const result = h.run('deploy.sh', ['v0.2.0']);
      expect(result.status).not.toBe(0);
      expect(h.log()).toContain(
        'v0.1.0|compose --env-file .env -f docker-compose.yml up -d --no-deps api worker',
      );
      expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
      expect(existsSync(join(h.root, '.deploy/images/v0.2.0'))).toBe(false);
      expect(h.log()).not.toMatch(/down -v|volume rm|TRUNCATE/);
    },
  );
  it('rejects a collector built from a different commit before backup or migration', () => {
    const h = harness({ FAIL_COLLECTOR_REVISION: 'true' });
    h.withCollector();
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('pg_dump');
    expect(h.log()).not.toContain('dist/migrate.js');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
  });
  it.each(['repository', 'commit', 'duplicate-target', 'unknown-target', 'digest'])(
    'refuses a malformed collector receipt (%s) before pulling images',
    (fault) => {
      const h = harness();
      const manifest = h.withCollector();
      const collector = manifest.images[2];
      if (fault === 'repository')
        collector.image = 'ghcr.io/unrelated/radar/x-collector@sha256:' + '9'.repeat(64);
      if (fault === 'commit') collector.commit = 'd'.repeat(40);
      if (fault === 'duplicate-target') collector.target = 'worker';
      if (fault === 'unknown-target') collector.target = 'other-service';
      if (fault === 'digest') collector.image = 'ghcr.io/test/radar/x-collector:latest';
      h.fixture('201', manifest);
      const result = h.run('deploy.sh', ['v0.2.0']);
      expect(result.status).not.toBe(0);
      expect(h.log()).not.toContain('pull api worker');
      expect(h.log()).not.toContain('pg_dump');
    },
  );
  it('rolls back from a three-image release to a previously verified legacy release', () => {
    const h = harness();
    h.withCollector();
    const deployed = h.run('deploy.sh', ['v0.2.0']);
    expect(deployed.status, deployed.stderr).toBe(0);
    const result = h.run('rollback.sh');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
    expect(
      readFileSync(join(h.root, '.deploy/images/v0.1.0'), 'utf8').trim().split('\n'),
    ).toHaveLength(3);
    expect(h.log()).not.toContain('stop x-collector');
  });
  it('restores the saved shared secret during a fresh-process rollback to legacy applications', () => {
    const h = harness();
    const previousState = readFileSync(join(h.root, '.deploy/images/v0.1.0'), 'utf8');
    writeFileSync(join(h.root, '.deploy/images/v0.2.0'), previousState + h.collectorDigest + '\n');
    writeFileSync(join(h.root, '.deploy/current'), 'v0.2.0\n');
    writeFileSync(join(h.root, '.deploy/previous'), 'v0.1.0\n');
    const secret = '8'.repeat(64);
    const secretPath = join(h.root, '.deploy/x-collector.secret');
    writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
    const result = h.run('rollback.sh', ['v0.1.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).toContain(
      'v0.1.0|compose --env-file .env -f docker-compose.yml up -d --no-deps api worker',
    );
    expect(h.log().match(/collector-secret:matched/g)).toHaveLength(1);
    expect(h.log()).not.toContain('up -d --no-deps --wait --wait-timeout 60 x-collector');
    expect(readFileSync(secretPath, 'utf8')).toBe(secret + '\n');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8')).toBe('v0.1.0\n');
    expect(readFileSync(join(h.root, '.deploy/images/v0.1.0'), 'utf8')).toBe(previousState);
    expect(h.log() + result.stdout + result.stderr).not.toContain(secret);
  });
  it('backs up before migration, verifies both services and reloads nginx after syntax validation', () => {
    const h = harness();
    const result = h.run('deploy.sh', ['--version', 'v0.2.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.2.0');
    expect(readFileSync(join(h.root, '.deploy/previous'), 'utf8').trim()).toBe('v0.1.0');
    const log = h.log();
    expect(log.indexOf('pg_dump')).toBeLessThan(log.indexOf('dist/migrate.js'));
    expect(log.indexOf('nginx:-t')).toBeLessThan(log.indexOf('systemctl:reload nginx'));
    expect(log).not.toMatch(/down -v|volume rm|TRUNCATE/);
    expect(existsSync(join(h.root, '.deploy/lock'))).toBe(false);
    expect(readFileSync(join(h.root, '.deploy/images/v0.2.0'), 'utf8').trim().split('\n')[2]).toBe(
      'c'.repeat(40),
    );
    expect(log).toContain('migration-commit:' + 'c'.repeat(40));
  });
  it('rolls back unhealthy application images without reverting database migration', () => {
    const h = harness({ FAIL_VERSION: 'v0.2.0' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).toContain(
      'v0.1.0|compose --env-file .env -f docker-compose.yml up -d --no-deps api worker',
    );
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
    expect(result.stderr).toContain('Database was not rolled back');
    expect(h.log().match(/dist\/migrate.js/g)).toHaveLength(1);
  });
  it('stops before migration when a backup fails', () => {
    const h = harness({ FAIL_BACKUP: 'true' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('dist/migrate.js');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
  });
  it('loads the verified application version for standalone health checks', () => {
    const h = harness();
    const result = h.run('check-health.sh');
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).toContain('v0.1.0|compose');
  });
  it('restores the current application when rollback health validation fails', () => {
    const h = harness({ FAIL_VERSION: 'v0.0.9' });
    writeFileSync(join(h.root, '.deploy/previous'), 'v0.0.9\n');
    writeFileSync(
      join(h.root, '.deploy/images/v0.0.9'),
      readFileSync(join(h.root, '.deploy/images/v0.1.0')),
    );
    const result = h.run('rollback.sh');
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
    expect(h.log()).toContain(
      'v0.1.0|compose --env-file .env -f docker-compose.yml up -d --no-deps api worker',
    );
    expect(h.log()).not.toContain('dist/migrate.js');
  });
  it('refuses rollback to a release without a verified digest record', () => {
    const h = harness();
    const result = h.run('rollback.sh', ['v0.0.1']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('pull api worker');
  });
  it('does not reload nginx after a failed syntax check and restores the verified application', () => {
    const h = harness({ FAIL_NGINX: 'true' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).toContain('nginx:-t');
    expect(h.log()).not.toContain('systemctl:reload nginx');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
  });
  it('retains immutable digests when redeploying the same verified version', () => {
    const h = harness();
    const original = readFileSync(join(h.root, '.deploy/images/v0.1.0'), 'utf8');
    h.fixture('101', {
      images: [
        {
          target: 'api',
          image: 'ghcr.io/test/radar/api@sha256:' + 'e'.repeat(64),
          version: 'v0.1.0',
          commit: 'c'.repeat(40),
        },
        {
          target: 'worker',
          image: 'ghcr.io/test/radar/worker@sha256:' + 'f'.repeat(64),
          version: 'v0.1.0',
          commit: 'c'.repeat(40),
        },
      ],
    });
    const result = h.run('deploy.sh', ['v0.1.0']);
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).not.toContain('RepoDigests');
    expect(h.log()).toContain('images:ghcr.io/test/radar/api@sha256:' + 'a'.repeat(64));
    expect(readFileSync(join(h.root, '.deploy/images/v0.1.0'), 'utf8')).toBe(original);
  });
  it('upgrades legacy two-line digest state using matching image revision labels', () => {
    const h = harness();
    const state = join(h.root, '.deploy/images/v0.1.0');
    writeFileSync(state, readFileSync(state, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
    const result = h.run('check-health.sh');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(state, 'utf8').trim().split('\n')[2]).toBe('c'.repeat(40));
    expect(h.log()).toContain('org.opencontainers.image.revision');
  });
  it('rejects mismatched API/Worker build commits before backup or migration', () => {
    const h = harness({ FAIL_REVISION: 'true' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the Release receipts');
    expect(h.log()).not.toContain('pg_dump');
    expect(h.log()).not.toContain('dist/migrate.js');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
  });
  it('rejects mutable or malformed production versions', () => {
    const h = harness();
    const result = h.run('deploy.sh', ['latest']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('pull api worker');
  });
  it('defaults to the latest completed stable Release and skips the one still building images', () => {
    const h = harness();
    const result = h.run('deploy.sh');
    expect(result.status, result.stderr).toBe(0);
    expect(h.log()).toContain('/releases?per_page=100&page=1');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.2.0');
    expect(h.log()).toContain('images:ghcr.io/test/radar/api@sha256:' + 'a'.repeat(64));
    expect(h.log()).not.toContain('RepoDigests');
  });
  it('refuses an explicitly selected Release that has not published its manifest', () => {
    const h = harness();
    const result = h.run('deploy.sh', ['v0.3.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release publication incomplete');
    expect(h.log()).not.toContain('pull api worker');
  });
  it('does not deploy when no stable Release has completed image publication', () => {
    const h = harness();
    h.fixture('releases', [
      { tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [] },
      {
        tag_name: 'v0.4.0',
        draft: true,
        prerelease: false,
        assets: [
          { id: 400, name: 'release-metadata.json', state: 'uploaded' },
          { id: 401, name: 'image-manifest.json', state: 'uploaded' },
        ],
      },
    ]);
    const result = h.run('deploy.sh');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No stable Release has completed image publication');
    expect(h.log()).not.toContain('pull api worker');
  });
  it('refuses manifest metadata mismatch before pulling or modifying data', () => {
    const h = harness();
    h.fixture('200', { version: 'v0.2.0', commit: 'd'.repeat(40) });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest version/commit/digests are invalid');
    expect(h.log()).not.toContain('pull api worker');
    expect(h.log()).not.toContain('pg_dump');
  });
  it('refuses matching image revisions that belong to a different commit than the Release', () => {
    const h = harness({ FAIL_ALL_REVISIONS: 'true' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the Release receipts');
    expect(h.log()).not.toContain('pg_dump');
  });
  it('refuses a manifest that points outside the configured repository', () => {
    const h = harness();
    const manifest = JSON.parse(readFileSync(join(h.root, 'fixtures/201.json'), 'utf8'));
    manifest.images[0].image = 'ghcr.io/unrelated/project/api@sha256:' + 'a'.repeat(64);
    h.fixture('201', manifest);
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest version/commit/digests are invalid');
    expect(h.log()).not.toContain('pull api worker');
  });
  it('refuses a bare digest without the required repository and image target prefix', () => {
    const h = harness();
    const manifest = JSON.parse(readFileSync(join(h.root, 'fixtures/201.json'), 'utf8'));
    manifest.images[0].image = 'a'.repeat(64);
    h.fixture('201', manifest);
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest version/commit/digests are invalid');
    expect(h.log()).not.toContain('pull api worker');
    expect(h.log()).not.toContain('pg_dump');
  });
  it('refuses image labels with a different version than the selected Release', () => {
    const h = harness({ IMAGE_VERSION_OVERRIDE: 'v9.9.9' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('pg_dump');
  });
  it('refuses saved image state from another source or Release commit', () => {
    const h = harness();
    const state = join(h.root, '.deploy/images/v0.1.0');
    writeFileSync(state, readFileSync(state, 'utf8').replace('c'.repeat(40), 'd'.repeat(40)));
    const result = h.run('deploy.sh', ['v0.1.0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not belong to this Release source/commit');
    expect(h.log()).not.toContain('pull api worker');
  });
  it('authenticates private Release downloads without printing the token', () => {
    const token = 'github_pat_test_only_123';
    const h = harness({ GITHUB_TOKEN: token, REQUIRE_AUTH: 'true' });
    const result = h.run('deploy.sh', ['--latest']);
    expect(result.status, result.stderr).toBe(0);
    expect(h.log().match(/curl-auth:configured/g)?.length).toBeGreaterThanOrEqual(4);
    expect(h.log() + result.stdout + result.stderr).not.toContain(token);
  });
  it('retains the current deployment when private asset download fails', () => {
    const h = harness({ GITHUB_TOKEN: 'github_pat_test_only_123', FAIL_ASSET_DOWNLOAD: 'true' });
    const result = h.run('deploy.sh', ['v0.2.0']);
    expect(result.status).not.toBe(0);
    expect(h.log()).not.toContain('pull api worker');
    expect(readFileSync(join(h.root, '.deploy/current'), 'utf8').trim()).toBe('v0.1.0');
  });
});
