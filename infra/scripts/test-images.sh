#!/usr/bin/env bash
# Backward-compatible entry point. The acceptance test now uses an isolated
# production Compose project instead of Linux-only host networking.
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/test-compose.sh" "$@"
