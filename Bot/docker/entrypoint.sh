#!/bin/bash
# Image-owned supervision. Do not enable shell tracing: login uses a secret.
set -Eeuo pipefail
umask 077
export LC_ALL=C
unset TOKEN NORDVPN_TOKEN
DAEMON_PID='' PROXY_PID='' BOOT_GUARD_PID=''
fail() { printf '%s\n' "VPN startup failed: $1" >&2; exit 1; }
cleanup() {
  trap - EXIT TERM INT
  rm -f /run/nordvpn/ready
  [[ -z "$BOOT_GUARD_PID" ]] || kill "$BOOT_GUARD_PID" 2>/dev/null || true
  [[ -z "$PROXY_PID" ]] || kill "$PROXY_PID" 2>/dev/null || true
  [[ -z "$DAEMON_PID" ]] || kill "$DAEMON_PID" 2>/dev/null || true
  # tini/Docker owns final descendant cleanup; do not wait forever on a hung RPC.
  true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
mkdir -p /run/nordvpn /var/lib/nordvpn /root/.config/nordvpn
chmod 700 /root/.config/nordvpn
rm -f /run/nordvpn/ready /run/nordvpn/origin-ip
# Docker restart retains the writable layer but not processes. A stale provider
# PID can alias a new shell/curl PID and make nordvpnd exit as already running.
# BEGIN runtime reset
rm -f /run/nordvpn/nordvpnd.pid /run/nordvpn/nordvpnd.sock
# END runtime reset
[[ -c /dev/net/tun ]] || fail 'TUN device unavailable'

# IPv6 is denied even if Docker sysctl flags were omitted. Fail if rules cannot be installed.
ip6tables -w -P INPUT DROP
ip6tables -w -P FORWARD DROP
ip6tables -w -P OUTPUT DROP
for scope in all default; do
  [[ "$(cat /proc/sys/net/ipv6/conf/$scope/disable_ipv6)" == 1 ]] || fail 'IPv6 must be disabled by container sysctl'
done

# Independent, UID-scoped egress guard survives provider disconnects/firewall changes.
# Root is reserved for the provider control plane; only UID 10001 carries consumer traffic.
iptables -w -N YJ_SOCKS_OUT 2>/dev/null || iptables -w -F YJ_SOCKS_OUT
iptables -w -A YJ_SOCKS_OUT -o nordlynx -j ACCEPT
# Kernel WireGuard envelopes inherit the initiating SOCKS UID; only the trusted
# provider's SO_MARK + WireGuard transport port may leave outside the tunnel.
# UID 10001 has no capability to set SO_MARK or create arbitrary raw packets.
iptables -w -A YJ_SOCKS_OUT -p udp --dport 51820 -m mark --mark 0xe1f1 -j ACCEPT
# Replies on inbound Docker-published SOCKS sessions are not new Internet connections.
iptables -w -A YJ_SOCKS_OUT -p tcp --sport 1080 -m conntrack --ctstate ESTABLISHED -j ACCEPT
iptables -w -A YJ_SOCKS_OUT -j REJECT
iptables -w -I OUTPUT 1 -m owner --uid-owner 10001 -j YJ_SOCKS_OUT
# A separate nftables base chain executes AFTER iptables filter rules. An earlier
# provider ACCEPT cannot bypass its reject; provider iptables flushes cannot remove it.
nft delete table inet yj_guard 2>/dev/null || true
nft -f - <<'NFT'
table inet yj_guard {
  chain output {
    type filter hook output priority 100; policy accept;
    meta nfproto ipv6 drop
    meta skuid 10001 oifname "nordlynx" accept
    meta skuid 10001 meta mark 0xe1f1 udp dport 51820 accept
    meta skuid 10001 tcp sport 1080 ct state established ct direction reply accept
    meta skuid 10001 reject
  }
}
NFT
# Never send proxy DNS through Docker's host resolver; DNS can leave only via nordlynx.
printf 'nameserver 103.86.96.100\nnameserver 103.86.99.100\n' > /etc/resolv.conf

# Capture the untunnelled namespace IP before starting the VPN daemon, every boot.
origin=$(curl --noproxy '*' --ipv4 --fail --silent --max-time 15 https://api.ipify.org) || fail 'origin IP unavailable'
[[ "$origin" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'origin IP invalid'
printf '%s\n' "$origin" > /run/nordvpn/origin-ip
# Bound a hung provider startup by ending this entire namespace, never just its CLI.
# There is no proxy yet; Docker restarts the same persisted identity after this fails.
(sleep 170; kill -KILL "$$") &
BOOT_GUARD_PID=$!
# Private namespace-local diagnostics; never stream provider HTTP/auth logs.
/usr/sbin/nordvpnd >/run/nordvpn/daemon.log 2>&1 &
DAEMON_PID=$!
# No CLI timeouts: killing an in-flight provider RPC can wedge its daemon.
ready=0
for ((i=0; i<30; i++)); do
  kill -0 "$DAEMON_PID" 2>/dev/null || fail 'provider daemon exited'
  if nordvpn status >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]] || fail 'provider daemon unavailable'
nordvpn set analytics off >/dev/null 2>&1 || fail 'analytics configuration'
nordvpn set protocol nordlynx >/dev/null 2>&1 || fail 'protocol configuration'
# Preserve authenticated device/session state. Never call logout (shared tokens are account-wide).
if ! nordvpn account 2>/dev/null | grep -qi 'Account information'; then
  token_file=${NORDVPN_TOKEN_FILE:-/run/secrets/nordvpn_token}
  [[ -f "$token_file" && -r "$token_file" ]] || fail 'read-only token file required'
  token=$(<"$token_file")
  [[ "$token" =~ ^[A-Za-z0-9_-]{16,256}$ ]] || fail 'token format invalid'
  nordvpn login --token "$token" >/dev/null 2>&1 || fail 'authentication rejected'
  unset token
fi
# These settings require an authenticated account in NordVPN 6.x.
nordvpn set autoconnect off >/dev/null 2>&1 || fail 'autoconnect configuration'
nordvpn set firewall on >/dev/null 2>&1 || fail 'provider firewall configuration'
nordvpn set killswitch on >/dev/null 2>&1 || fail 'kill switch configuration'
# NordVPN returns 1 for these two no-op setters after identity-volume reuse.
# BEGIN idempotent settings
configure() {
  local output
  if output=$(nordvpn "$@" 2>&1); then return 0; fi
  case "$output" in
    'DNS is already set to 103.86.96.100, 103.86.99.100.'|'Port 1080 (UDP|TCP) is already on the allowlist.') return 0 ;;
    *) return 1 ;;
  esac
}
# END idempotent settings
configure set dns 103.86.96.100 103.86.99.100 || fail 'DNS configuration'
configure allowlist add port 1080 || fail 'SOCKS ingress allowlist'
country=${VPN_COUNTRY:-United_States}
[[ "$country" =~ ^[A-Za-z][A-Za-z_\ -]{0,63}$ ]] || fail 'country invalid'
target=$country
if [[ -s /var/lib/nordvpn/yj-server ]]; then
  target=$(</var/lib/nordvpn/yj-server)
  [[ "$target" =~ ^[a-z]{2}[0-9]{2,6}\.nordvpn\.com$ ]] || fail 'pinned server invalid'
fi
nordvpn connect "$target" >/dev/null 2>&1 || fail 'connection rejected'
server=$(nordvpn status | sed -n 's/^Hostname: //p')
[[ "$server" =~ ^[a-z]{2}[0-9]{2,6}\.nordvpn\.com$ ]] || fail 'connected server unknown'
if [[ -s /var/lib/nordvpn/yj-server ]]; then
  [[ "$server" == "$target" ]] || fail 'connected server differs from pinned server'
else
  printf '%s\n' "$server" > /var/lib/nordvpn/yj-server.new
  mv /var/lib/nordvpn/yj-server.new /var/lib/nordvpn/yj-server
fi
# Provider must not have removed our independent consumer firewall rule.
iptables -w -C OUTPUT -m owner --uid-owner 10001 -j YJ_SOCKS_OUT || fail 'consumer firewall missing'
runuser -u socks -- microsocks -i 0.0.0.0 -p 1080 >/dev/null 2>&1 &
PROXY_PID=$!
kill "$BOOT_GUARD_PID" 2>/dev/null || true
BOOT_GUARD_PID=''
failures=0
while true; do
  kill -0 "$DAEMON_PID" 2>/dev/null || fail 'provider daemon exited'
  kill -0 "$PROXY_PID" 2>/dev/null || fail 'SOCKS daemon exited'
  /usr/local/bin/sticky-health.sh || true
  sleep 20 & wait $!
done
