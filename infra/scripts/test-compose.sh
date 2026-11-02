#!/usr/bin/env bash
# Creates and destroys only a unique acceptance project. Never targets a user's
# deployment project or volumes. No host-network dependency and no host ports.
set -euo pipefail
TASK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$TASK_REPO_ROOT"
for task_tool in docker node jq; do command -v "$task_tool" >/dev/null || { echo "Missing $task_tool" >&2; exit 1; }; done
docker info >/dev/null
umask 077
mkdir -p .local/docker-acceptance
task_run_id="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
export COMPOSE_PROJECT_NAME="radar-acceptance-$task_run_id"
export DEPLOY_ROOT="$TASK_REPO_ROOT/.local/docker-acceptance/$COMPOSE_PROJECT_NAME"
mkdir -p "$DEPLOY_ROOT"
export APP_ENV_FILE="$DEPLOY_ROOT/application.env"
export COMPOSE_FILE="$TASK_REPO_ROOT/docker-compose.yml"
export COMPOSE_OVERRIDE_FILE="$DEPLOY_ROOT/override.yml"
export APP_VERSION=v0.1.0
export COMMIT_SHA="${TEST_COMMIT_SHA:-$(git rev-parse HEAD)}"
export API_IMAGE="${TEST_API_IMAGE:-financial-radar-api:$COMPOSE_PROJECT_NAME}"
export WORKER_IMAGE="${TEST_WORKER_IMAGE:-financial-radar-worker:$COMPOSE_PROJECT_NAME}"
export BACKUP_DIR="$DEPLOY_ROOT/backups"
export NGINX_RELOAD=false
# Exclude unrelated host env / URLs by supplying authoritative test config.
node --input-type=module <<'JS'
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const pg='Pg-@:/%#'+randomBytes(20).toString('hex');
const redis='Redis-@:/%#'+randomBytes(20).toString('hex');
const env={NODE_ENV:'production',DATA_MODE:'fixture',PORT:'3000',ADMIN_EMAIL:'acceptance@radar.local',ADMIN_PASSWORD:randomBytes(24).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex'),SECURE_COOKIE:'true',COOKIE_SAME_SITE:'Lax',WEB_ORIGIN:'https://acceptance.invalid',POSTGRES_USER:'radar_acceptance',POSTGRES_DB:'radar',POSTGRES_PASSWORD:pg,REDIS_PASSWORD:redis,DATABASE_URL:`postgresql://radar_acceptance:${encodeURIComponent(pg)}@postgres:5432/radar`,REDIS_URL:`redis://:${encodeURIComponent(redis)}@redis:6379`,APP_VERSION:process.env.APP_VERSION,COMMIT_SHA:process.env.COMMIT_SHA,POLL_INTERVAL_SECONDS:'30',LOG_LEVEL:'info'};
writeFileSync(process.env.APP_ENV_FILE,Object.entries(env).map(([k,v])=>`${k}='${v}'`).join('\n')+'\n',{mode:0o600});
writeFileSync(process.env.COMPOSE_OVERRIDE_FILE,'services:\n  api:\n    ports: !reset []\n',{mode:0o600});
JS
# Compose's process environment overrides --env-file; explicitly remove unrelated
# host database/password values so the random isolated credentials are used.
unset DATABASE_URL REDIS_URL POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD REDIS_PASSWORD
compose_test() { docker compose --env-file "$APP_ENV_FILE" -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE_FILE" "$@"; }
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]] || { echo 'Acceptance project collision' >&2; exit 1; }
task_started=false
task_images_built=false
cleanup() {
  local task_exit=$?
  if [[ "$task_started" == true ]]; then
    compose_test logs --no-color > "$DEPLOY_ROOT/compose.log" 2>&1 || true
    compose_test ps --format json > "$DEPLOY_ROOT/final-services.json" 2>/dev/null || true
    # This exact unique project was created by this invocation; ordinary user
    # deployment scripts never remove their PostgreSQL or Redis data volumes.
    if ! compose_test down --volumes --remove-orphans > "$DEPLOY_ROOT/cleanup.log" 2>&1; then
      task_exit=1
      echo 'Acceptance cleanup failed; retain the temporary configuration for targeted operator cleanup.' >&2
    fi
  fi
  if [[ "$task_images_built" == true ]]; then docker image rm "$API_IMAGE" "$WORKER_IMAGE" >> "$DEPLOY_ROOT/cleanup.log" 2>&1 || task_exit=1; fi
  if [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" && -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]]; then rm -f "$APP_ENV_FILE"; else task_exit=1; fi
  if [[ "$task_exit" != 0 ]]; then printf 'Container acceptance failed; inspect %s\n' "$DEPLOY_ROOT" >&2; fi
  exit "$task_exit"
}
trap cleanup EXIT
if [[ "${TEST_SKIP_BUILD:-false}" != true ]]; then
  task_images_built=true
  docker build -f infra/docker/Dockerfile --target api --build-arg "APP_VERSION=$APP_VERSION" --build-arg "COMMIT_SHA=$COMMIT_SHA" -t "$API_IMAGE" . > "$DEPLOY_ROOT/build-api.log" 2>&1
  docker build -f infra/docker/Dockerfile --target worker --build-arg "APP_VERSION=$APP_VERSION" --build-arg "COMMIT_SHA=$COMMIT_SHA" -t "$WORKER_IMAGE" . > "$DEPLOY_ROOT/build-worker.log" 2>&1
fi
compose_test config --quiet
task_started=true
printf 'Starting isolated PostgreSQL and Redis (%s).\n' "$COMPOSE_PROJECT_NAME"
compose_test up -d --wait --wait-timeout 180 postgres redis > "$DEPLOY_ROOT/start-dependencies.log" 2>&1
for task_migration in 1 2; do compose_test run --rm --no-deps api node apps/api/dist/migrate.js > "$DEPLOY_ROOT/migration-$task_migration.log" 2>&1; done
printf 'Migrations applied twice. Running Fixture pipeline.\n'
compose_test run --rm --no-deps worker node apps/worker/dist/index.js --once > "$DEPLOY_ROOT/worker-once.log" 2>&1
counts() { compose_test exec -T postgres sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT (SELECT count(*) FROM raw_items),(SELECT count(*) FROM events),(SELECT count(*) FROM projects),(SELECT count(*) FROM opportunity_signals),(SELECT count(*) FROM _radar_migrations);"'; }
task_before=$(counts)
[[ "$task_before" =~ ^[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*$ ]] || { echo 'Expected persisted Fixture facts and migration state' >&2; exit 1; }
compose_test run --rm --no-deps worker node apps/worker/dist/index.js --once > "$DEPLOY_ROOT/worker-twice.log" 2>&1
[[ "$(counts)" == "$task_before" ]] || { echo 'Duplicate ingestion created extra facts' >&2; exit 1; }
compose_test up -d --wait --wait-timeout 180 api worker > "$DEPLOY_ROOT/start-applications.log" 2>&1
compose_test exec -T api node -e "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
compose_test exec -T worker node apps/worker/dist/health.js
compose_test exec -T api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3000';
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.WEB_ORIGIN},body:JSON.stringify({email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD})});
assert.equal(login.status,200);
const cookie=login.headers.get('set-cookie');assert(cookie?.includes('HttpOnly'));assert(cookie?.includes('Secure'));
const auth=await login.json();const headers={Cookie:cookie.split(';')[0],Origin:process.env.WEB_ORIGIN,'X-CSRF-Token':auth.data.csrfToken,'Content-Type':'application/json'};
for(const route of ['/events','/projects','/sources','/dashboard','/system/status']){const result=await fetch(base+'/api/v1'+route,{headers});assert.equal(result.status,200,route);const payload=await result.json();if(Array.isArray(payload.data))assert(payload.data.length>0,route);else assert.equal(payload.data.dataMode,'fixture');}
const test=await fetch(base+'/api/v1/alert-rules/test',{method:'POST',headers,body:JSON.stringify({conditions:{minConfidence:0}})});assert.equal(test.status,200);
console.info('Production administrator session, Secure/HttpOnly cookie, CSRF and protected data APIs passed.');
JS
[[ "$(compose_test exec -T api id -u)" != 0 && "$(compose_test exec -T worker id -u)" != 0 ]] || { echo 'Application containers must run without root' >&2; exit 1; }
printf 'All four services healthy; verifying PostgreSQL/Redis container replacement retains volumes.\n'
# Record an explicit Redis durability marker; AOF appendfsync everysec needs a
# bounded drain before replacing only this project's dependency containers.
compose_test exec -T redis redis-cli SET acceptance:persistent-marker retained >/dev/null
compose_test exec -T redis redis-cli WAIT 0 0 >/dev/null
sleep 2
compose_test stop api worker > "$DEPLOY_ROOT/stop-applications.log" 2>&1
compose_test up -d --force-recreate --wait --wait-timeout 180 postgres redis > "$DEPLOY_ROOT/recreate-dependencies.log" 2>&1
[[ "$(counts)" == "$task_before" ]] || { echo 'PostgreSQL facts lost after container replacement' >&2; exit 1; }
[[ "$(compose_test exec -T redis redis-cli GET acceptance:persistent-marker | tr -d '\r')" == retained ]] || { echo 'Redis AOF marker lost after container replacement' >&2; exit 1; }
compose_test up -d --wait --wait-timeout 180 api worker > "$DEPLOY_ROOT/restart-applications.log" 2>&1
printf 'Persistence verified. Exercising the production backup/restore scripts.\n'
bash "$TASK_REPO_ROOT/infra/scripts/backup.sh" > "$DEPLOY_ROOT/backup.log" 2>&1
task_archives=("$BACKUP_DIR"/*.dump)
task_archive="${task_archives[0]}"
[[ -f "$task_archive" ]] || { echo 'No backup archive produced' >&2; exit 1; }
bash "$TASK_REPO_ROOT/infra/scripts/restore.sh" "$task_archive" radar_restore_acceptance > "$DEPLOY_ROOT/restore.log" 2>&1
task_restored=$(compose_test exec -T postgres sh -ec 'psql -U "$POSTGRES_USER" -d radar_restore_acceptance -Atc "SELECT (SELECT count(*) FROM raw_items),(SELECT count(*) FROM events),(SELECT count(*) FROM projects),(SELECT count(*) FROM opportunity_signals),(SELECT count(*) FROM _radar_migrations);"')
[[ "$task_restored" == "$task_before" ]] || { echo 'Restored database facts differ from backup' >&2; exit 1; }
compose_test ps --format json > "$DEPLOY_ROOT/services.json"
jq -s -e '(if length==1 and (.[0]|type)=="array" then .[0] else . end) | length==4 and all(.[]; .Health=="healthy")' "$DEPLOY_ROOT/services.json" >/dev/null
jq -n --arg project "$COMPOSE_PROJECT_NAME" --arg counts "$task_before" --arg commit "$COMMIT_SHA" '{project:$project,commit:$commit,counts:$counts,mode:"fixture",migrationsTwice:true,idempotency:true,fourServicesHealthy:true,productionSessionAndCsrf:true,nonRootApplications:true,postgresContainerReplacement:true,redisAofPersistence:true,backupRestoredToNewDatabase:true,cleanup:"only this unique project and volumes"}' > "$DEPLOY_ROOT/result.json"
printf 'Docker Compose acceptance passed. Evidence: %s/result.json\n' "$DEPLOY_ROOT"
