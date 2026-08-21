# flightwall-server: the same src/ this repo deploys as a Cloudflare Worker
# (via wrangler), packaged instead as a plain Node process for Kamal.
#
# There is no npm "build" step in this repo today -- the Worker bundles
# straight from TypeScript source at deploy time, via wrangler's own
# esbuild. This image does the direct equivalent for Node: esbuild strips
# types and bundles src/server.ts into one plain-JS file. Two alternatives
# were rejected:
#   - `tsc` alone: the repo's tsconfig.json intentionally uses
#     `moduleResolution: "bundler"` (see the comment there) with
#     extensionless relative imports (`from './flights'`). tsc will not
#     rewrite those, and Node's own ESM loader refuses to resolve an
#     extensionless relative specifier at runtime -- confirmed empirically
#     (`node src/server.ts` under Node 24, which strips TypeScript types
#     natively with no flag needed, still fails with ERR_MODULE_NOT_FOUND
#     on the very first local import: 'Cannot find module .../src/flights').
#     Fixing that the "proper" tsc way means adding a `.js` extension to
#     every relative import across the whole src/ tree, for every file,
#     Worker-only files included -- a much bigger diff than this port
#     calls for.
#   - a runtime loader (tsx/ts-node): would ship a JIT transpiler as a
#     production dependency and add per-boot startup work for no benefit
#     over doing the same transpilation once, at build time.
# esbuild bundling needs none of that: it resolves this source tree exactly
# as wrangler's bundler already does (proven by that same source tree
# passing `wrangler deploy --dry-run`), so nothing in src/ had to change.
#
# Not run in this build stage: `tsc --noEmit`. That's a separate, already-
# required CI gate (`npm run typecheck`, over src/ AND test/) run outside
# Docker -- and test/ is deliberately excluded from this image's build
# context (see .dockerignore), so this stage cannot run it even if it tried.
# esbuild only strips and bundles; it does not type-check.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- runtime image: only the compiled bundle, no node_modules at all -----
# (this package has zero runtime `dependencies` -- esbuild inlined
# everything from src/ into dist/server.js, and Node builtins need no
# install) -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    SCHEDULE_PATH=/app/data/schedule.json

# Non-root: a compromised Node process gets no more than the app needs.
RUN addgroup -S flightwall && adduser -S flightwall -G flightwall \
 && mkdir -p /app/data && chown -R flightwall:flightwall /app

COPY --from=build --chown=flightwall:flightwall /app/dist ./dist

USER flightwall
EXPOSE 8787

# Kamal's proxy healthchecks GET /up itself (see config/deploy.yml); this
# HEALTHCHECK is for `docker ps` / plain `docker run` visibility.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/up').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
