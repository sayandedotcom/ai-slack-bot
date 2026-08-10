# Base image tag MUST match the @cloudflare/sandbox package version exactly.
# The SDK talks to the /container-server/sandbox binary baked into this image;
# a mismatched tag is a silent protocol skew, not a build error.
FROM docker.io/cloudflare/sandbox:0.12.5

# Ports must be declared here to be reachable under `wrangler dev`.
# 3000 is the sandbox control server's OWN port — do not bind an app to it.
# waitForPort(3000) succeeds against the sandbox itself and reads as a false
# "your dev server is up".
EXPOSE 5173
EXPOSE 8080

# ---------------------------------------------------------------------------
# Task 2 Step 3 — the baked image.
#
# The base image ships Node 22 and git but NOT pnpm and NOT Chromium. Measured
# cost of installing them at run time: ~3.6s for pnpm, ~16s+ for Chromium. The
# point of baking is that the drill never pays either.
# ---------------------------------------------------------------------------

# pnpm, pinned to the repo's version.
RUN npm i -g pnpm@10.33.4 --silent && pnpm --version

# Chromium and its system deps, for Playwright proof capture (Phase 19).
RUN npm i -g playwright@1.58.0 --silent \
    && npx --yes playwright@1.58.0 install --with-deps chromium \
    && rm -rf /root/.npm/_cacache

# Resolve globally-installed packages from anywhere, so a recording script in
# /workspace can `require('playwright')` without setting NODE_PATH per call.
ENV NODE_PATH=/usr/local/lib/node_modules

# Repo pre-cloned and its pnpm store warmed. `pnpm fetch` populates the store
# from the lockfile alone, which is what makes the later
# `install --prefer-offline` fast.
ARG TARGET_REPO=https://github.com/shadcn-ui/ui.git
RUN mkdir -p /workspace \
    && git clone --depth 1 ${TARGET_REPO} /workspace/ui \
    && cd /workspace/ui \
    && pnpm fetch || true
