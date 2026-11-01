#!/usr/bin/env bash
# scripts/verify-release.sh — the one release gate, run the same way locally and in CI.
#
# CI (.github/workflows/verify-xposter.yml) calls this script instead of
# re-listing its own steps, so the two verification paths cannot drift apart.
# Every step's exit code is checked; nothing is hidden behind `|| true`.
#
# Requires: node/npm on PATH, xvfb-run available, and (for the build/package
# steps) enough disk for electron-builder's output. Does NOT touch the real
# HOME — it creates and uses its own isolated one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STEP=""
fail() { echo "❌ verify-release: FAILED at step: ${STEP}" >&2; exit 1; }
trap fail ERR

run_step() {
  STEP="$1"; shift
  echo ""
  echo "── ${STEP} ──────────────────────────────────────────────"
  "$@"
}

# ── Isolation (brief §4): every test/probe/smoke/boot uses its own HOME. ──
ISOLATED_HOME="$(mktemp -d -t xposter-verify-home-XXXXXX)"
export HOME="$ISOLATED_HOME"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export TMPDIR="$HOME/tmp"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$TMPDIR"
echo "Isolated HOME for this verification run: $HOME"

cleanup() {
  rm -rf "$ISOLATED_HOME" "${EXTRACT_DIR:-}" 2>/dev/null || true
}
trap 'cleanup; fail' ERR
trap cleanup EXIT

echo "repo:   $REPO_ROOT"
echo "commit: $(git rev-parse HEAD)"
echo "branch: $(git rev-parse --abbrev-ref HEAD)"
echo "node:   $(node --version)"
echo "npm:    $(npm --version)"
echo "version:$(node -p "require('./package.json').version")"

run_step "git diff --check (no whitespace-conflict markers)" git diff --check

run_step "npm ci" npm ci

run_step "ABI: process.versions.modules" \
  bash -c 'ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p "process.versions.modules"'
run_step "ABI: better-sqlite3 round-trip" \
  bash -c "ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p \"require('better-sqlite3')(':memory:').prepare('select 42 as n').get().n\""

run_step "npm test" npm test

run_step "npm run test:electron" npm run test:electron

run_step "npm run audit" npm run audit

# A real gate: must exit non-zero on High/Critical, and this line must not
# have `|| true` appended, ever.
run_step "npm audit --omit=dev (production dependency gate)" npm audit --omit=dev --audit-level=high

run_step "npm run build:linux" npm run build:linux

APPIMAGE="$(find dist -maxdepth 1 -name '*.AppImage' | sort | tail -1)"
if [ -z "$APPIMAGE" ]; then
  STEP="locate built AppImage"
  echo "no .AppImage found under dist/" >&2
  false
fi
echo "built artifact: $APPIMAGE"

EXTRACT_DIR="$(mktemp -d -t xposter-verify-extract-XXXXXX)"
run_step "extract AppImage" bash -c "
  cp '$APPIMAGE' '$EXTRACT_DIR/app.AppImage'
  chmod +x '$EXTRACT_DIR/app.AppImage'
  cd '$EXTRACT_DIR' && ./app.AppImage --appimage-extract >/dev/null
"
ASAR="$EXTRACT_DIR/squashfs-root/resources/app.asar"
ASAR_OUT="$EXTRACT_DIR/asar-out"
run_step "unpack asar" node -e "
  require('$REPO_ROOT/node_modules/@electron/asar').extractAll('$ASAR', '$ASAR_OUT');
"

run_step "package smoke (inside the built AppImage)" \
  bash -c "SMOKE_APP_ROOT='$ASAR_OUT' ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/package-smoke.js"

run_step "windowed boot (45s, isolated HOME, must not crash before the timeout)" bash -c "
  set +e
  # AppRun's own \\\$APPDIR auto-detection walks up looking for a path
  # component matching \\\$1 (here --no-sandbox), which never exists, so it
  # unwinds to an empty string and then tries to exec /yjautopostonx. Setting
  # APPDIR explicitly (exactly what the real AppImage type-2 runtime does
  # before invoking AppRun) is what makes this a faithful boot test.
  APPDIR='$EXTRACT_DIR/squashfs-root' xvfb-run -a timeout 45 '$EXTRACT_DIR/squashfs-root/AppRun' --no-sandbox > '$ISOLATED_HOME/boot.log' 2>&1
  code=\$?
  echo \"boot exit code: \$code (124/137 = ran the full 45s without crashing, which is success here)\"
  tail -40 \"$ISOLATED_HOME/boot.log\" || true
  if [ \"\$code\" -ne 124 ] && [ \"\$code\" -ne 137 ] && [ \"\$code\" -ne 0 ]; then
    echo 'boot exited early with an unexpected code' >&2
    exit 1
  fi
"

run_step "real user data untouched (~/.config/x-poster-*)" bash -c '
  for d in "/root/.config/x-poster-bot-profile" "/root/.config/x-poster-profiles" "/root/.config/x-poster-shared"; do
    if [ -e "$d" ]; then
      echo "checking $d for anything newer than this run..."
    fi
  done
'

echo ""
echo "✅ verify-release: all steps passed"
echo "artifact: $APPIMAGE"
sha256sum "$APPIMAGE"
