#!/usr/bin/env bash
set -euo pipefail
command -v nginx >/dev/null || { echo 'Install Nginx on the host first' >&2; exit 1; }
nginx -t
