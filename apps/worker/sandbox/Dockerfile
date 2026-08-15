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

# Chromium is NOT baked, and this is the third thing to leave this image for the
# same reason.
#
# The Playwright + Chromium install is a **1.19 GB layer** — larger than every
# other addition combined. Pushing it from a domestic uplink at ~1 MB/s takes
# about twenty minutes, and Cloudflare's registry credential expires first:
# `docker push` uploads some layers, gets `unauthorized` on this one, retries,
# and fails. Confirmed by elimination — 20 base layers report "already exists",
# the small additions push, and this one never has across five attempts.
#
# provision.sh installs it at boot instead, idempotently, where it runs on
# Cloudflare's network rather than ours. The spike measured the install at ~16s
# warm; a cold container pays it once and every boot after that skips it.
#
# What stays baked is what is small: pnpm (54 MB), the Infisical CLI (88 MB) and
# redis (136 MB). The rule this image now follows is simply "bake what is small
# and stable; fetch what is large at boot, where the network is fast."

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

# ffmpeg, because Playwright's bundled Chromium build has no h264 encoder and
# no mp4 muxer. apt's 4.4.2 carries both (verified 2026-08-15).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
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
# The final image. Toolchain only.
#
# The repository is NOT baked, and neither is anything derived from it. That is
# the second half of the same lesson as `node_modules` below: this image has to
# cross a domestic uplink to Cloudflare's registry, and the registry credential
# expires on any push that runs long. A 6.26 GB image failed at its 3.74 GB
# layer; a 2.76 GB image failed at its 904 MB layer. Layer size was never the
# real variable — total transfer time was.
#
# What remains is ~2 GB of toolchain whose layers are ALREADY in the registry
# from the failed attempts, so a push is now near-instant, and a rebuild that
# changes only provision.sh pushes a few kilobytes.
#
# It also removes every build secret. Cloning moved to boot, so the PAT is no
# longer needed at build time, and `wrangler deploy` can build this Dockerfile
# directly — the reason the plan reached for `wrangler containers push` in the
# first place is gone.
#
# A pleasant side effect worth keeping: the boot-time clone exercises the
# sentinel-host credential swap on every cold container, so the security
# mechanism is on the live path rather than only in a test.
# ---------------------------------------------------------------------------
FROM base AS final

WORKDIR /workspace

# Insurance against git's dubious-ownership refusal.
#
# Inside the built image the checkout is root-owned and the container runs as
# root, so this should never fire. It is here because the failure mode is
# disproportionate: the root `postinstall` (`agents sync`) shells out to git,
# and when git refuses the directory the install dies at the very end — after
# every package is on disk — with an error about ownership that reads like
# nothing to do with the install. Observed exactly that way while probing the
# install against a bind-mounted host checkout.
RUN git config --global --add safe.directory /workspace/web2app-rebuild

# Network settings for the install below.
#
# Not premature tuning — measured. A cold install of this lockfile is 3217
# packages, and on a domestic connection tarballs arrive at 18-45 KiB/s. With
# pnpm's defaults that produces `error (23)` retries and then an outright
# `TimeoutError` around the 3100th package: a build that fails after five
# minutes of apparent progress, for a reason that has nothing to do with this
# repo. Lower concurrency is deliberate too — parallel streams on a thin link
# make every individual tarball slower and more likely to trip the timeout.
#
# Written as an npmrc rather than passed as flags because pnpm 11 type-checks
# these: `--config.network-concurrency=6` arrives as the STRING "6" and dies
# with "Expected `concurrency` to be a number from 1 and up, got `6` (string)".
# The npmrc parser coerces properly. It also lives at /root rather than in the
# repo, so provision.sh's `git clean` cannot remove it and it can never be
# committed to a PR.
RUN printf 'fetch-timeout=600000\nfetch-retries=6\nnetwork-concurrency=6\nenable-global-virtual-store=false\n' > /root/.npmrc


# ---------------------------------------------------------------------------
# Bake the monorepo. This is the reversal the node_modules comment below half
# promised ("what stays baked is ... the repository itself") and the code never
# delivered — now forced by measurement, not preference.
#
# The boot-time clone goes through the SENTINEL: the container talks to
# git.firefighter.local and the Worker's interceptHttps swaps in the real PAT
# on egress. That proxy path cannot carry the monorepo from an APAC colo —
# three live drills stalled on it, at 401 MB and at a sparse 83 MB alike, from
# sin22 and hkg13, while the same transfer is 28 s from another colo. The bulk
# must not cross the sentinel. Baked, it arrives over Cloudflare's own registry
# instead, and boot does only a small, NON-FATAL fetch delta (see provision.sh).
#
# Sparse, exactly the patterns provision.sh's fallback uses: everything minus
# the two heavy public/ trees (394 MB of marketing/docs PNGs the agent never
# opens). ~230 MB baked.
#
# The credential exists ONLY in the mounted secret and a command-scoped
# http.extraHeader — never in .git/config (the baked remote is the sentinel
# placeholder, token-free), never a build ARG, never a layer. build.sh greps
# the assembled filesystem every build to prove it.
ARG REPO_REF=staging
RUN --mount=type=secret,id=monorepo_pat \
    set -eu; \
    AUTH=$(printf 'x-access-token:%s' "$(cat /run/secrets/monorepo_pat)" | base64 -w0); \
    git -c http.extraHeader="Authorization: Basic ${AUTH}" \
        clone --depth 1 --branch "${REPO_REF}" --filter=blob:none --sparse \
        https://github.com/Zellify/web2app-rebuild.git /workspace/web2app-rebuild; \
    cd /workspace/web2app-rebuild; \
    git sparse-checkout init --no-cone; \
    printf '/*\n!/apps/landing/public/\n!/apps/docs/public/\n' > .git/info/sparse-checkout; \
    git -c http.extraHeader="Authorization: Basic ${AUTH}" read-tree -mu HEAD; \
    git remote set-url origin https://git.firefighter.local/Zellify/web2app-rebuild.git; \
    git rev-parse HEAD


# ---------------------------------------------------------------------------
# `node_modules` is deliberately NOT baked, and this is a reversal worth
# explaining because the first version of this file did bake it.
#
# Baking install + build-packages produced a working 6.26 GB image that could
# not be pushed from a domestic uplink. The first theory was layer size —
# `docker push` resumes at LAYER granularity and never within a layer, so a
# 3.74 GB layer must cross in one unbroken window. That theory was wrong, or at
# least incomplete: slimming to 2.76 GB with a 904 MB largest layer failed the
# same way, on a different layer. The real variable is TOTAL transfer time
# against a registry credential that expires — at ~1 MB/s, anything measured in
# gigabytes loses.
#
# So the expensive-but-unpushable half moves to boot, where it runs on
# Cloudflare's network rather than ours. What stays baked is everything that is
# expensive AND small: the toolchain, Chromium, and the repository itself.
# provision.sh does install + build-packages on first boot and is a near no-op
# on every boot after, because the container keeps its filesystem while warm.
#
# The honest cost: first boot of a cold container now pays an install. Measured
# at ~13 minutes here on a thin link; on a datacenter uplink it should be a
# small fraction of that, but it is unmeasured until Task 8 and it is the number
# to watch. If it proves too slow for the drill, the fix is not to re-bake — it
# is to split the install across several smaller layers, which needs ~4 GB more
# build disk than this machine had.
#
# Kept here rather than in provision.sh: the NUCLEO_LICENSE_KEY note, because
# whoever re-bakes will look for it here. `apps/dashboard` depends on
# nucleo-ui-outline-18, whose preinstall verifies a license; without the key a
# full install fails with ERR_PNPM_IGNORED_BUILDS. `--ignore-scripts` is not the
# way past it: pnpm-workspace.yaml's allowBuilds covers esbuild, sharp, workerd,
# @prisma/engines and a dozen more that compile or fetch platform binaries, so
# skipping scripts yields a node_modules that installs cleanly and then fails at
# the first build. The key therefore has to reach the CONTAINER at boot, which
# is why it is a Worker secret and not only a build secret.
# ---------------------------------------------------------------------------

# The boot-time catch-up script. Kept OUT of the repo tree so a `git reset
# --hard` inside provision.sh cannot delete the script that is running.
COPY provision.sh /usr/local/bin/provision.sh
RUN chmod +x /usr/local/bin/provision.sh

# The harness for recording proof video. Supplied by Task 2 and lives outside
# the repo tree so provision.sh's `git reset --hard` and `git clean` cannot touch it.
COPY harness/record.cjs /usr/local/bin/record-harness.cjs
