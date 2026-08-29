#!/usr/bin/env bash
# Restart the local Cyclops API and Vite frontend used for OCLP dogfooding.
#
# Optional: OCLP_DOGFOOD_DIR=/path/to/data/oclp bash scripts/restart-local.sh

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
explorer_root="$(cd -- "$script_dir/.." && pwd)"
oclp_dir="${OCLP_DOGFOOD_DIR:-/Users/evanzamir/projects/nba-lineup-model-oclp/data/oclp}"
oclp_python_source="${OCLP_PYTHON_SOURCE:-/Users/evanzamir/projects/oclp-python/src}"
api_port=8002
frontend_port=5175
temporary_root="${TMPDIR:-/tmp}"
runtime_dir="${temporary_root%/}/cyclops-local"
api_log="$runtime_dir/api.log"
frontend_log="$runtime_dir/vite.log"
api_label="com.evanzamir.oclp-explorer.local"
frontend_label="com.evanzamir.cyclops-vite.local"

listener_pids() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

stop_listener() {
  local port="$1"
  local label="$2"
  local command_marker="$3"
  local pids
  pids="$(listener_pids "$port")"
  if [[ -z "$pids" ]]; then
    return
  fi

  for pid in $pids; do
    local command
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command" != *"$command_marker"* ]]; then
      echo "Refusing to stop PID $pid on port $port; it is not the expected $label service."
      echo "Command: $command"
      exit 1
    fi
    kill -TERM "$pid"
  done

  for _ in {1..30}; do
    [[ -z "$(listener_pids "$port")" ]] && return
    sleep 0.2
  done
  echo "The $label listener on port $port did not stop cleanly."
  exit 1
}

remove_launch_service() {
  launchctl remove "$1" >/dev/null 2>&1 || true
}

wait_for_listener() {
  local port="$1"
  local label="$2"
  local log_file="$3"
  # Rebuilding the local read model can take longer than a small fixture,
  # especially after a full season or model-lifecycle run. Give the API thirty
  # seconds to bind before reporting a startup failure.
  for _ in {1..150}; do
    if [[ -n "$(listener_pids "$port")" ]]; then
      return
    fi
    sleep 0.2
  done
  echo "The $label service did not start on port $port. Recent log output:"
  tail -n 30 "$log_file" || true
  exit 1
}

if [[ ! -d "$oclp_dir" ]]; then
  echo "OCLP store does not exist: $oclp_dir"
  echo "Set OCLP_DOGFOOD_DIR to a directory containing OCLP records."
  exit 1
fi

if [[ ! -d "$oclp_python_source/oclp" ]]; then
  echo "Local OCLP Python source is unavailable: $oclp_python_source"
  echo "Set OCLP_PYTHON_SOURCE to the src directory of a compatible local checkout."
  exit 1
fi

mkdir -p "$runtime_dir"
remove_launch_service "$api_label"
remove_launch_service "$frontend_label"
stop_listener "$api_port" "Cyclops API" "oclp-explorer"
stop_listener "$frontend_port" "Cyclops Vite" "vite"

api_bin="$explorer_root/.venv/bin/oclp-explorer"
if [[ ! -x "$api_bin" ]]; then
  echo "Cyclops API environment is unavailable: $api_bin"
  echo "Create it with: uv venv --clear .venv && uv sync --all-groups"
  exit 1
fi
if ! npm_bin="$(command -v npm)"; then
  echo "npm is required to start the Cyclops frontend."
  exit 1
fi
launch_path="$(dirname -- "$npm_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

launchctl submit -l "$api_label" -o "$api_log" -e "$api_log" -- \
  /usr/bin/env "PATH=$launch_path" "PYTHONPATH=$oclp_python_source" "$api_bin" \
  --oclp-dir "$oclp_dir" --port "$api_port"
wait_for_listener "$api_port" "Cyclops API" "$api_log"

launchctl submit -l "$frontend_label" -o "$frontend_log" -e "$frontend_log" -- \
  /usr/bin/env "PATH=$launch_path" "$npm_bin" --prefix "$explorer_root/apps/cyclops" run dev
wait_for_listener "$frontend_port" "Cyclops Vite" "$frontend_log"

echo "Cyclops is ready at http://127.0.0.1:$frontend_port"
echo "API log: $api_log"
echo "Vite log: $frontend_log"
