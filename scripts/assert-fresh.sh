#!/usr/bin/env bash
#
# Refuse a LOCAL pipeline run from a stale clone.
#
# The repo is the database. `scripts/commit-data.sh` goes to considerable
# trouble to re-parent a data commit onto FETCH_HEAD precisely so that CI never
# stages a rewind of `data/state/seen/`, which is cumulative — its own comment
# spells out the failure: "quietly rewinding it can resurface an item that was
# already delivered - a wrong digest, days later, with nothing to point at."
#
# That protection covers CI. It does not cover a human at a keyboard. On
# 2026-08-22 this clone sat 32 commits behind origin/main while the scheduled
# pipeline had been committing a digest every day; `npm run pipeline` followed
# by a push from that tree would have reverted three weeks of seen-state and
# re-delivered old items. Nothing would have failed loudly.
#
# So: hard-stop before the run, not a warning after it. CI is exempt because
# actions/checkout already lands an exact ref and commit-data.sh owns the push.
set -uo pipefail

[ -n "${CI:-}" ] && exit 0
[ -n "${VR_SKIP_FRESH_CHECK:-}" ] && { echo "assert-fresh: skipped (VR_SKIP_FRESH_CHECK)"; exit 0; }

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
upstream="origin/${branch}"

# A fetch failure must not block an offline run; only a KNOWN divergence does.
if ! git fetch --quiet origin "$branch" 2>/dev/null; then
  echo "assert-fresh: could not reach origin; proceeding without a freshness check." >&2
  exit 0
fi

git rev-parse --verify --quiet "$upstream" >/dev/null || exit 0

behind=$(git rev-list --count "HEAD..${upstream}")
if [ "$behind" -gt 0 ]; then
  cat >&2 <<MSG

  ✗ This clone is ${behind} commit(s) behind ${upstream}.

    data/state/seen/ is cumulative. Running the pipeline here and pushing
    would rewind it and re-deliver items that already went out.

      git pull --ff-only

    Override only if you know why:  VR_SKIP_FRESH_CHECK=1 npm run pipeline

MSG
  exit 1
fi

ahead=$(git rev-list --count "${upstream}..HEAD")
[ "$ahead" -gt 0 ] && echo "assert-fresh: ok (${ahead} local commit(s) ahead of ${upstream})"
exit 0
