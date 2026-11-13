#!/bin/bash
# Read-only bounded hostname check. Never repairs/reconnects or overwrites pin.
set -Eeuo pipefail
export LC_ALL=C
target=$(cat /var/lib/nordvpn/yj-server 2>/dev/null) || exit 1
[[ "$target" =~ ^[a-z]{2}[0-9]{2,6}\.nordvpn\.com$ ]] || exit 1
status=$(timeout 5 nordvpn status 2>/dev/null) || exit 1
grep -qx 'Status: Connected' <<< "$status" || exit 1
server=$(sed -n 's/^Hostname: //p' <<< "$status")
[[ "$server" == "$target" ]] || exit 1
