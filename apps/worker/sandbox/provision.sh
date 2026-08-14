#!/usr/bin/env bash
#
# Boot-time catch-up for the baked image.
#
# The image is built at some point; the drill plants its bug later. This script
# is what closes that gap, so image staleness self-heals instead of becoming a
# reason to rebuild under time pressure.
#
# It exists as a FILE rather than as a string of exec calls in the Worker for
# one reason: changing boot behaviour must not require an image rebuild. A
# rebuild is minutes. Editing this script and re-running it inside a live
# container is seconds. See the plan's speed rule 7.
#
# Idempotent by construction — safe to run on every boot and safe to re-run
# after a failure.
#
# Progress is emitted as single parseable lines (`STEP <name>`) because the
# Worker reads them to populate BootStatus.note. A human watching a Slack
# thread wants "installing dependencies", not silence.

set -euo pipefail

REPO_PATH="${SANDBOX_REPO_PATH:-/workspace/web2app-rebuild}"
REPO_REF="${SANDBOX_REPO_REF:-staging}"
GIT_REMOTE="${SANDBOX_GIT_REMOTE:-}"

step() { echo "STEP $1"; }
fail() { echo "FAILED $1"; exit 1; }

[ -n "$GIT_REMOTE" ] || fail "missing-git-remote"

# Clone or fetch, through the sentinel host either way.
#
# The image no longer bakes the repository — see the Dockerfile — so a cold
# container arrives empty and clones, while a warm one already has the tree and
# only fetches. Both go through the sentinel: the URL carries a placeholder and
# the Worker substitutes the real token on egress, so no credential ever exists
# inside this container.
if [ -d "$REPO_PATH/.git" ]; then
  cd "$REPO_PATH" || fail "repo-unreadable"
  step "set-remote"
  git remote set-url origin "$GIT_REMOTE" || fail "set-remote"
  step "fetch"
  git fetch --depth 1 origin "$REPO_REF" || fail "fetch"
else
  step "clone"
  # A directory without .git is the residue of an interrupted clone; git
  # refuses to clone into it, so a run would wedge on its predecessor's
  # corpse. Remove it first — there is nothing in it worth keeping.
  [ -d "$REPO_PATH" ] && rm -rf "$REPO_PATH"
  # --depth 1 because history is worthless here and costs minutes. Phase 20
  # builds its commit Worker-side from a diff, so the container never needs to
  # push and never needs a full object graph.
  git clone --depth 1 --branch "$REPO_REF" "$GIT_REMOTE" "$REPO_PATH" || fail "clone"
  cd "$REPO_PATH" || fail "repo-unreadable"
fi

# Discard whatever a previous run left behind. This is why provision.sh lives
# in /usr/local/bin: a reset that deleted the running script would be a
# genuinely baffling failure.
step "reset"
git reset --hard "origin/${REPO_REF}" || fail "reset"
git clean -fd -e node_modules -e .turbo || fail "clean"

# The install. On a cold container this is a full 3217-package install, because
# node_modules is deliberately not baked — see the Dockerfile for why (a 3.74 GB
# layer cannot be pushed from a domestic uplink). On a warm container it is a
# near no-op: the filesystem persists between boots while the sandbox lives.
#
# WITH scripts, deliberately. `--ignore-scripts` skips the allowBuilds set —
# esbuild, sharp, workerd, @prisma/engines and a dozen more that compile or
# fetch platform binaries — producing a node_modules that installs cleanly and
# then fails at the first build.
#
# Retried, because pnpm's store fills incrementally: an install killed by a
# tarball timeout leaves what it fetched behind and the next attempt resumes.
# Measured on a thin link as 3114 packages, then 3202, then the tail.
step "install"
if [ -z "${NUCLEO_LICENSE_KEY:-}" ]; then
  # Named explicitly. Without it the install dies deep inside a preinstall
  # script with ERR_PNPM_IGNORED_BUILDS, which reads like a corrupt lockfile.
  fail "install-missing-nucleo-license-key"
fi
export NUCLEO_LICENSE_KEY
INSTALLED=0
for attempt in 1 2 3; do
  if pnpm install --frozen-lockfile; then INSTALLED=1; break; fi
  echo "STEP install-retry-${attempt}"
done
[ "$INSTALLED" = "1" ] || fail "install"

# Turbo's cache persists on a warm container, so an unchanged packages/ tree
# makes this close to a no-op. Cold, it is the 3677-icon SVGR pass plus prisma
# generate and two tsup builds — measured at 27s.
step "build-packages"
pnpm build-packages || fail "build-packages"

# Chromium, for Phase 19's proof capture.
#
# Installed here rather than baked because it is a 1.19 GB image layer, which
# is the one thing that reliably fails to push from a domestic uplink before
# the registry credential expires. Inside the container it downloads over
# Cloudflare's network in seconds.
#
# Idempotent and non-fatal. Idempotent because a warm container already has it
# and re-running is a no-op. Non-fatal because Phase 18's exit criteria involve
# no browser at all: a run that only needs to read code, run tests and produce
# a diff must not be blocked by a browser download, and Phase 19's capability
# can surface the absence itself with a message about what to do.
step "browser"
if [ -d /root/.cache/ms-playwright ] && [ -n "$(ls -A /root/.cache/ms-playwright 2>/dev/null)" ]; then
  echo "STEP browser-cached"
else
  npm i -g playwright@1.58.0 --silent \
    && npx --yes playwright@1.58.0 install --with-deps chromium \
    || echo "STEP browser-unavailable"
fi

step "ready"
git rev-parse HEAD
