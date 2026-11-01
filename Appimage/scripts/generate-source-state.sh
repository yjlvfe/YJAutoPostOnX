#!/usr/bin/env bash
# scripts/generate-source-state.sh — writes SOURCE_STATE.txt describing exactly
# what commit (and, if unavoidable, what patch) a delivered build came from.
#
# Usage: scripts/generate-source-state.sh <output-file> [patch-file]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="${1:?usage: generate-source-state.sh <output-file> [patch-file]}"
PATCH_FILE="${2:-}"

COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
STATUS="$(git status --short --branch)"
TREE_CLEAN="false"
if [ -z "$(git status --porcelain)" ]; then TREE_CLEAN="true"; fi

PKG_HASH="$(sha256sum package.json | awk '{print $1}')"
LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
SCRIPT_HASH="$(sha256sum scripts/verify-release.sh | awk '{print $1}')"

PATCH_NAME="none"
PATCH_HASH="none"
if [ -n "$PATCH_FILE" ] && [ -f "$PATCH_FILE" ]; then
  PATCH_NAME="$(basename "$PATCH_FILE")"
  PATCH_HASH="$(sha256sum "$PATCH_FILE" | awk '{print $1}')"
fi

{
  echo "SOURCE_STATE"
  echo "============"
  echo "generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "repository_path: $REPO_ROOT"
  echo "branch: $BRANCH"
  echo "commit_sha: $COMMIT"
  echo "working_tree_clean: $TREE_CLEAN"
  echo ""
  echo "git_status_short_branch:"
  echo "$STATUS" | sed 's/^/  /'
  echo ""
  echo "package_json_sha256: $PKG_HASH"
  echo "package_lock_json_sha256: $LOCK_HASH"
  echo "verify_release_script_sha256: $SCRIPT_HASH"
  echo ""
  echo "extra_patch_name: $PATCH_NAME"
  echo "extra_patch_sha256: $PATCH_HASH"
  echo ""
  echo "node_version: $(node --version)"
  echo "npm_version: $(npm --version)"
  echo "electron_version: $(node -p "require('./package.json').devDependencies.electron")"
  echo "electron_module_abi: $(ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p 'process.versions.modules' 2>/dev/null || echo unknown)"
  echo "better_sqlite3_version: $(node -p "require('./package.json').dependencies['better-sqlite3']")"
  echo ""
  echo "build_command: npm run build:linux"
  echo "package_version: $(node -p "require('./package.json').version")"
} > "$OUT"

echo "wrote $OUT"
cat "$OUT"
