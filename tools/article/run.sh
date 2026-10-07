#!/usr/bin/env bash
# Host launcher for the containerized GitHub → Ghost article pipeline.
#
# This is the only host entry point for the article app: the app itself never
# runs on the host. Host-side work stays limited to editing, git inspection
# and the container orchestration performed here — build the image from
# article/ when it is missing, then run the app inside it.
#
# Usage:
#   tools/article/run.sh --build-only
#       Build the image (from article/) and stop: no container is run. This is
#       what mise run article:image calls.
#
#   tools/article/run.sh [--] <container command and its arguments>
#
#     tools/article/run.sh -- node src/cli.mjs validate --repo /repo
#
# Arguments after a leading `--` are forwarded verbatim as the container's
# command; without one, every argument is. The article tasks in mise.toml
# call this with `node src/cli.mjs <command> ...`.
#
# Environment (all optional):
#   ARTICLE_TARGET    production (default) or test; also selects the default tag.
#   ARTICLE_IMAGE     override the target's image tag. Its target label is checked.
#   ARTICLE_REBUILD   set to 1 to rebuild the image even if it exists.
#   ARTICLE_UID/GID   non-root runtime IDs; default to the invoking user's IDs.
#   ARTICLE_TEST_MOUNT  1 mounts test/ read-only into the production image for
#                     Node's test runner against disposable Ghost. No production secrets.
#   ARTICLE_NETWORK   docker network for the run. Default `default`, which
#                     the app needs to reach Ghost; `none` for the no-network
#                     runs (article:check, article:preview); `host` for the
#                     integration tests against the disposable Ghost on
#                     localhost.
#   ARTICLE_OUT_DIR   host directory mounted writable at /out, where the app
#                     writes its outputs. Default: <repo>/dist/article
#   ARTICLE_PLATFORM  platform recorded with the run and used for the build.
#                     Default: linux/<this machine's architecture>
#
# Ghost credentials reach only production plan/publish/verify CLI commands.
# GITHUB_TOKEN reaches only select-artifact/fetch-artifact. Values are not printed.
#
# The integration test's own variables are passed through too: it reads
# ARTICLE_INTEGRATION_URL (the disposable Ghost it talks to) and, only when an
# already-set-up instance must be reused, ARTICLE_INTEGRATION_OWNER_EMAIL and
# ARTICLE_INTEGRATION_OWNER_PASSWORD. None is required by any other run.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

target=${ARTICLE_TARGET:-production}
case "$target" in production|test) ;; *) echo "ARTICLE_TARGET must be production or test." >&2; exit 2 ;; esac
image=${ARTICLE_IMAGE:-neumachen-article-pipeline:$target}
platform=${ARTICLE_PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}
out_dir=${ARTICLE_OUT_DIR:-$repo_root/dist/article}
network=${ARTICLE_NETWORK:-default}
repo_mode=ro
if [ "${ARTICLE_MOUNT_RW:-}" = "1" ]; then
  echo "ARTICLE_MOUNT_RW is no longer supported; write outputs through /out." >&2
  exit 2
fi
runtime_uid=${ARTICLE_UID:-$(id -u)}
runtime_gid=${ARTICLE_GID:-$(id -g)}
if ! [[ "$runtime_uid" =~ ^[1-9][0-9]*$ && "$runtime_gid" =~ ^[1-9][0-9]*$ ]]; then
  echo "ARTICLE_UID and ARTICLE_GID must be positive non-root numeric IDs." >&2
  exit 2
fi

if [ ! -d "$repo_root/article" ]; then
  echo "No article/ application at $repo_root/article to build an image from." >&2
  exit 1
fi

build_only=0
if [ "${1-}" = "--build-only" ]; then
  build_only=1
  shift
fi

mkdir -p "$out_dir"

# Build the image when it is missing, when ARTICLE_REBUILD=1 asks for it, or
# when --build-only was given (an explicit image task always builds).
if [ "$build_only" = "1" ] || [ "${ARTICLE_REBUILD:-}" = "1" ] || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "building image $image from $repo_root/article"
  docker build --platform "$platform" --target "$target" -t "$image" "$repo_root/article"
fi

image_id=$(docker image inspect --format '{{.Id}}' "$image")
platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_id")
image_target=$(docker image inspect --format '{{ index .Config.Labels "dev.neumachen.article.target" }}' "$image_id")
image_user=$(docker image inspect --format '{{ index .Config "User" }}' "$image_id")
if [ "$image_target" != "$target" ] || [ "$image_user" != "1000:1000" ]; then
  echo "Image does not satisfy the $target non-root contract. Rebuild with article:image and the intended ARTICLE_TARGET." >&2
  exit 2
fi

# The effective environment is part of every candidate's record: the image is
# shown as its human-readable tag plus its immutable ID.
echo "article pipeline image: $image ($image_id)"
echo "platform: $platform"
echo "target: $target; runtime user: $runtime_uid:$runtime_gid"
echo "repository: $repo_root mounted $repo_mode at /repo"
echo "output directory: $out_dir mounted rw at /out"
echo "network: $network"

if [ "$build_only" = "1" ]; then
  # An explicit image task: build and stop, no container is run.
  exit 0
fi

# Forward the arguments: everything after a leading `--`, or all of them.
if [ "${1-}" = "--" ]; then
  shift
fi

run_args=(
  --rm
  --user "$runtime_uid:$runtime_gid"
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges=true
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,mode=1777"
  --platform "$platform"
  --network "$network"
  -v "$repo_root":/repo:"$repo_mode"
  -v "$out_dir":/out
  -w /app
  # The effective environment, recorded with every candidate. ARTICLE_IMAGE
  # carries the immutable image ID, so a candidate records the image it was
  # actually built from — a tag is mutable and can be re-pointed between runs —
  # while ARTICLE_IMAGE_TAG keeps the human-readable tag visible too. Neither
  # value is a secret.
  -e ARTICLE_IMAGE="$image_id"
  -e ARTICLE_IMAGE_TAG="$image"
  -e ARTICLE_PLATFORM="$platform"
  # The GITHUB_* context the app records, and the step summary it writes.
  -e GITHUB_ACTIONS
  -e GITHUB_API_URL
  -e GITHUB_SERVER_URL
  -e GITHUB_ACTOR
  -e GITHUB_EVENT_NAME
  -e GITHUB_REPOSITORY
  -e GITHUB_REF
  -e GITHUB_SHA
  -e GITHUB_RUN_ID
  -e GITHUB_RUN_ATTEMPT
  -e GITHUB_STEP_SUMMARY
  -e GITHUB_WORKSPACE
  # The step-output file the prepare step's candidate_count is emitted to,
  # which Article CI's upload gates on. Never printed; never a secret.
  -e GITHUB_OUTPUT
)

operation=""
if [ "${1-}" = "node" ] && { [ "${2-}" = "src/cli.mjs" ] || [ "${2-}" = "/app/src/cli.mjs" ]; }; then
  operation=${3-}
fi
if [ "$target" = "production" ]; then
  case "$operation" in
    plan|publish|verify) run_args+=(-e GHOST_ADMIN_API_URL -e GHOST_ADMIN_API_KEY) ;;
    select-artifact|fetch-artifact) run_args+=(-e GITHUB_TOKEN) ;;
  esac
fi

if [ "${ARTICLE_TEST_MOUNT:-}" = "1" ]; then
  if [ "$target" != "production" ] || [ "$#" != "3" ] || [ "${1-}" != "node" ] || [ "${2-}" != "--test" ] || [ "${3-}" != 'test/*.test.mjs' ]; then
    echo "ARTICLE_TEST_MOUNT is only for the production-target Node test suite." >&2
    exit 2
  fi
  run_args+=(-v "$repo_root/article/test":/app/test:ro)
fi
if [ "$target" = "test" ] || [ "${ARTICLE_TEST_MOUNT:-}" = "1" ]; then
  run_args+=(-e ARTICLE_INTEGRATION_URL -e ARTICLE_INTEGRATION_OWNER_EMAIL -e ARTICLE_INTEGRATION_OWNER_PASSWORD)
fi

# A git worktree keeps its real metadata outside the repository: $repo_root/.git
# is then a file pointing at <main>/.git/worktrees/<name>, so the repository
# mount alone leaves the container with no git directory and `git -C /repo`
# fails. Mount the git common directory (the main repository's .git) read-only
# at its own absolute path when it lives outside $repo_root. The per-worktree
# gitdir (`git rev-parse --absolute-git-dir`, e.g. <main>/.git/worktrees/<name>)
# sits inside the common directory, so this mount covers it too. A normal
# checkout keeps .git inside the repository, where the repository mount already
# covers it and no extra mount is added. Git is only ever read, so this mount
# stays read-only.
# A directory that is not a git checkout must not abort the run before the
# container starts: the app reports its own git error, so skip the mount.
git_common_dir=""
if git_common_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  :
elif git_common_dir=$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null); then
  # git < 2.31 has no --path-format: --git-common-dir may be relative to
  # $repo_root, so resolve it against the repository (physically, matching the
  # path git itself reports, which is what a worktree's .git file references).
  git_common_dir=$(cd "$repo_root" && cd "$git_common_dir" && pwd -P) || git_common_dir=""
else
  git_common_dir=""
fi
if [ -n "$git_common_dir" ] && [ -d "$git_common_dir" ]; then
  # Decide "already inside the repository" on physical paths: git reports the
  # resolved directory, which differs from $repo_root when either is reached
  # through a symlink (macOS /var vs /private/var, a symlinked checkout path),
  # and a prefix test on the unresolved strings would then miss that case. The
  # mount itself uses git's own reported path, because that is the path the
  # worktree's .git file points at.
  repo_root_physical=$(cd "$repo_root" && pwd -P)
  git_common_dir_physical=$(cd "$git_common_dir" && pwd -P)
  case "$git_common_dir_physical" in
    "$repo_root_physical" | "$repo_root_physical"/*)
      # Inside the repository: the repository mount already covers it.
      ;;
    *)
      echo "git metadata: $git_common_dir mounted ro at $git_common_dir"
      run_args+=(-v "$git_common_dir":"$git_common_dir":ro)
      ;;
  esac
fi

# A read-only repository still needs a writable place for its candidates: when
# the output directory sits inside the repository, mount it writable at its
# /repo path as well, so a repository-relative --out reaches the same files
# the /out mount does.
if [ "$repo_mode" = "ro" ]; then
  case "$out_dir" in
    "$repo_root"/*)
      run_args+=(-v "$out_dir":/repo/"${out_dir#"$repo_root"/}")
      ;;
  esac
fi

# On a GitHub runner the app is handed host paths (the record file, the step
# summary, the workspace) in its arguments and environment. Mount each at its
# own path so those values resolve inside the container too.
if [ -n "${RUNNER_TEMP:-}" ] && [ -d "$RUNNER_TEMP" ]; then
  run_args+=(-v "$RUNNER_TEMP":"$RUNNER_TEMP")
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  summary_dir=$(dirname "$GITHUB_STEP_SUMMARY")
  if [ -d "$summary_dir" ] && [ "$summary_dir" != "${RUNNER_TEMP:-}" ]; then
    run_args+=(-v "$summary_dir":"$summary_dir")
  fi
fi
# The step-output file the prepare step's candidate_count is written to, which
# Article CI's artifact upload gates on: its directory is mounted the same way
# the step summary's is, so the path resolves inside the container too.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  output_dir=$(dirname "$GITHUB_OUTPUT")
  if [ -d "$output_dir" ] && [ "$output_dir" != "${RUNNER_TEMP:-}" ] && ! [[ "$output_dir" == "$repo_root"* ]]; then
    run_args+=(-v "$output_dir":"$output_dir")
  fi
fi
if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -d "$GITHUB_WORKSPACE" ]; then
  # Same repository, same mode: the read-only default stays read-only.
  run_args+=(-v "$GITHUB_WORKSPACE":"$GITHUB_WORKSPACE":"$repo_mode")
fi

# The image is a positional argument to `docker run`, before the command:
# without it docker would treat the command's first word ("node", "npm") as
# an image name and try to pull it.
exec docker run "${run_args[@]}" "$image_id" "$@"
