# syntax=docker/dockerfile:1
#
# V12 Apex Atlas — self-hosted / Enterprise edition image.
#
# Multi-stage so the runtime image carries no build toolchain and no dev
# dependencies. The runtime stage installs production deps only, which matters
# more than usual here: the dev tree includes Playwright and Babel, and neither
# belongs on a production server.

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 compiles a native addon; the toolchain is thrown away with
# this stage. It is an OPTIONAL dependency, so if the compile fails — no
# prebuild for this platform, no network to fetch node headers — npm carries on
# and the image simply ships without the SQLite driver. That is a supported
# configuration: it runs on Postgres. Verified by building and booting a tree
# where better-sqlite3 genuinely failed to install.
#
# Do NOT add --omit=optional here: it would also drop Rollup's native binary and
# break the client build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .

# Produces dist/client (SPA), dist/client/repl-sandbox.js (isolated REPL
# runtime) and dist/server.cjs (bundled server).
RUN npm run build

# Prune to production dependencies, keeping the compiled native addon.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Never run as root. The node image ships an unprivileged `node` user.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json

# V12-CONST-001 and the seat register.
#
# NOT OPTIONAL, AND THE FAILURE IS TOTAL. The constitution is resolved from
# `process.cwd()/constitution` at boot, and a process that cannot verify its
# constitution against constitution.lock refuses to start — by design, with no
# bypass flag (Article I §1.3).
#
# WHY THE MODES ARE SET IN A SEPARATE RUN AND NOT WITH `COPY --chmod`
# -------------------------------------------------------------------
# The first version of this used `COPY --chmod=444` on three individual files.
# BuildKit created the parent /app/constitution and gave the DIRECTORY mode 444
# as well — and a directory without its execute bit cannot be traversed by
# anybody. The copy succeeded, the build succeeded, and the running process
# reported the constitution ABSENT, because `existsSync` returns false for a
# file it cannot stat. It cost a deploy to find.
#
# So the directory is copied whole and the modes are applied explicitly:
#   555 on the directory — readable and TRAVERSABLE
#   444 on the files     — readable and not writable
#
# Root-owned throughout: the running process must be able to READ its
# constitution and must not be able to REWRITE it. Re-anchoring is a human act
# performed on the source tree, not something a container does to itself.
COPY --from=build --chown=root:root /app/constitution ./constitution
RUN chmod 555 /app/constitution && chmod 444 /app/constitution/*

# SQLite lives here when DATABASE_URL is unset. Declared as a volume so a
# `docker run` without one still warns rather than silently losing the book.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

# PROVE IT, AS THE USER THAT WILL ACTUALLY RUN.
#
# Everything above can succeed and still produce an image whose constitution the
# `node` user cannot read — wrong directory mode, wrong ownership, a COPY that
# landed somewhere else. The process then crash-loops in production with a
# message about a missing file that is sitting right there.
#
# This turns that into a BUILD failure, checked as the unprivileged user, with
# the mode printed. A build that cannot read its own constitution should never
# become an image.
RUN node -e "const fs=require('fs');const d='/app/constitution';\
for (const f of ['constitution.yaml','constitution.lock','inspectorate.json']) {\
  const p=d+'/'+f;\
  try { fs.accessSync(p, fs.constants.R_OK); }\
  catch (e) { console.error('UNREADABLE: '+p+' — dir mode '+(fs.statSync(d).mode & 0o777).toString(8)+', '+e.code); process.exit(1); }\
}\
console.log('constitution readable as uid '+process.getuid()+', dir mode '+(fs.statSync(d).mode & 0o777).toString(8));"

EXPOSE 3000

# tini reaps zombies and forwards signals, so SIGTERM reaches the process and
# the graceful shutdown path (flush, close marketplace, close store) actually runs.
ENTRYPOINT ["/usr/bin/tini", "--"]

# The healthcheck hits the real endpoint, which verifies the audit chain and
# reports `degraded` if settlement is halted or a chain is broken. An orchestrator
# will therefore notice tampering, not just a dead port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(d=>process.exit(d.status==='ok'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
