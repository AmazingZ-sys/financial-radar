#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
require_tools
wait_healthy
compose ps
printf 'Release services are healthy.\n'
