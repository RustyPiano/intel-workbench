# syntax=docker/dockerfile:1

FROM node:20.19.0-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json

RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20.19.0-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4319
ENV WORKBENCH_DATA_DIR=/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg=7:5.1.6-0+deb12u1 socat tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY deploy/entrypoint.sh deploy/entrypoint.sh
COPY deploy/healthcheck.sh deploy/healthcheck.sh

RUN chmod +x deploy/entrypoint.sh deploy/healthcheck.sh \
  && mkdir -p /data \
  && chown -R node:node /app /data

USER node
EXPOSE 4319

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["./deploy/healthcheck.sh"]

ENTRYPOINT ["tini", "--", "./deploy/entrypoint.sh"]
