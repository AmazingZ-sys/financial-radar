#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_tools
acquire_lock
task_archive="${1:?Usage: restore.sh /absolute/backup.dump NEW_DATABASE_NAME}"
task_database="${2:?Restore requires an explicit new database name}"
[[ "$task_archive" == /* && -s "$task_archive" ]] || { echo 'An absolute nonempty backup archive is required' >&2; exit 1; }
[[ "$task_database" =~ ^[A-Za-z][A-Za-z0-9_]{0,62}$ ]] || { echo 'Invalid new database name' >&2; exit 1; }
[[ -f "$task_archive.sha256" ]] || { echo 'Backup checksum file is required' >&2; exit 1; }
if command -v sha256sum >/dev/null; then sha256sum --check "$task_archive.sha256" >/dev/null; else shasum -a 256 --check "$task_archive.sha256" >/dev/null; fi
compose exec -T postgres pg_restore --list < "$task_archive" >/dev/null
# createdb refuses an existing database. In particular this never drops, cleans or
# overwrites the live database. The operator validates and switches URLs later.
compose exec -T -e "RESTORE_DATABASE=$task_database" postgres sh -ec '
  test "$RESTORE_DATABASE" != "$POSTGRES_DB" || { echo "Refusing live database restore" >&2; exit 1; }
  createdb -U "$POSTGRES_USER" "$RESTORE_DATABASE"
  pg_restore -U "$POSTGRES_USER" --dbname "$RESTORE_DATABASE" --no-owner --exit-on-error
' < "$task_archive"
printf 'Restored into new database %s. Application connection settings were not changed.\n' "$task_database"
