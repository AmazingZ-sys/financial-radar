#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
if [[ -f "$DEPLOY_ROOT/deploy.env" ]]; then
  # This is executable shell configuration, owned and writable only by the operator.
  # shellcheck disable=SC1091
  source "$DEPLOY_ROOT/deploy.env"
fi
cd "$DEPLOY_ROOT"
export APP_ENV_FILE="${APP_ENV_FILE:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_ROOT/backups}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:13000/ready}"
STATE_DIR="$DEPLOY_ROOT/.deploy"
umask 077
mkdir -p "$STATE_DIR/images"
chmod 700 "$STATE_DIR" "$STATE_DIR/images"
validate_version() { [[ "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Expected explicit stable release vX.Y.Z' >&2; return 1; }; }
resolve_image_commit() {
  local task_api_commit task_worker_commit
  task_api_commit=$(docker image inspect "$API_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  task_worker_commit=$(docker image inspect "$WORKER_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [[ "$task_api_commit" =~ ^[a-f0-9]{40}$ && "$task_worker_commit" == "$task_api_commit" ]] || { echo 'API/Worker image revisions must match one full Git commit SHA' >&2; return 1; }
  export COMMIT_SHA="$task_api_commit"
}
load_version() {
  validate_version "$1"
  export APP_VERSION="$1"
  unset API_IMAGE WORKER_IMAGE X_COLLECTOR_IMAGE COMMIT_SHA
  if [[ -f "$STATE_DIR/images/$1" ]]; then
    API_IMAGE=$(sed -n '1p' "$STATE_DIR/images/$1")
    WORKER_IMAGE=$(sed -n '2p' "$STATE_DIR/images/$1")
    [[ "$API_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ && "$WORKER_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid saved image digest' >&2; exit 1; }
    export API_IMAGE WORKER_IMAGE
    COMMIT_SHA=$(sed -n '3p' "$STATE_DIR/images/$1")
    if [[ -z "$COMMIT_SHA" ]]; then
      # Upgrade a legacy two-line record from the immutable locally pulled images.
      # Never accept a bootstrap .env value as the deployed build revision.
      resolve_image_commit
      printf '%s\n%s\n%s\n' "$API_IMAGE" "$WORKER_IMAGE" "$COMMIT_SHA" > "$STATE_DIR/images/$1.$$.tmp"
      mv "$STATE_DIR/images/$1.$$.tmp" "$STATE_DIR/images/$1"
    fi
    [[ "$COMMIT_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid saved image revision' >&2; exit 1; }
    export COMMIT_SHA
    X_COLLECTOR_IMAGE=$(sed -n '4p' "$STATE_DIR/images/$1")
    if [[ -n "$X_COLLECTOR_IMAGE" ]]; then
      [[ "$X_COLLECTOR_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+/x-collector@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid saved collector image digest' >&2; exit 1; }
      export X_COLLECTOR_IMAGE
    fi
  fi
}
# Health, backups and subsequent deployments use the last verified version even
# when the operator's .env still contains an earlier bootstrap APP_VERSION.
if [[ -z "${APP_VERSION:-}" && -f "$STATE_DIR/current" ]]; then load_version "$(cat "$STATE_DIR/current")"; fi
compose() {
  local task_files=(-f "$COMPOSE_FILE")
  [[ -z "${COMPOSE_OVERRIDE_FILE:-}" ]] || task_files+=(-f "$COMPOSE_OVERRIDE_FILE")
  docker compose --env-file "$APP_ENV_FILE" "${task_files[@]}" "$@"
}
require_tools() {
  for task_tool in docker curl jq; do command -v "$task_tool" >/dev/null || { echo "Missing $task_tool" >&2; exit 1; }; done
  docker compose version >/dev/null
  docker info >/dev/null
  [[ -f "$APP_ENV_FILE" ]] || { echo 'Missing application env file' >&2; exit 1; }
}
acquire_lock() { mkdir "$STATE_DIR/lock" 2>/dev/null || { echo 'Deployment lock exists; inspect existing process before removing .deploy/lock' >&2; exit 1; }; trap 'rmdir "$STATE_DIR/lock"' EXIT; }
release_services() {
  RELEASE_SERVICES=(api worker)
  [[ -z "${X_COLLECTOR_IMAGE:-}" ]] || RELEASE_SERVICES+=(x-collector)
}
prepare_x_collector() {
  local task_secret task_secret_file="$STATE_DIR/x-collector.secret"
  # A rollback to an older API/Worker may still use the retained collector.
  [[ -n "${X_COLLECTOR_IMAGE:-}" || -f "$task_secret_file" ]] || return 0
  # Never print resolved Compose configuration: it contains server credentials.
  task_secret=$(compose config --format json | jq -er '.services["x-collector"].environment.X_COLLECTOR_SECRET // "" | select(type=="string")') || return 1
  if [[ -z "$task_secret" ]]; then
    if [[ ! -f "$task_secret_file" ]]; then
      task_secret=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n') || return 1
      [[ "$task_secret" =~ ^[a-f0-9]{64}$ ]] || return 1
      printf '%s\n' "$task_secret" > "$task_secret_file.$$.tmp" || return 1
      chmod 600 "$task_secret_file.$$.tmp" || return 1
      mv "$task_secret_file.$$.tmp" "$task_secret_file" || return 1
    fi
    chmod 600 "$task_secret_file" || return 1
    task_secret=$(cat "$task_secret_file") || return 1
  fi
  [[ ${#task_secret} -ge 32 && ${#task_secret} -le 512 && ! "$task_secret" =~ [[:space:]] ]] || { echo 'Invalid collector shared secret; expected 32-512 characters without whitespace' >&2; return 1; }
  export X_COLLECTOR_SECRET="$task_secret"
}
collector_healthy() {
  [[ -z "${X_COLLECTOR_IMAGE:-}" ]] || compose exec -T x-collector python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2)" >/dev/null 2>&1
}
start_release_services() {
  prepare_x_collector || return 1
  if [[ -n "${X_COLLECTOR_IMAGE:-}" ]]; then
    compose up -d --no-deps --wait --wait-timeout 60 x-collector || return 1
  fi
  compose up -d --no-deps api worker && wait_healthy
}
wait_healthy() {
  for ((task_attempt=1;task_attempt<=45;task_attempt++)); do
    if curl --silent --fail --max-time 5 "$HEALTH_URL" >/dev/null && compose exec -T worker node apps/worker/dist/health.js >/dev/null 2>&1 && collector_healthy; then return 0; fi
    sleep 2
  done
  echo 'Release service readiness failed' >&2
  return 1
}
reload_nginx() {
  [[ "${NGINX_RELOAD:-false}" == true ]] || return 0
  command -v nginx >/dev/null && command -v systemctl >/dev/null && nginx -t && systemctl reload nginx
}
github_request() {
  local task_path="$1" task_accept="${2:-application/vnd.github+json}" task_max_size="${3:-16777216}"
  local task_repository="${GITHUB_REPOSITORY:-AmazingZ-sys/financial-radar}"
  [[ "$task_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid GITHUB_REPOSITORY' >&2; return 1; }
  local task_url="https://api.github.com/repos/$task_repository/$task_path"
  local task_options=(--fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-redirs 3 --connect-timeout 10 --max-time 30 --max-filesize "$task_max_size" -H "Accept: $task_accept")
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    [[ "$GITHUB_TOKEN" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Invalid GitHub token format' >&2; return 1; }
    # Feed authentication through stdin rather than command arguments or logs.
    # curl strips Authorization on cross-host redirects (no --location-trusted).
    printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" | curl "${task_options[@]}" --config - "$task_url"
  else
    curl "${task_options[@]}" "$task_url"
  fi
}
release_json() { github_request "releases/$1"; }
release_asset() {
  local task_release="$1" task_name="$2" task_asset_id
  task_asset_id=$(jq -er --arg name "$task_name" '[.assets[]? | select(.name==$name and .state=="uploaded")] | select(length==1) | .[0].id | select(type=="number" and .>0 and floor==.)' <<< "$task_release") || { echo "Release publication incomplete: missing $task_name" >&2; return 1; }
  github_request "releases/assets/$task_asset_id" application/octet-stream 1048576
}
latest_ready_release() {
  local task_page task_releases task_candidate
  # GitHub lists releases newest first. Skip drafts, prereleases and releases
  # whose image job has not attached both publication receipts yet.
  for ((task_page=1;task_page<=10;task_page++)); do
    task_releases=$(github_request "releases?per_page=100&page=$task_page") || return 1
    jq -e 'type=="array"' >/dev/null <<< "$task_releases" || return 1
    task_candidate=$(jq -r '[.[] | select(.draft==false and .prerelease==false) | select(.tag_name | test("^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")) | select(([.assets[]? | select(.state=="uploaded" and .name=="image-manifest.json")] | length)==1 and ([.assets[]? | select(.state=="uploaded" and .name=="release-metadata.json")] | length)==1)] | sort_by(.published_at,.created_at) | reverse | .[0].tag_name // empty' <<< "$task_releases")
    if [[ -n "$task_candidate" ]]; then printf '%s\n' "$task_candidate"; return 0; fi
    [[ $(jq 'length' <<< "$task_releases") == 100 ]] || break
  done
  echo 'No stable Release has completed image publication yet' >&2
  return 1
}
load_release_images() {
  local task_version="$1" task_release task_metadata task_manifest task_commit task_repository task_api task_worker task_collector
  task_release=$(release_json "tags/$task_version") || return 1
  jq -e --arg version "$task_version" 'select(.tag_name==$version and .draft==false and .prerelease==false)' >/dev/null <<< "$task_release" || { echo 'Expected a published stable Release' >&2; return 1; }
  task_metadata=$(release_asset "$task_release" release-metadata.json) || return 1
  task_manifest=$(release_asset "$task_release" image-manifest.json) || return 1
  task_commit=$(jq -er --arg version "$task_version" 'select(.version==$version) | .commit | select(type=="string" and test("^[a-f0-9]{40}$"))' <<< "$task_metadata") || { echo 'Release metadata version/commit is invalid' >&2; return 1; }
  task_repository=$(printf '%s' "${GITHUB_REPOSITORY:-AmazingZ-sys/financial-radar}" | tr '[:upper:]' '[:lower:]')
  jq -e --arg version "$task_version" --arg commit "$task_commit" --arg repository "ghcr.io/$task_repository" '
    .images | select(type=="array" and (length==2 or length==3)) |
    select(([.[].target] | sort)==["api","worker"] or ([.[].target] | sort)==["api","worker","x-collector"]) |
    select(all(.[]; . as $image | .version==$version and .commit==$commit and
      (.image | type)=="string" and
      (.image | startswith($repository+"/"+$image.target+"@sha256:")) and
      (.image | ltrimstr($repository+"/"+$image.target+"@sha256:") | test("^[a-f0-9]{64}$"))))
  ' >/dev/null <<< "$task_manifest" || { echo 'Release image manifest version/commit/digests are invalid' >&2; return 1; }
  task_api=$(jq -r '.images[] | select(.target=="api") | .image' <<< "$task_manifest")
  task_worker=$(jq -r '.images[] | select(.target=="worker") | .image' <<< "$task_manifest")
  task_collector=$(jq -r '.images[] | select(.target=="x-collector") | .image' <<< "$task_manifest")
  if [[ -n "${API_IMAGE:-}" ]]; then
    # Keep an already verified version pinned even if a publication retry rebuilt
    # that version. Its original receipt must still identify this source/commit.
    [[ "$COMMIT_SHA" == "$task_commit" && "${API_IMAGE%@sha256:*}" == "${task_api%@sha256:*}" && "${WORKER_IMAGE%@sha256:*}" == "${task_worker%@sha256:*}" ]] || { echo 'Saved image state does not belong to this Release source/commit' >&2; return 1; }
    if [[ -n "${X_COLLECTOR_IMAGE:-}" ]]; then
      [[ -n "$task_collector" && "${X_COLLECTOR_IMAGE%@sha256:*}" == "${task_collector%@sha256:*}" ]] || { echo 'Saved collector image does not belong to this Release source/commit' >&2; return 1; }
    elif [[ -n "$task_collector" ]]; then
      export X_COLLECTOR_IMAGE="$task_collector"
    fi
  else
    export API_IMAGE="$task_api" WORKER_IMAGE="$task_worker" COMMIT_SHA="$task_commit"
    [[ -z "$task_collector" ]] || export X_COLLECTOR_IMAGE="$task_collector"
  fi
}
verify_release_image_labels() {
  local task_image task_commit task_version
  local task_images=("$API_IMAGE" "$WORKER_IMAGE")
  [[ -z "${X_COLLECTOR_IMAGE:-}" ]] || task_images+=("$X_COLLECTOR_IMAGE")
  for task_image in "${task_images[@]}"; do
    task_commit=$(docker image inspect "$task_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') || return 1
    task_version=$(docker image inspect "$task_image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}') || return 1
    [[ "$task_commit" == "$COMMIT_SHA" && "$task_version" == "$APP_VERSION" ]] || { echo 'Pulled image revision/version does not match the Release receipts' >&2; return 1; }
  done
}
registry_login() {
  if [[ -n "${GHCR_TOKEN:-}" ]]; then printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:?Set GHCR_USER}" --password-stdin; fi
}
save_state() {
  local task_version="$1" task_old="${2:-}"
  [[ "${COMMIT_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { echo 'A verified image commit is required before saving state' >&2; return 1; }
  printf '%s\n%s\n%s\n' "$API_IMAGE" "$WORKER_IMAGE" "$COMMIT_SHA" > "$STATE_DIR/images/$task_version.tmp"
  [[ -z "${X_COLLECTOR_IMAGE:-}" ]] || printf '%s\n' "$X_COLLECTOR_IMAGE" >> "$STATE_DIR/images/$task_version.tmp"
  mv "$STATE_DIR/images/$task_version.tmp" "$STATE_DIR/images/$task_version"
  if [[ -n "$task_old" && "$task_old" != "$task_version" ]]; then printf '%s\n' "$task_old" > "$STATE_DIR/previous.tmp"; mv "$STATE_DIR/previous.tmp" "$STATE_DIR/previous"; fi
  printf '%s\n' "$task_version" > "$STATE_DIR/current.tmp"
  mv "$STATE_DIR/current.tmp" "$STATE_DIR/current"
}
