#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_tools
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
task_backup="$BACKUP_DIR/radar-$(date -u +%Y%m%dT%H%M%SZ)-${APP_VERSION:-unknown}-$$.dump"
trap 'rm -f "$task_backup.tmp"' EXIT
# Both dump and archive validation use the same configured PostgreSQL container
# and its trusted POSTGRES_USER/POSTGRES_DB environment, never host defaults.
compose exec -T postgres sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$task_backup.tmp"
[[ -s "$task_backup.tmp" ]] || { echo 'Empty database backup' >&2; exit 1; }
compose exec -T postgres pg_restore --list < "$task_backup.tmp" >/dev/null
mv "$task_backup.tmp" "$task_backup"
if command -v sha256sum >/dev/null; then sha256sum "$task_backup" > "$task_backup.sha256"; else shasum -a 256 "$task_backup" > "$task_backup.sha256"; fi
printf 'Verified backup: %s\n' "$task_backup"
