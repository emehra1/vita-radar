#!/usr/bin/env bash
#
# Commit and push generated data, without ever hitting a merge conflict.
#
# Usage: commit-data.sh <message> <error|warning> <pathspec>…
#
# WHY THIS IS NOT `git pull --rebase`
#
# On 2026-08-07 two workflow_dispatch runs were queued 12 seconds apart. The
# `concurrency` group serialized them, so run 2 started after run 1 had already
# pushed two commits — but `actions/checkout` pins to `github.sha`, the SHA at
# QUEUE time, so run 2 still checked out two commits behind and regenerated the
# same six JSON files. `git pull --rebase` then hit a content conflict in
# `data/digests/2026/2026-08-07.json` and halted mid-rebase. The retry loop was
# the cruel part: attempts 2 and 3 died instantly on "Pulling is not possible
# because you have unmerged files", so the whole thing failed in 31 seconds
# having slept for 30 of them, and the digest never reached the repo.
#
# The checkout now takes the branch tip (see `ref:` in pipeline.yml), which
# removes the stale tree that caused it. This script removes the sharp edge
# underneath: rebasing asks git to reconcile two versions of a generated file,
# and there is no reconciliation to do. Every path here is output — whatever
# this run produced IS the answer. So instead of merging, we re-parent:
#
#   fetch  → reset --mixed FETCH_HEAD → stage our paths → commit → push
#
# `reset --mixed` moves the index to the remote tip and leaves the working tree
# untouched, so re-staging our paths produces a tree that is "the remote tip,
# plus our files". That is a fast-forward by construction. A push that loses a
# race simply loops and re-parents onto whatever arrived, which is why this can
# retry safely where a halted rebase could not.
#
# "OUR FILES" MEANS THE ONES THIS RUN WROTE, NOT THE WHOLE PATHSPEC
#
# The obvious version of this — `git add -- data` after the reset — is subtly
# wrong in both directions, and a race test caught both:
#
#   * it stages a DELETION for anything upstream added that our older working
#     tree does not have, silently reverting someone else's file;
#   * it stages OUR copy of every file under the pathspec, including ones this
#     run never touched, reverting upstream edits to them. `data/state/seen/`
#     is cumulative, so quietly rewinding it can resurface an item that was
#     already delivered — a wrong digest, days later, with nothing to point at.
#
# So the set of paths to stage is computed BEFORE the first reset: files this
# run modified relative to the tree it checked out, plus files it created.
# Everything else keeps whatever the remote has. Ours wins only where "ours"
# actually means something.

set -euo pipefail

message="${1:?commit message required}"
level="${2:?annotation level required (error|warning)}"
shift 2
[ "$#" -gt 0 ] || { echo "at least one pathspec required" >&2; exit 2; }

branch="${GITHUB_REF_NAME:-main}"
written="$(mktemp)"
trap 'rm -f "$written"' EXIT

# The two callers disagree about what a failure here means, and the difference
# has to survive an UNEXPECTED failure, not just an exhausted retry loop. The
# email job's marker commit runs after the mail is already gone, and failing
# that step would file a "Digest email failing" issue about an email the reader
# has in front of them. So `warning` fails open, whatever went wrong.
on_error() {
  local rc=$?
  echo "::${level}::commit-data.sh failed unexpectedly (exit ${rc})"
  [ "$level" = "warning" ] && exit 0
  exit "$rc"
}
trap on_error ERR

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Captured once, against the checked-out tree, before any reset moves HEAD.
# `git diff` covers tracked files this run rewrote; `ls-files --others` covers
# the ones it created (today's digest, a new month's seen store), which a diff
# cannot see. NUL-delimited throughout — these are paths, not words.
{
  git diff -z --name-only HEAD -- "$@"
  git ls-files -z --others --exclude-standard -- "$@"
} > "$written"

if [ ! -s "$written" ]; then
  echo "nothing to commit"
  exit 0
fi

echo "staging $(tr -cd '\0' < "$written" | wc -c | tr -d ' ') path(s) this run wrote"

for attempt in 1 2 3 4 5; do
  # Both network calls are guarded rather than left to `set -e`: a blip on the
  # fetch is exactly the kind of thing the retry loop exists for, and aborting
  # on it would skip the remaining four attempts.
  #
  # FETCH_HEAD rather than refs/remotes/origin/$branch: it is written by every
  # fetch regardless of how the remote's refspec is configured, and a runner's
  # checkout is not a clone we control.
  if ! git fetch --quiet origin "$branch"; then
    echo "fetch failed on attempt ${attempt}"
  else
    git reset --quiet --mixed FETCH_HEAD
    git add --ignore-removal --pathspec-from-file="$written" --pathspec-file-nul

    if git diff --cached --quiet; then
      echo "nothing to commit"
      exit 0
    fi

    git commit --quiet -m "$message"

    if git push --quiet origin "HEAD:${branch}"; then
      echo "pushed on attempt ${attempt}"
      exit 0
    fi
    echo "push rejected on attempt ${attempt}; re-parenting onto the new tip"
  fi

  sleep $((attempt * 5))
done

echo "::${level}::could not push the data commit after 5 attempts"
# A warning is not a failure. The caller decides which this is, because the two
# callers genuinely differ: an unpushed digest is a content outage, an unpushed
# emailedAt marker only risks a duplicate email on a manual re-run.
[ "$level" = "warning" ] || exit 1
