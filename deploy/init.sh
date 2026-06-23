#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
DATA_DIR="${SCRIPT_DIR}/data"
PASSWORD_FILE="${DATA_DIR}/config/initial-admin-password.json"
USERS_FILE="${DATA_DIR}/config/users.json"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${SCRIPT_DIR}/docker-compose.yml")
NODE_UID=1000
NODE_GID=1000

require_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Missing ${ENV_FILE}."
    echo "First run: cp ${SCRIPT_DIR}/.env.example ${ENV_FILE}"
    exit 1
  fi
}

prepare_data_dirs_local() {
  mkdir -p "${DATA_DIR}/cases" "${DATA_DIR}/config" "${DATA_DIR}/audit"
  chmod 700 "${DATA_DIR}/config"
}

prepare_data_dirs_compose() {
  mkdir -p "${DATA_DIR}"
  "${COMPOSE[@]}" run --rm --no-deps --user root --entrypoint sh app -c \
    "mkdir -p /data/cases /data/config /data/audit && chown -R ${NODE_UID}:${NODE_GID} /data && chmod 700 /data/config"
}

print_password_location() {
  if [[ -f "${PASSWORD_FILE}" ]]; then
    chmod 600 "${PASSWORD_FILE}" 2>/dev/null || true
    echo "Initial admin password file: ${PASSWORD_FILE}"
    echo "Read it once, then change the admin password in the web UI."
  elif [[ -f "${USERS_FILE}" ]]; then
    echo "Users already exist and no initial password file is present."
    echo "This is expected after the first admin password has been changed."
  else
    echo "Initial admin password has not been generated yet."
    return 1
  fi
}

print_password_location_compose() {
  "${COMPOSE[@]}" exec -T app sh -c '
if [ -f /data/config/initial-admin-password.json ]; then
  chmod 600 /data/config/initial-admin-password.json
  echo "Initial admin password file: deploy/data/config/initial-admin-password.json"
  echo "Read it once, then change the admin password in the web UI."
elif [ -f /data/config/users.json ]; then
  echo "Users already exist and no initial password file is present."
  echo "This is expected after the first admin password has been changed."
else
  echo "Initial admin password has not been generated yet."
  exit 1
fi
'
}

trigger_seed_local() {
  local port="${PORT:-4319}"
  node -e '
const port = process.env.PORT || process.argv[1] || "4319";
fetch(`http://127.0.0.1:${port}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "not-the-initial-password" }),
}).then(() => undefined, (error) => {
  console.error(error);
  process.exit(1);
});
' "${port}"
}

trigger_seed_compose() {
  "${COMPOSE[@]}" exec -T app node -e '
const port = process.env.PORT || "4319";
fetch(`http://127.0.0.1:${port}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "not-the-initial-password" }),
}).then(() => undefined, (error) => {
  console.error(error);
  process.exit(1);
});
'
}

wait_for_health_local() {
  local attempt
  for attempt in {1..60}; do
    if PORT="${PORT:-4319}" "${SCRIPT_DIR}/healthcheck.sh" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for the app health endpoint." >&2
  return 1
}

wait_for_health_compose() {
  local attempt
  for attempt in {1..60}; do
    if "${COMPOSE[@]}" exec -T app ./deploy/healthcheck.sh >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for the app health endpoint." >&2
  return 1
}

require_env_file

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  prepare_data_dirs_compose
  "${COMPOSE[@]}" up -d app
  wait_for_health_compose
  trigger_seed_compose
  print_password_location_compose
  exit 0
fi

prepare_data_dirs_local
if print_password_location; then
  exit 0
fi

if [[ -f "${ROOT_DIR}/packages/server/dist/index.js" ]]; then
  LOG_FILE="${DATA_DIR}/server-init.log"
  WORKBENCH_DATA_DIR="${DATA_DIR}" PORT="${PORT:-4319}" node "${ROOT_DIR}/packages/server/dist/index.js" >"${LOG_FILE}" 2>&1 &
  APP_PID="$!"
  trap 'kill "${APP_PID}" 2>/dev/null || true' EXIT
  wait_for_health_local
  trigger_seed_local
  print_password_location
  exit 0
fi

echo "No Docker compose runtime or built server was found."
echo "Run: npm run build"
echo "Then rerun: ${SCRIPT_DIR}/init.sh"
exit 1
