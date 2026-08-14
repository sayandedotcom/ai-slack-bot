# syntax=docker/dockerfile:1.7
#
# The Tier 2 machine: Zellify's monorepo, pre-installed and pre-built.
#
# Base image tag MUST equal the installed @cloudflare/sandbox version exactly
# (0.12.5). The SDK speaks to the /container-server/sandbox binary baked into
# this image, so a mismatched tag is a silent protocol skew rather than a build
# error — it fails later, at a call, looking like a bug in our code.
FROM docker.io/cloudflare/sandbox:0.12.5 AS base

# ---------------------------------------------------------------------------
# Layer order is load-bearing. Everything above the repo COPY is stable and
# rarely edited; everything below changes whenever `staging` moves. Reordering
# so that an edit to a late line re-runs an early one turns a 30-second change
# into a full rebuild, repeatedly, on the phase where rebuilds are the long
# pole. See the plan's speed rule 8.
# ---------------------------------------------------------------------------

# pnpm, pinned to what `staging` declares in `packageManager` and `volta`.
#
# 11.17.0 and NOT 9.12.2. The default branch's CLAUDE.md says 9.12.2, but that
# file is stale — `staging` is the branch this image runs and the branch PRs
# target, and it pins 11.17.0. Verified from staging's own package.json at
# aca7b2e rather than from the docs.
#
# `corepack` is the documented way to honour `packageManager` and is NOT on
# PATH in this image despite Node 22, so pnpm comes from npm. The spike paid
# 3.6s discovering that.
RUN npm i -g pnpm@11.17.0 --silent && pnpm --version

# The Infisical CLI, because every Next app's dev script is
# `infisical run --env=dev --path=/apps/<app> -- next dev`. Without the binary
# on PATH those scripts die instantly with "command not found", which reads as
# a broken image rather than a missing credential.
#
# Pinned to the version CI uses. Baking the binary is free and independent of
# whether we ever get a token: provision.sh can also materialise a plain env
# file and bypass the wrapper entirely.
RUN npm i -g @infisical/cli@0.43.65 --silent

# Chromium and its system libraries, for Phase 19's Playwright proof capture.
#
# Baked here even though nothing in Phase 18 drives a browser: installing it at
# run time measured 16s+ in the spike, and adding it later would cost a full
# image rebuild during the phase that can least afford one.
RUN npm i -g playwright@1.58.0 --silent \
    && npx --yes playwright@1.58.0 install --with-deps chromium \
    && rm -rf /root/.npm/_cacache

# Point Puppeteer at the browser we already have instead of letting it download
# a second one. Lifted from Zellify's own agent sandbox image
# (apps/agent/sandbox-image/Dockerfile) — packages/screenshot uses Puppeteer,
# and this is their answer to the same problem.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Redis, because docker/docker-compose.yml is the repo's only local service and
# a container cannot run docker-in-docker. Started as a plain process by
# provision.sh only when something actually needs it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends redis-server \
    && rm -rf /var/lib/apt/lists/*

# Resolve globally-installed packages from anywhere, so a script in /workspace
# can require('playwright') without setting NODE_PATH per invocation.
ENV NODE_PATH=/usr/local/lib/node_modules

# Ports must be declared to be reachable under `wrangler dev`.
#
# 3000 is deliberately absent: it is the sandbox control server's OWN port, and
# `waitForPort(3000)` succeeds against the sandbox itself — reporting a dev
# server that was never running. THREE apps land on 3000 (web hardcodes the
# flag; landing and storybook take Next's default), and because the port is a
# CLI flag inside the package script, a PORT env var does NOT override it.
# Anything we start invokes `next` directly with a port in this range.
EXPOSE 4100
EXPOSE 4101
EXPOSE 4102

# ---------------------------------------------------------------------------
# The private clone, in its own stage so the credential cannot reach the final
# image. BuildKit secrets are never written to a layer; a build ARG would be,
# and `docker history` would print it.
#
# Cloning in a stage also sidesteps the repo's `.dockerignore`, which is `*`
# plus an allowlist of built output only. A build context rooted at the repo
# would COPY nothing at all — no source, no lockfile, no package.json.
#
# Built with plain `docker build --secret`, NOT through `wrangler deploy`'s
# Dockerfile path, which exposes no way to pass one. See sandbox/build.sh.
# ---------------------------------------------------------------------------
FROM base AS repo

ARG REPO_REF=staging
RUN --mount=type=secret,id=monorepo_pat \
    git clone --depth 1 --branch "${REPO_REF}" \
      "https://x-access-token:$(cat /run/secrets/monorepo_pat)@github.com/Zellify/web2app-rebuild.git" \
      /workspace/web2app-rebuild \
    && cd /workspace/web2app-rebuild \
    && git remote set-url origin https://github.com/Zellify/web2app-rebuild.git

# ---------------------------------------------------------------------------
# The final image. Only repository CONTENT crosses from the repo stage — never
# its build environment, and never the secret mount.
# ---------------------------------------------------------------------------
FROM base AS final

WORKDIR /workspace/web2app-rebuild

# The lockfile alone first, so a change to application source does not
# re-resolve and re-download 3000-odd packages. `pnpm fetch` populates the
# store from the lockfile without needing the workspace's package.json files,
# which is exactly what makes this split possible.
COPY --from=repo /workspace/web2app-rebuild/pnpm-lock.yaml ./
RUN pnpm fetch

# Now the tree.
COPY --from=repo /workspace/web2app-rebuild/ ./

# Install against the warm store, WITH scripts.
#
# `--ignore-scripts` would be the easy way past the license check below, and it
# is wrong: the allowBuilds list in pnpm-workspace.yaml covers esbuild, sharp,
# workerd, @prisma/engines, unrs-resolver and a dozen more that fetch or
# compile platform binaries. Skipping them yields a node_modules that installs
# cleanly and then fails at the first build.
#
# NUCLEO_LICENSE_KEY: apps/dashboard depends on nucleo-ui-outline-18, whose
# preinstall verifies a license. Without the key a full install fails with
# ERR_PNPM_IGNORED_BUILDS — pnpm-workspace.yaml and .github/workflows say so
# explicitly. A build secret, so it is never in a layer.
#
# --config.enable-global-virtual-store=false mirrors the repo's own CI and
# Docker convention. It must stay false: Turbopack cannot resolve outside the
# project root and `next build` fails with "We couldn't find the Next.js
# package" when it is on.
RUN --mount=type=secret,id=nucleo_license_key \
    NUCLEO_LICENSE_KEY="$(cat /run/secrets/nucleo_license_key 2>/dev/null || true)" \
    pnpm --config.enable-global-virtual-store=false install --frozen-lockfile --offline

# Workspace packages resolve from built dist/, not from source, so this is
# mandatory before any app can start or any test can run (turbo's `test` task
# declares dependsOn ^build).
#
# It is also the single most expensive thing in this file: @web2app/icons runs
# SVGR over 3677 SVGs, and turbo's `dev` task depends on that build plus
# @web2app/funnel's — so WITHOUT this baked, every container start pays the
# icons codegen again. Baking the .turbo cache alongside the outputs is what
# makes the boot-time re-run a cache hit rather than a repeat.
RUN pnpm build-packages

# The boot-time catch-up script. Kept OUT of the repo tree so a `git reset
# --hard` inside provision.sh cannot delete the script that is running.
COPY provision.sh /usr/local/bin/provision.sh
RUN chmod +x /usr/local/bin/provision.sh
