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

step() { echo "STEP $1"; }
fail() { echo "FAILED $1"; exit 1; }

cd "$REPO_PATH" || fail "repo-missing"

# Fetch through the sentinel host. The container holds no credential: the
# remote points at github.com and the Worker's outbound interceptor substitutes
# the real token on egress. If this fails, everything after it is meaningless,
# so it fails loudly rather than proceeding against a stale tree.
step "fetch"
git fetch --depth 1 origin "$REPO_REF" || fail "fetch"

# Discard whatever a previous run left behind. This is why provision.sh lives
# in /usr/local/bin: a reset that deleted the running script would be a
# genuinely baffling failure.
step "reset"
git reset --hard "origin/${REPO_REF}" || fail "reset"
git clean -fd -e node_modules -e .turbo || fail "clean"

# Delta install against the store baked into the image. --offline would be
# wrong here: if the lockfile moved since the bake, the missing packages are
# exactly what we need and the network is available.
step "install"
pnpm install --prefer-offline --ignore-scripts || fail "install"

# Turbo's cache is baked too, so an unchanged packages/ tree makes this close to
# a no-op rather than a rebuild.
step "build-packages"
pnpm build-packages || fail "build-packages"

step "ready"
git rev-parse HEAD
