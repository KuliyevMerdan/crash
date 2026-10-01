# The live demo, containerised (ROADMAP P1, ADR-0003). One image, one origin: `apps/server` serves
# the game's socket (`/ws`), the fairness endpoints (`/fair/*`) and the built web app (`/`) from
# one port, so the deployed page needs no CORS, no second host and no proxy.
#
#   docker build -t crash .
#   docker run --rm -p 8080:8080 -e CRASH_FAULTS=on crash     →  http://localhost:8080/
#
# A production server: no forced rounds, no dev chain seed, no `/dev/audit`. The network lab's
# faults are a host's choice (`CRASH_FAULTS=on` — render.yaml makes it), since they touch only the
# sender's own socket.

# Debian, not Alpine: better-sqlite3 ships prebuilt binaries for glibc, so the install downloads
# one instead of compiling SQLite — no python, make or g++ in the image.
FROM node:22-bookworm-slim AS build
# Without this, fetching the pinned pnpm asks a [Y/n] question a build has no stdin to answer.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# The pinned pnpm as its own layer: a flaky download retries from here, not from the install.
COPY package.json ./
RUN pnpm --version

# The layer-cache split: the install depends on the lockfile and the manifests, which change
# rarely, not on source, which changes daily. Every manifest is listed because --frozen-lockfile
# checks the lockfile against the whole workspace.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/client-core/package.json packages/client-core/
COPY packages/curve/package.json packages/curve/
COPY packages/engine/package.json packages/engine/
COPY packages/fair/package.json packages/fair/
COPY packages/money/package.json packages/money/
COPY packages/protocol/package.json packages/protocol/
COPY packages/renderer/package.json packages/renderer/
COPY tools/load/package.json tools/load/
COPY tools/sim/package.json tools/sim/
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000
RUN pnpm install --frozen-lockfile --filter "@crash/server..." --filter "@crash/web..."

COPY . .
# Each unit and everything under it, in dependency order. The web app is the production build:
# the dev hooks and `__ASSERT_CURVE__` are compiled out.
RUN pnpm --filter "@crash/server..." --filter "@crash/web..." run build
# A standalone production tree for the server (its workspace packages as their built `dist/`),
# with the web app's static bundle beside it.
RUN pnpm --filter @crash/server --prod --legacy deploy /out \
 && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim
# CRASH_CHAIN_FIRST_ID=boot: a fresh store names its first chain by the second it was generated. With
# a disk that happens once; without one, every boot — so a link from before a restart can never name
# a round on the chain after it (ADR-0003).
ENV NODE_ENV=production \
    CRASH_ENV=production \
    CRASH_STATIC_DIR=/app/web \
    CRASH_DB=/app/data/crash.db \
    CRASH_CHAIN_FIRST_ID=boot
WORKDIR /app
COPY --from=build --chown=node:node /out .
# The database's directory. A host with a disk mounts one here and the chain, balances and journal
# survive a restart; one without (Render's free tier) starts each boot with a fresh chain (ADR-0003).
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# 8080 unless the host says otherwise: a platform that injects PORT (Render) is obeyed.
EXPOSE 8080
# /ready answers once the chain is published and the round loop is running.
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
