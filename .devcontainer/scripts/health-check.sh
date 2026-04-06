#!/bin/bash
# Service readiness checker. Tests connectivity to services on cht-net.
#
# Usage:
#   ./health-check.sh              # Check all services for current phase
#   ./health-check.sh couchdb      # Check specific service
#   ./health-check.sh --wait       # Poll until all current-phase services are ready

set -euo pipefail

BASE_DIR="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}/.devcontainer"
PHASE_FILE="$BASE_DIR/.current-phase"
CURRENT_PHASE=$(cat "$PHASE_FILE" 2>/dev/null || echo "0")
WAIT_MODE=false

if [ "${1:-}" = "--wait" ]; then
  WAIT_MODE=true
  shift
fi

check_couchdb() {
  curl -sf http://${COUCHDB_USER:-admin}:${COUCHDB_PASSWORD:-secret}@couchdb:5984/ > /dev/null 2>&1
}

check_api() {
  curl -sf http://api:5988/api/info > /dev/null 2>&1
}

check_haproxy() {
  curl -sf http://${COUCHDB_USER:-admin}:${COUCHDB_PASSWORD:-secret}@haproxy:5984/ > /dev/null 2>&1
}

check_postgres() {
  pg_isready -h postgres -U ${POSTGRES_USER:-cht} -d cht > /dev/null 2>&1
}

check_powersync() {
  curl -sf http://powersync:8080/api/admin/v1/diagnostics > /dev/null 2>&1
}

run_check() {
  local service=$1
  if "check_$service" 2>/dev/null; then
    echo "[OK] $service"
    return 0
  else
    echo "[FAIL] $service"
    return 1
  fi
}

# Determine which services to check
if [ $# -gt 0 ] && [ "$1" != "--wait" ]; then
  SERVICES=("$@")
else
  SERVICES=("couchdb")
  [ "$CURRENT_PHASE" -ge 1 ] && SERVICES+=("haproxy" "api")
  [ "$CURRENT_PHASE" -ge 2 ] && SERVICES+=("postgres")
  [ "$CURRENT_PHASE" -ge 3 ] && SERVICES+=("powersync")
fi

if $WAIT_MODE; then
  echo "Waiting for services: ${SERVICES[*]}"
  MAX_RETRIES=60
  RETRY=0
  while [ $RETRY -lt $MAX_RETRIES ]; do
    ALL_OK=true
    for svc in "${SERVICES[@]}"; do
      if ! "check_$svc" 2>/dev/null; then
        ALL_OK=false
        break
      fi
    done
    if $ALL_OK; then
      echo "All services ready."
      for svc in "${SERVICES[@]}"; do run_check "$svc"; done
      exit 0
    fi
    RETRY=$((RETRY + 1))
    echo "Retry $RETRY/$MAX_RETRIES..."
    sleep 5
  done
  echo "Timed out waiting for services."
  for svc in "${SERVICES[@]}"; do run_check "$svc" || true; done
  exit 1
else
  FAILED=0
  for svc in "${SERVICES[@]}"; do
    run_check "$svc" || FAILED=$((FAILED + 1))
  done
  exit $FAILED
fi
