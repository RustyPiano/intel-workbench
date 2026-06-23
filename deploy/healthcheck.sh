#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4319}"
if [[ -n "${HEALTHCHECK_URL:-}" ]]; then
  URL="${HEALTHCHECK_URL}"
else
  APP_IP="${APP_IP:-}"
  if [[ -z "${APP_IP}" && -f /.dockerenv ]] && command -v hostname >/dev/null 2>&1; then
    APP_IP="$(hostname -i 2>/dev/null | awk '{print $1}' || true)"
  fi
  HOST="${HEALTHCHECK_HOST:-${APP_IP:-127.0.0.1}}"
  URL="http://${HOST}:${PORT}/api/health"
fi

node -e '
const url = process.argv[1];
const timeout = AbortSignal.timeout(5000);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
fetch(url, { signal: timeout })
  .then(async (res) => {
    if (!res.ok) fail(`health HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) fail("health payload missing ok=true");
  })
  .catch((error) => fail(error instanceof Error ? error.message : String(error)));
' "${URL}"
