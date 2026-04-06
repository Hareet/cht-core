#!/bin/bash
# Ralph Wiggum loop: runs a command repeatedly in an agent container.
# Named after the "keep trying despite failures" pattern.
#
# Usage:
#   ./ralph-loop.sh <agent-id> "<command>" [interval_seconds] [timeout_seconds]
#
# Stop:    touch .agents/signals/stop-agent-<id>
# Pause:   touch .agents/signals/pause-agent-<id>    (remove file to resume)
#
# Examples:
#   ./ralph-loop.sh 7 "npm run unit-api" 300
#   ./ralph-loop.sh 1 "claude --prompt 'continue your task'" 300 1800
#
# Timeout (4th argument):
#   When running Claude Code as the command, a rate limit causes the process
#   to stall indefinitely (it blocks on the API, no exit code, no countdown).
#   The timeout kills the stalled process so the loop can check signals and
#   retry. Default: 1800s (30 minutes). Set to 0 to disable.
#
# Rate limit recovery:
#   After a timeout or failure, the loop applies exponential backoff
#   (interval → 2x → 4x → ... capped at 1 hour) before retrying.
#   A success resets the backoff. Reset windows vary by plan:
#     Pro:  daily rolling window
#     Max:  5-hour rolling window (may reset sooner)
#   The backoff avoids hammering the API while waiting for reset.

set -uo pipefail

AGENT_ID=${1:?Usage: ralph-loop.sh <agent-id> "<command>" [interval] [timeout]}
COMMAND=${2:?Usage: ralph-loop.sh <agent-id> "<command>" [interval] [timeout]}
INTERVAL=${3:-300}
TIMEOUT=${4:-1800}  # Default 30 min; kills stalled Claude Code sessions

REPO="${CHT_CORE_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
SIGNAL_DIR="$REPO/.agents/signals"
LOG_DIR="$REPO/.agents/logs"
STOP_SIGNAL="$SIGNAL_DIR/stop-agent-${AGENT_ID}"
PAUSE_SIGNAL="$SIGNAL_DIR/pause-agent-${AGENT_ID}"
LOG_FILE="$LOG_DIR/agent-${AGENT_ID}-ralph.log"

mkdir -p "$SIGNAL_DIR" "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Check stop/pause signals. Returns 1 if loop should exit.
check_signals() {
  if [ -f "$STOP_SIGNAL" ]; then
    log "Stop signal received."
    rm -f "$STOP_SIGNAL"
    return 1
  fi
  while [ -f "$PAUSE_SIGNAL" ]; do
    log "Paused. Remove $PAUSE_SIGNAL to resume."
    sleep 10
    if [ -f "$STOP_SIGNAL" ]; then
      log "Stop signal received while paused."
      rm -f "$STOP_SIGNAL"
      return 1
    fi
  done
  return 0
}

# Sleep in 10-second increments so signals are responsive during waits.
interruptible_sleep() {
  local total=$1
  local slept=0
  while [ "$slept" -lt "$total" ]; do
    check_signals || return 1
    sleep 10
    slept=$((slept + 10))
  done
  return 0
}

log "=== Ralph Wiggum loop starting ==="
log "Agent: $AGENT_ID"
log "Command: $COMMAND"
log "Interval: ${INTERVAL}s"
log "Timeout: $([ "$TIMEOUT" -gt 0 ] && echo "${TIMEOUT}s" || echo "disabled")"
log "Stop: touch $STOP_SIGNAL"
log "Pause: touch $PAUSE_SIGNAL"

ITERATION=0
SUCCESSES=0
FAILURES=0
CONSECUTIVE_FAILURES=0
MAX_BACKOFF=3600  # 1 hour cap

while true; do
  check_signals || break

  ITERATION=$((ITERATION + 1))
  log "=== Iteration $ITERATION ==="

  START_TIME=$(date +%s)

  # Run command with timeout if configured.
  # When Claude Code hits a rate limit, the process stalls (blocks on API).
  # timeout sends SIGTERM so the loop regains control and can retry later.
  if [ "$TIMEOUT" -gt 0 ]; then
    timeout --kill-after=30 "$TIMEOUT" bash -c "$COMMAND" 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
  else
    eval "$COMMAND" 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
  fi

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  # exit 124 = SIGTERM from timeout, 137 = SIGKILL after grace period
  TIMED_OUT=false
  if [ "$EXIT_CODE" -eq 124 ] || [ "$EXIT_CODE" -eq 137 ]; then
    TIMED_OUT=true
  fi

  if [ "$EXIT_CODE" -eq 0 ]; then
    SUCCESSES=$((SUCCESSES + 1))
    CONSECUTIVE_FAILURES=0
    log "=== OK (${DURATION}s) | Total: $SUCCESSES ok, $FAILURES failed ==="
    SLEEP_TIME=$INTERVAL

  else
    FAILURES=$((FAILURES + 1))
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    echo "$EXIT_CODE" > "$SIGNAL_DIR/failed-agent-${AGENT_ID}"

    if $TIMED_OUT; then
      log "=== TIMEOUT after ${TIMEOUT}s — likely rate limited ==="
      log "    Claude Code stalls on rate limit (no exit, no countdown)."
      log "    The process was killed so we can check signals and retry."
    else
      log "=== FAILED exit=$EXIT_CODE (${DURATION}s) ==="
    fi
    log "    Total: $SUCCESSES ok, $FAILURES failed ($CONSECUTIVE_FAILURES consecutive)"

    # Exponential backoff: interval * 2^(consecutive-1), capped at MAX_BACKOFF.
    # With 300s interval: 300, 600, 1200, 2400, 3600(cap), 3600, ...
    # After ~4 consecutive failures we're at 1-hour waits, which is fine
    # for waiting out a rate limit reset window.
    BACKOFF_MULTIPLIER=1
    for ((i=1; i<CONSECUTIVE_FAILURES; i++)); do
      BACKOFF_MULTIPLIER=$((BACKOFF_MULTIPLIER * 2))
    done
    SLEEP_TIME=$((INTERVAL * BACKOFF_MULTIPLIER))
    if [ "$SLEEP_TIME" -gt "$MAX_BACKOFF" ]; then
      SLEEP_TIME=$MAX_BACKOFF
    fi
    log "    Backoff: ${SLEEP_TIME}s before retry"
  fi

  # Sleep with signal checking (so stop/pause work during the wait)
  interruptible_sleep "$SLEEP_TIME" || break
done

log "=== Loop terminated after $ITERATION iterations ($SUCCESSES ok, $FAILURES failed) ==="
