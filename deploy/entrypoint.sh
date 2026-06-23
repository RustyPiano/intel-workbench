#!/usr/bin/env sh
set -eu

PORT="${PORT:-4319}"
APP_IP="$(hostname -i | awk '{print $1}')"
PIDS=""

cleanup() {
  for pid in ${PIDS}; do
    kill "${pid}" 2>/dev/null || true
  done
}

trap cleanup INT TERM EXIT

start_proxy() {
  bind_host="$1"
  listen_port="$2"
  target_host="$3"
  target_port="$4"
  socat "TCP-LISTEN:${listen_port},fork,reuseaddr,bind=${bind_host}" "TCP:${target_host}:${target_port}" &
  PIDS="${PIDS} $!"
}

# The server intentionally binds 127.0.0.1. This bridge exposes only the
# container interface Docker publishes, while keeping the app process loopback.
start_proxy "${APP_IP}" "${PORT}" "127.0.0.1" "${PORT}"

# Keep default offline profile URLs as 127.0.0.1 inside the app while forwarding
# to model services running on the Docker host. Missing services fail closed.
start_proxy "127.0.0.1" "8000" "host.docker.internal" "8000"
start_proxy "127.0.0.1" "8001" "host.docker.internal" "8001"
start_proxy "127.0.0.1" "11434" "host.docker.internal" "11434"

node packages/server/dist/index.js &
APP_PID="$!"
PIDS="${PIDS} ${APP_PID}"

wait "${APP_PID}"
