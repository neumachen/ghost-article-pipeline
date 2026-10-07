#!/usr/bin/env bash
# Runner-contract evidence for the GitHub → Ghost article pipeline (C1 and C4).
#
# Two things about the runner this pipeline publishes from cannot be shown by a
# unit test, because both are properties of the container and the checkout
# rather than of the code:
#
#   C1  On a Linux runner the checkout is owned by the runner's user while the
#       application can run as a different non-root user, and git refuses to read a
#       repository owned by someone else. The pipeline reads git for everything,
#       so it needs a `safe.directory` exception scoped to that checkout — and
#       it must not have one that is global.
#   C4  The publish gates resolve a revision and check ancestry against it, so
#       the checkout must carry full committed history. Both jobs of
#       .github/workflows/article-publish.yml use `fetch-depth: 0`; a depth-1
#       checkout silently breaks every legitimate publication of a non-HEAD
#       revision and makes the stale-revision refusal fire for the wrong reason.
#
# Both are demonstrated INSIDE the pinned application image, through the same
# launcher the mise tasks and the workflows use. The earlier version of this
# script ran the history predicates with the HOST's `node` against the host's
# git, which proved something about a developer's machine and nothing about the
# runner; the predicates now run in the container, from /app/src, against
# fixtures built in the test image or the container's own /tmp.
#
# Run it by hand:
#   bash article/test/history-evidence.sh
# or through mise:
#   mise run article:evidence
#
# It builds the image if needed, runs both evidence scripts, and exits non-zero
# if either one's evidence does not hold. Nothing here contacts Ghost, nothing
# here writes to the repository, and nothing here needs credentials.
#
# NOTE: this is a LOCAL container run. It is not a GitHub-hosted run and does
# not stand in for one — see docs/ARTICLE_PIPELINE.md for what remains to be
# observed on a hosted runner.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

launcher="tools/article/run.sh"
if [ ! -x "$launcher" ]; then
  echo "missing launcher: $repo_root/$launcher" >&2
  exit 1
fi

# The evidence scripts need no network and must not write into the repository:
# their fixtures live in the container's /tmp.
export ARTICLE_NETWORK="${ARTICLE_NETWORK:-none}"
export ARTICLE_TARGET=test

status=0

echo "############################################################"
echo "# C1 — checkout ownership inside the container"
echo "############################################################"
if ! "$launcher" -- node /app/test/ownership-evidence.mjs; then
  status=1
fi

echo
echo "############################################################"
echo "# C4 — committed history inside the container"
echo "############################################################"
if ! "$launcher" -- node /app/test/history-evidence.mjs; then
  status=1
fi

echo
if [ "$status" -eq 0 ]; then
  echo "Runner-contract evidence: PASS (local container run, not a GitHub-hosted run)."
else
  echo "Runner-contract evidence: FAIL." >&2
fi
exit "$status"
