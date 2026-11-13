#!/bin/sh
set -eu

# Repository template only. Installing/running it against production is a
# separate manual deployment action; static checks never start the bot.
APP_DIR=${BOT_APP_DIR:?BOT_APP_DIR must be set to the Bot checkout}
DATA_DIR=${BOT_DATA_DIR:-$APP_DIR/data}
NODE=${NODE_BIN:-/usr/local/bin/node}

case "$APP_DIR" in /*) ;; *) printf '%s\n' 'BOT_APP_DIR must be an absolute path' >&2; exit 64 ;; esac
case "$DATA_DIR" in /*) ;; *) printf '%s\n' 'BOT_DATA_DIR must be an absolute path' >&2; exit 64 ;; esac
case "$NODE" in /*) ;; *) printf '%s\n' 'NODE_BIN must be an absolute path' >&2; exit 64 ;; esac
[ -f "$APP_DIR/src/index.js" ] || { printf '%s\n' 'index entrypoint contract missing' >&2; exit 66; }
[ -f "$APP_DIR/src/runner.js" ] || { printf '%s\n' 'daemon entrypoint missing' >&2; exit 66; }
[ -f "$APP_DIR/package.json" ] || { printf '%s\n' 'package manifest missing' >&2; exit 66; }
[ -x "$NODE" ] || { printf '%s\n' 'node is not executable' >&2; exit 69; }

# src/env.js loads this path itself. Check metadata only; never source, print,
# reformat or change permissions on operator config/credentials at startup.
CONFIG=$APP_DIR/.env.local
if [ ! -f "$CONFIG" ] || [ -L "$CONFIG" ]; then
  printf '%s\n' 'private config must be a regular non-symlink .env.local' >&2; exit 78
fi
CONFIG_MODE=$(stat -c '%a' -- "$CONFIG")
CONFIG_OWNER=$(stat -c '%u' -- "$CONFIG")
case "$CONFIG_MODE" in 400|600) ;; *) printf '%s\n' 'private config must be mode 0400 or 0600' >&2; exit 78 ;; esac
[ "$CONFIG_OWNER" = "$(id -u)" ] || { printf '%s\n' 'private config must be owned by the service identity' >&2; exit 78; }
BACKEND=${STORAGE_BACKEND:-postgres}
[ "$BACKEND" = postgres ] || { printf '%s\n' 'this service requires the PostgreSQL backend' >&2; exit 78; }

umask 077
mkdir -p "$DATA_DIR"
# Restrictive defaults apply to NEW files only. Existing directory/file modes
# require a reviewed operator remediation, not recursive startup mutation.
export BOT_APP_DIR="$APP_DIR" BOT_DATA_DIR="$DATA_DIR" STORAGE_BACKEND=postgres
cd "$APP_DIR"
exec "$NODE" src/index.js
