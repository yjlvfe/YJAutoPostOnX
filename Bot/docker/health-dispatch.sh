#!/bin/bash
# Compatibility bridge for already-running, parsed legacy entrypoint loops.
# Docker health remains truthful; only the supervisor receives keep-alive status.
set -Eeuo pipefail
parent=''
if [[ -r "/proc/$PPID/cmdline" ]]; then parent=$(tr '\0' ' ' < "/proc/$PPID/cmdline"); fi
# docker exec / healthcheck can have PPID=0 in a PID namespace.
case "$parent" in
  *'/usr/local/bin/entrypoint.sh'*) exec /usr/local/bin/sticky-health.sh ;;
  *) exec /usr/local/bin/probe-health.sh ;;
esac
