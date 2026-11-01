#!/bin/bash
# Supervisor-only recovery. Never destroy a live tunnel for an external probe.
set -Eeuo pipefail
export LC_ALL=C
# BEGIN sticky decision
should_reconnect() { [[ "$1" == down && "$2" -ge 3 ]]; }
# END sticky decision
exec 9>/run/nordvpn/yj-sticky.lock
flock -n 9 || exit 0
if /usr/local/bin/probe-health.sh; then
  printf '0\n' > /run/nordvpn/yj-failures
  touch /run/nordvpn/ready
  exit 0
fi
rm -f /run/nordvpn/ready
failures=$(cat /run/nordvpn/yj-failures 2>/dev/null || printf 0)
[[ "$failures" =~ ^[0-9]{1,6}$ ]] || failures=0
failures=$((failures + 1)); ((failures <= 999999)) || failures=999999
printf '%s\n' "$failures" > /run/nordvpn/yj-failures
tunnel=down
if ip -o link show dev nordlynx 2>/dev/null | grep -q UP && ip -4 -o addr show dev nordlynx 2>/dev/null | grep -q 'inet '; then tunnel=up; fi
should_reconnect "$tunnel" "$failures" || exit 0
# Never overlap recovery and never issue provider RPCs for mere slow HTTP.
last=$(cat /run/nordvpn/yj-reconnect-at 2>/dev/null || printf 0)
[[ "$last" =~ ^[0-9]{1,12}$ ]] || last=0
now=$(date +%s)
((now - last >= 300)) || exit 0
printf '%s\n' "$now" > /run/nordvpn/yj-reconnect-at
status=$(nordvpn status 2>/dev/null) || exit 0
grep -qx 'Status: Disconnected' <<< "$status" || exit 0
target=$(cat /var/lib/nordvpn/yj-server 2>/dev/null || true)
[[ "$target" =~ ^[a-z]{2}[0-9]{2,6}\.nordvpn\.com$ ]] || exit 0
printf '%s\n' 'Confirmed disconnected tunnel: reconnecting pinned server' >&2
nordvpn connect "$target" >/dev/null 2>&1 || true
# Remain alive even when the provider cannot recover. Real health remains false.
exit 0
