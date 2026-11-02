#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_tools
acquire_lock
task_version="${1:-}"
[[ -n "$task_version" || ! -f "$STATE_DIR/previous" ]] || task_version=$(cat "$STATE_DIR/previous")
validate_version "$task_version"
task_current=""
[[ ! -f "$STATE_DIR/current" ]] || task_current=$(cat "$STATE_DIR/current")
# Automatic rollback is limited to a release this host has actually verified.
# Database compatibility still requires expand/contract migrations.
[[ -f "$STATE_DIR/images/$task_version" ]] || { echo 'No verified immutable image record for this rollback version' >&2; exit 1; }
load_version "$task_version"
registry_login
compose config --quiet
compose pull api worker
rollback_failed() {
  if [[ -n "$task_current" && "$task_current" != "$task_version" ]]; then load_version "$task_current"; compose up -d --no-deps api worker && wait_healthy || echo 'Restoring current version also failed; operator action required' >&2; fi
  echo 'Rollback failed; verified deployment state retained. Database unchanged.' >&2
  exit 1
}
if ! { compose up -d --no-deps api worker && wait_healthy; }; then rollback_failed; fi
if ! reload_nginx; then rollback_failed; fi
save_state "$task_version" "$task_current"
printf 'Application rolled back to verified %s; database unchanged.\n' "$task_version"
