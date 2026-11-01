#!/bin/sh
set -eu

# Keep the launcher boring and auditable: no shell expansion of secret values.
# The unit (or operator) must provide the checkout explicitly. This prevents a
# stale /opt path from silently selecting the wrong release.
#
# src/index.js exports createBot when imported and invokes the one production
# runner only when executed directly. Keep that explicit daemon entrypoint.
APP_DIR=${BOT_APP_DIR:?BOT_APP_DIR must be set to the Bot checkout}
DATA_DIR=${BOT_DATA_DIR:-$APP_DIR/data}
NODE=${NODE_BIN:-/usr/local/bin/node}
RUNNER=src/runner.js
INDEX=src/index.js

ENTRYPOINT_CONTRACT="$APP_DIR/$INDEX"
DAEMON_ENTRYPOINT="$APP_DIR/$RUNNER"

[ -f "$ENTRYPOINT_CONTRACT" ] || { echo "index entrypoint contract missing: $ENTRYPOINT_CONTRACT" >&2; exit 66; }
[ -f "$DAEMON_ENTRYPOINT" ] || { echo "daemon entrypoint missing: $DAEMON_ENTRYPOINT" >&2; exit 66; }
[ -f "$APP_DIR/package.json" ] || { echo "package manifest missing: $APP_DIR/package.json" >&2; exit 66; }

case "$APP_DIR" in
  /*) ;;
  *) echo 'BOT_APP_DIR must be an absolute path' >&2; exit 64 ;;
esac
case "$DATA_DIR" in
  /*) ;;
  *) echo 'BOT_DATA_DIR must be an absolute path' >&2; exit 64 ;;
esac
[ -x "$NODE" ] || { echo "node is not executable: $NODE" >&2; exit 69; }

umask 077
mkdir -p "$DATA_DIR"
chmod go-rwx "$DATA_DIR"
find "$DATA_DIR" -type f -exec chmod go-rwx {} +
export BOT_APP_DIR="$APP_DIR" BOT_DATA_DIR="$DATA_DIR"
cd "$APP_DIR"
exec "$NODE" src/index.js
