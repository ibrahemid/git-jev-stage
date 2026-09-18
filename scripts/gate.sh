#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
BIN="./node_modules/.bin"
LOG_DIR=".status/gate-logs"
mkdir -p "$LOG_DIR"
TAIL="${GATE_TAIL:-25}"
STATUS=0

run_gate() {
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf 'PASS %-14s %3ds\n' "$name" $((SECONDS - start))
  else
    STATUS=1
    printf 'FAIL %-14s %3ds  log: %s\n' "$name" $((SECONDS - start)) "$log"
    tail -n "$TAIL" "$log"
  fi
}

GATES=("$@")
[ ${#GATES[@]} -eq 0 ] && GATES=(typecheck lint test build)

for g in "${GATES[@]}"; do
  case "$g" in
    typecheck) run_gate typecheck "$BIN/tsc" --noEmit ;;
    lint)      run_gate lint "$BIN/biome" check . ;;
    test)      run_gate test "$BIN/vitest" run ;;
    build)     run_gate build "$BIN/tsup" ;;
    *) echo "unknown gate: $g" >&2; exit 2 ;;
  esac
done
exit $STATUS
