#!/bin/bash
# Bounded read-only server status check; never connection-changing RPCs.
set -Eeuo pipefail
export LC_ALL=C
valid_ipv4() {
  local value=$1 octet
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local -a parts
  IFS=. read -r -a parts <<< "$value"
  for octet in "${parts[@]}"; do ((10#$octet <= 255)) || return 1; done
}
[[ -s /run/nordvpn/origin-ip ]] || exit 1
[[ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6)" == 1 ]] || exit 1
[[ "$(cat /proc/sys/net/ipv6/conf/default/disable_ipv6)" == 1 ]] || exit 1
ip -o link show dev nordlynx | grep -q 'UP' || exit 1
ip -4 -o addr show dev nordlynx | grep -q 'inet ' || exit 1
iptables -w -C OUTPUT -m owner --uid-owner 10001 -j YJ_SOCKS_OUT || exit 1
iptables -w -C YJ_SOCKS_OUT -o nordlynx -j ACCEPT || exit 1
iptables -w -C YJ_SOCKS_OUT -p udp --dport 51820 -m mark --mark 0xe1f1 -j ACCEPT || exit 1
iptables -w -C YJ_SOCKS_OUT -j REJECT || exit 1
ip6tables -w -S OUTPUT | grep -q '^-P OUTPUT DROP$' || exit 1
guard=$(nft -n list chain inet yj_guard output) || exit 1
grep -q 'hook output priority' <<< "$guard" || exit 1
grep -q 'meta skuid 10001.*reject' <<< "$guard" || exit 1
grep -q 'meta skuid 10001.*oifname "nordlynx".*accept' <<< "$guard" || exit 1
grep -qE 'meta nfproto (ipv6|10) drop' <<< "$guard" || exit 1
# A host/Docker resolver is never acceptable for remote SOCKS DNS.
grep -qx 'nameserver 103.86.96.100' /etc/resolv.conf || exit 1
if grep '^nameserver ' /etc/resolv.conf | grep -qvE '^nameserver 103\.86\.(96|99)\.100$'; then exit 1; fi
origin=$(</run/nordvpn/origin-ip)
valid_ipv4 "$origin" || exit 1
# HTTPS over SOCKS5h verifies negotiation, remote DNS, listener and real outbound bytes.
exit_ip=$(curl --noproxy '' --socks5-hostname 127.0.0.1:1080 --ipv4 --fail --silent \
  --connect-timeout 5 --max-time 15 https://api.ipify.org) || exit 1
valid_ipv4 "$exit_ip" || exit 1
[[ "$exit_ip" != "$origin" ]] || exit 1
/usr/local/bin/check-pin.sh
