#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_tools
acquire_lock
task_version="${1:---latest}"
if [[ "$task_version" == '--version' ]]; then task_version="${2:-}"; fi
if [[ "$task_version" == '--latest' ]]; then task_version=$(latest_ready_release); fi
validate_version "$task_version"
task_previous=""
if [[ -f "$STATE_DIR/current" ]]; then task_previous=$(cat "$STATE_DIR/current"); validate_version "$task_previous"; fi
# Receipts bind immutable image digests to the selected Release version/commit.
load_version "$task_version"
load_release_images "$task_version"
registry_login
compose config --quiet
release_services
compose pull "${RELEASE_SERVICES[@]}"
verify_release_image_labels
prepare_x_collector
compose config --quiet
# Dependencies are safe to start, but their data volumes are never removed.
compose up -d --wait postgres redis
"$SCRIPT_DIR/backup.sh"
compose run --rm --no-deps api node apps/api/dist/migrate.js
# Migration failure exits before replacing services; a successful migration remains
# compatible with the previous application. No automatic database restoration.
deployment_failed() {
  if [[ -n "$task_previous" ]]; then
    load_version "$task_previous"
    if ! start_release_services; then echo 'Rollback also requires operator attention' >&2; fi
  else
    # No verified first-install version exists. Stop the failed applications and
    # retain PostgreSQL/Redis and all data for diagnosis.
    compose stop "${RELEASE_SERVICES[@]}" || true
  fi
  echo 'Deployment failed. Database was not rolled back.' >&2
  exit 1
}
if ! start_release_services; then deployment_failed; fi
if ! reload_nginx; then deployment_failed; fi
save_state "$task_version" "$task_previous"
printf 'Deployed and verified %s with immutable release image digests. Database migration retained.\n' "$task_version"
