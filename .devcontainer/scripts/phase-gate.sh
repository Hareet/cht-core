#!/bin/bash
# Human intervention gate for phase transitions.
# Agents call this to check/wait for a phase. Humans call this to approve.
#
# Usage:
#   ./phase-gate.sh check <phase>     # Check if phase is active (exit 0/1)
#   ./phase-gate.sh wait <phase>      # Block until phase is approved
#   ./phase-gate.sh approve <phase>   # Approve a phase transition
#   ./phase-gate.sh status            # Show current phase

set -euo pipefail

BASE_DIR="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}/.devcontainer"
PHASE_FILE="$BASE_DIR/.current-phase"
GATE_DIR="$BASE_DIR/.gates"

mkdir -p "$GATE_DIR"

get_current_phase() {
  cat "$PHASE_FILE" 2>/dev/null || echo "0"
}

case "${1:-status}" in
  check)
    CURRENT=$(get_current_phase)
    TARGET=${2:?Usage: phase-gate.sh check <phase>}
    if [ "$CURRENT" -ge "$TARGET" ]; then
      echo "Phase $TARGET is active (current: $CURRENT)"
      exit 0
    else
      echo "Phase $TARGET not yet active (current: $CURRENT)"
      exit 1
    fi
    ;;

  wait)
    TARGET=${2:?Usage: phase-gate.sh wait <phase>}
    echo "Waiting for phase $TARGET approval..."
    echo "Human: run './scripts/phase-gate.sh approve $TARGET' to proceed"
    while true; do
      CURRENT=$(get_current_phase)
      if [ "$CURRENT" -ge "$TARGET" ]; then
        echo "Phase $TARGET is now active."
        exit 0
      fi
      sleep 5
    done
    ;;

  approve)
    TARGET=${2:?Usage: phase-gate.sh approve <phase>}
    CURRENT=$(get_current_phase)

    if [ "$CURRENT" -ge "$TARGET" ]; then
      echo "Phase $TARGET already approved (current: $CURRENT)"
      exit 0
    fi

    # Validate phase ordering
    EXPECTED=$((CURRENT + 1))
    if [ "$TARGET" -ne "$EXPECTED" ]; then
      echo "WARNING: Approving phase $TARGET but current is $CURRENT (expected $EXPECTED)"
      read -p "Continue anyway? (y/N) " -n 1 -r
      echo
      if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
      fi
    fi

    echo "$TARGET" > "$PHASE_FILE"
    echo "Phase $TARGET approved and activated."
    echo ""

    case "$TARGET" in
      1) echo "CHT services (haproxy, api, sentinel, nginx) should now be running." ;;
      2) echo "PostgreSQL + cht-sync should now be running." ;;
      3) echo "PowerSync Service should now be running." ;;
    esac
    ;;

  status)
    CURRENT=$(get_current_phase)
    echo "Current phase: $CURRENT"
    echo ""
    echo "Phase 0: Agents + CouchDB (unit tests, exploration)"
    echo "Phase 1: + CHT stack (haproxy, api, sentinel, nginx)"
    echo "Phase 2: + PostgreSQL + cht-sync"
    echo "Phase 3: + PowerSync Service"
    echo ""
    if [ "$CURRENT" -ge 1 ]; then echo "[x] Phase 1 active"; else echo "[ ] Phase 1 pending"; fi
    if [ "$CURRENT" -ge 2 ]; then echo "[x] Phase 2 active"; else echo "[ ] Phase 2 pending"; fi
    if [ "$CURRENT" -ge 3 ]; then echo "[x] Phase 3 active"; else echo "[ ] Phase 3 pending"; fi
    ;;

  *)
    echo "Usage: phase-gate.sh {check|wait|approve|status} [phase]"
    exit 1
    ;;
esac
