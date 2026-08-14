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

step "ready"
git rev-parse HEAD
