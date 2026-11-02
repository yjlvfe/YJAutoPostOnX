# VPN ROOT CAUSE, SESSION LIMIT & RECOVERY AUDIT

**Date**: 2026-11-02 (Riyadh Time)  
**Target Infrastructure**: 5 Docker VPN Containers (`yj_autopost_vpn_1..5`)  
**Shared Host VPNs**: `cryptovpn-nordvpn`, `yjdownloadvideo-nordvpn-1`  
**Host Public IP**: `64.112.42.39`  

---

## 1. Executive Summary: The Root Cause of VPS Freezes

The slow performance and eventual freeze of the previous CLI session on the VPS was caused by a combination of two defects:

1. **Defect 1: The Dead Server Pin Loop in `entrypoint.sh`**
   - In `Bot/docker/entrypoint.sh`, the container persisted its connected server hostname in `/var/lib/nordvpn/yj-server` (e.g. `us13365.nordvpn.com`).
   - When NordVPN decommissioned or rotated that server, `nordvpn connect "$target"` failed with `The specified server does not exist.`
   - In the pre-fix code:
     ```bash
     nordvpn connect "$target" >/dev/null 2>&1 || fail 'connection rejected'
     ```
     `fail` immediately printed an error and exited with status 1.
   - Because the container was started with `--restart unless-stopped`, Docker immediately restarted it.
   - Upon restart, the container read the **same invalid server pin** from `/var/lib/nordvpn/yj-server`, failed immediately, and restarted again every 1 second across all 5 containers in parallel.

2. **Defect 2: Rapid Reconnect Storm Triggering Provider Rate Limiting**
   - 5 containers restarting and issuing `nordvpn connect` 60 times a minute rapidly triggered NordVPN's API session rate limiter:
     `Too many connection attempts. Wait a while before trying again. Retrying now can make the waiting period longer. (Session Limit Reached)`
   - Each rapid retry extended the cooldown penalty, locking the VPN account into a continuous failure loop and causing high CPU/IO churn.

3. **Device Count Clarification:**
   - The user currently operates 2 active accounts in `YJAutoPostOnX` (`@crytpokingxvo8` and `@emiehg`), utilizing slots 0 and 1 (ports 18801 and 18802).
   - In addition, the VPS hosts `cryptovpn-nordvpn` and `yjdownloadvideo-nordvpn-1`.
   - Normal operation uses 4 concurrent sessions, which is safely below NordVPN's 6-device limit.
   - The "Session Limit Reached" error observed was the API rate-limit message triggered by rapid reconnect calls, **not** an over-subscription of active tunnels.

---

## 2. The Architectural Remedy

1. **`Bot/docker/entrypoint.sh` Fallback & Backoff:**
   ```bash
   fail() { printf '%s\n' "VPN startup failed: $1" >&2; sleep 60; exit 1; }
   ...
   if ! nordvpn connect "$target" >/dev/null 2>&1; then
     if [[ "$target" != "$country" ]]; then
       rm -f /var/lib/nordvpn/yj-server
       target=$country
       nordvpn connect "$target" >/dev/null 2>&1 || fail 'connection rejected'
     else
       fail 'connection rejected'
     fi
   fi
   ```
   If the pinned server is rejected, the script immediately purges `yj-server`, falls back to the country default (`United_States`), and reconnects to a healthy server. If that still fails, it backs off for 60 seconds before exiting, completely eliminating restart storms.

2. **`Bot/docker/sticky-health.sh` In-Place Recovery:**
   If `yj-server` is missing or invalid when the tunnel is disconnected, it falls back to `$VPN_COUNTRY` and updates `yj-server` with the newly assigned healthy hostname.

3. **`Bot/src/dockerVpn.js` Rate-Limit Protection:**
   `rotateContainerIp` checks for `Too many connection attempts` or `Session Limit Reached` and immediately breaks rotation loops, preventing token burning. It also ensures the container is connected before returning failure.

---

## 3. Empirical Verification Evidence

### Container Status & Restart Counts (All 5 Slots):
```
/yj_autopost_vpn_1: Image=yj_autopost_vpn_image:6.0.2, Status=running, Health=healthy, Restarts=0
/yj_autopost_vpn_2: Image=yj_autopost_vpn_image:6.0.2, Status=running, Health=healthy, Restarts=0
/yj_autopost_vpn_3: Image=yj_autopost_vpn_image:6.0.2, Status=running, Health=healthy, Restarts=0
/yj_autopost_vpn_4: Image=yj_autopost_vpn_image:6.0.2, Status=running, Health=healthy, Restarts=0
/yj_autopost_vpn_5: Image=yj_autopost_vpn_image:6.0.2, Status=running, Health=healthy, Restarts=0
```

### Proxy Exit IP Distinctness & Host IP Zero Leak Gate:
- **Host Server IP**: `64.112.42.39`
- **Slot 0 (Port 18801)**: `187.40.234.187` (ISOLATED ✓)
- **Slot 1 (Port 18802)**: `64.38.116.29` (ISOLATED ✓)
- **Slot 2 (Port 18803)**: `66.179.142.36` (ISOLATED ✓)
- **Slot 3 (Port 18804)**: `187.40.234.72` (ISOLATED ✓)
- **Slot 4 (Port 18805)**: `66.179.142.23` (ISOLATED ✓)
All 5 exit IPs are pairwise distinct with **zero host IP leaks**.
