# Offline Install Guide

This guide is for operators preparing an Intel Workbench deployment with no
internet access on the target machine. The Node app image contains the server
and built web UI. FunASR, PaddleOCR, the local LLM, embedding, rerank, and VLM
services are external model services referenced by URL; they are not bundled
into the app image.

## Versions

- Node.js: `20.19.0` (`.nvmrc`, Docker base `node:20.19.0-bookworm-slim`).
- ffmpeg: Debian 12/bookworm package `7:5.1.6-0+deb12u1`, pinned in
  `deploy/Dockerfile`.
- External Python service runtime: Python `3.11.9`.
- FunASR service: `funasr==1.2.6`, serving `POST /asr` at `127.0.0.1:8001`;
  the reference ASR model is `iic/SenseVoiceSmall`.
- PaddleOCR service: `paddleocr==2.7.3` with `paddlepaddle==2.6.2`, serving
  `POST /ocr` at `127.0.0.1:8000`.
- Local OpenAI-compatible model server: Ollama `0.5.7` at
  `127.0.0.1:11434/v1`. Pin the actual local chat, VLM, embedding, and rerank
  model artifacts by digest in that service's own offline bundle.

The external service versions above are compatibility targets for the app
contract. Keep their wheels, model caches, container images, and service files
in their own offline deployment bundles.

## Build the App Image on a Connected Machine

The honest no-network path is to build the Docker image before entering the
air-gapped environment. The Dockerfile runs `npm ci` and `apt-get update`, so a
target machine without npm and Debian package mirrors must load a saved image
instead of rebuilding from a restored host cache.

On a connected staging machine with the same CPU architecture as the target:

```sh
docker build -f deploy/Dockerfile -t mini-agent-offline:local .
docker save mini-agent-offline:local -o mini-agent-offline.tar
```

Transfer the repo at the same revision, `mini-agent-offline.tar`, and the
external model-service bundles to the offline machine. Do not commit `.env`
files, cache archives, data directories, or Docker image tarballs.

## Prepare External Model Services

Set up these services from their own offline source packages, wheels, images,
and model caches:

- FunASR service: external Python service at `127.0.0.1:8001`, selected with
  `MINI_AGENT_ASR_PROVIDER=funasr`.
- PaddleOCR service: external Python service at `127.0.0.1:8000`.
- Local LLM, embedding, rerank, and VLM services: OpenAI-compatible or
  slot-compatible HTTP services. Use
  `deploy/model-profiles/local-models.env` as the endpoint template.

This app compose file does not build or run those Python or model-serving
services. GPU allocation also belongs to those external service deployments,
not to the app container.

## Configure

First step on the offline host:

```sh
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` with the real local endpoints, model names, dimensions, and
keys. Keep `deploy/.env.example` as the checked-in template only. Docker Compose
requires `deploy/.env` to exist because `deploy/docker-compose.yml` wires the
service `env_file` to that real operator file; even `docker compose config`
will fail until the copy step has been done.

The app data directory is bind-mounted at:

```text
deploy/data
```

It contains `config/`, `cases/`, and `audit/`. `deploy/init.sh` creates it and
sets ownership for the container's `node` user before first boot.

## One-Command Start

After `deploy/.env` exists and the external model services are running:

```sh
docker load -i mini-agent-offline.tar && deploy/init.sh
```

`deploy/init.sh` starts the app with `deploy/.env`, waits for health, triggers
first-boot user seeding, and reports the initial admin password file location:

```text
deploy/data/config/initial-admin-password.json
```

Read it once, then change the admin password in the web UI. The app is
published only on host loopback:

```text
http://127.0.0.1:4319
```

## One-Command Verify

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec -T app ./deploy/healthcheck.sh
```

The healthcheck calls `GET /api/health` through the container-interface socat
bridge and exits non-zero on failure.

## Backup and Restore

Stop the app before taking a consistent backup:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down
tar -czf intel-workbench-data-backup.tgz -C deploy data
```

Restore:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml down
rm -rf deploy/data
tar -xzf intel-workbench-data-backup.tgz -C deploy
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

## GPU Overlay Note

`deploy/docker-compose.gpu.yml` is intentionally comment-only. Do not pass it
as a Compose overlay for the app container. FunASR, PaddleOCR, VLM, embedding,
rerank, and local LLM services are external processes, so GPU device
reservations belong in those services' own deployment files.

## Notes on Offline Enforcement

OfflineGuard is an application-layer default-deny check around configured model
egress. It is useful for auditability and fail-closed behavior, but it is not a
complete air gap. For true zero-egress deployment, combine it with host firewall
rules, Docker network policy, disabled default routes where appropriate, and an
offline physical or virtual network boundary.
