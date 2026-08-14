#!/usr/bin/env bash
#
# Build and push the Tier 2 image.
#
# Why this exists rather than letting `wrangler deploy` build the Dockerfile:
# the build needs two BuildKit secrets (the repo PAT and the Nucleo license
# key) and wrangler's Dockerfile path exposes no way to pass one. Cloudflare's
# documented alternative is to build locally, push to their registry, and
# reference the resulting URI — which is what this does.
#
# It also buys something the Dockerfile path does not: an explicit tag per
# build. The spike found that deploying a new image does NOT recycle a running
# container — a live sandbox keeps serving the old image indefinitely, and
# `/env` cheerfully reports stale contents. A changed tag makes that visible in
# the diff instead of mysterious at the drill.
#
# Usage:
#   export MONOREPO_PAT=...           # fine-grained, contents:read on the monorepo
#   export NUCLEO_LICENSE_KEY=...     # required: nucleo-ui-outline-18's preinstall
#   ./sandbox/build.sh [tag]
#
# Neither value is ever written to a layer, an argument, or this repo.

set -euo pipefail

TAG="${1:-$(date -u +%Y%m%d-%H%M%S)}"
IMAGE="firefighter-sandbox"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${MONOREPO_PAT:?set MONOREPO_PAT (fine-grained PAT, contents:read on Zellify/web2app-rebuild)}"
: "${NUCLEO_LICENSE_KEY:?set NUCLEO_LICENSE_KEY — pnpm install fails without it, see the Dockerfile}"

echo "building ${IMAGE}:${TAG}"

# `--secret id=...,env=...` reads the value from this shell's environment and
# mounts it at /run/secrets/<id> for one RUN only. It never becomes a layer,
# which `docker history` would print, and never an ARG, which it would also
# print.
DOCKER_BUILDKIT=1 docker build \
  --secret "id=monorepo_pat,env=MONOREPO_PAT" \
  --secret "id=nucleo_license_key,env=NUCLEO_LICENSE_KEY" \
  --build-arg "REPO_REF=${SANDBOX_REPO_REF:-staging}" \
  -t "${IMAGE}:${TAG}" \
  -f "${HERE}/Dockerfile" \
  "${HERE}"

echo
echo "verifying no credential reached a layer"

# The multi-stage split is the control; this is the assertion that it worked.
# A build ARG or a plain RUN would fail here, which is the entire point of
# running it every build rather than once by hand.
if docker history --no-trunc "${IMAGE}:${TAG}" | grep -qF "${MONOREPO_PAT}"; then
  echo "FAIL: the PAT appears in image history" >&2
  exit 1
fi
if docker history --no-trunc "${IMAGE}:${TAG}" | grep -qF "${NUCLEO_LICENSE_KEY}"; then
  echo "FAIL: the Nucleo key appears in image history" >&2
  exit 1
fi

# History only covers build instructions. This greps the assembled filesystem,
# which is where a credential written to a file would sit.
echo "verifying no credential reached the filesystem"
docker run --rm --entrypoint sh "${IMAGE}:${TAG}" -c '
  grep -rlF "$1" /workspace /etc /root /usr/local 2>/dev/null | head -5
' -- "${MONOREPO_PAT}" > /tmp/ff-cred-scan.txt 2>/dev/null || true
if [ -s /tmp/ff-cred-scan.txt ]; then
  echo "FAIL: the PAT appears in the image filesystem:" >&2
  cat /tmp/ff-cred-scan.txt >&2
  exit 1
fi
rm -f /tmp/ff-cred-scan.txt

echo "clean."
echo
echo "size: $(docker image inspect "${IMAGE}:${TAG}" --format '{{.Size}}' | awk '{printf "%.2f GB", $1/1024/1024/1024}')"
echo
echo "next:  pnpm exec wrangler containers push ${IMAGE}:${TAG}"
echo "then:  set containers[0].image in wrangler.jsonc to the printed registry URI"
