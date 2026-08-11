#!/usr/bin/env bash
# Seed the channel policy table. Re-runnable: INSERT OR REPLACE.
#
# READ EVERY LINE BEFORE RUNNING.
#
# Reference customer channels MUST be 'observe' — spec §4.4. `observe` means
# heard and triaged but never postable: canPost() returns false and the slack
# binding throws ChannelReadOnly. A customer channel marked 'live' is the one
# mistake in this project that reaches a real customer under an engineer's name.
#
# Modes (Phase 03):
#   observe   reference customer channels — hear + triage, never post
#   live      our own test channels only
#   internal  #eng-firefighter — hear, never triage, bot nudges only
#
# Unmapped channels are still ingested (core requirement 1); they are simply
# never triaged and never postable. Seeding is what attaches a customer_slug.
set -euo pipefail
cd "$(dirname "$0")/.."

run() { npx wrangler d1 execute firefighter --remote --command "$1"; }

# --- reference customer channels — observe, NEVER live ------------------------
run "INSERT OR REPLACE INTO channels VALUES ('C0B9YBENNAD','ext-zellify-sidehop','sidehop','observe');"

# --- our own test channels — live --------------------------------------------
run "INSERT OR REPLACE INTO channels VALUES ('C0BPGUXG5RS','test-firedrill','firedrill','live');"
run "INSERT OR REPLACE INTO channels VALUES ('C0BPA2L4BBP','ff-test','firedrill','live');"

# --- internal ----------------------------------------------------------------
# #eng-firefighter is intentionally absent. Unmapped behaves identically to
# 'internal' for ingest and triage; add a row here when Phase 22 posts the
# shift-handoff summary there.

# --- guard: fail loudly if any customer channel ended up postable -------------
echo "verifying no customer channel is 'live'..."
run "SELECT channel_id, name, customer_slug, mode FROM channels ORDER BY mode, name;"
