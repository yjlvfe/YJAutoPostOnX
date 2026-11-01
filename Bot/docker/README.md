# Independent per-account VPN image

Build from **only this directory** (no parent/sibling build context or secrets):

```sh
cd /root/Projects/YJAutoPostOnX/Bot
docker build --progress=plain -f docker/Dockerfile.vpn -t yj_autopost_vpn_image:6.0.2 -t yj_autopost_vpn_image:latest docker
# Default NORDVPN_VERSION is pinned to 6.0.2 (FINDING-031):
# docker build --build-arg NORDVPN_VERSION=6.0.2 -f docker/Dockerfile.vpn -t yj_autopost_vpn_image:6.0.2 docker
node --test test/independentVpn.test.js
```

Ubuntu 24.04 + signed official NordVPN apt repository + distro microsocks/tini/nftables/iptables. The signing-key fingerprint is checked. Default upstream package/base tags are mutable; record the built image ID and package version for each deployment. NordVPN 6.x uses `set protocol nordlynx`, not the removed `set technology` command.

## Credential contract

The bot accepts `NORDVPN_TOKEN_FILE=/absolute/private/path/nordvpn_token`; this is a **path**, not a token. The operator provisions a single-line NordVPN access token out of band into a root/service-owned 0400/0600 regular file inside a 0700 directory. No symlinks, relative paths or group/world access. No token in `.env`, CLI shell history, build args, Docker environment, logs or source. The mount target is `/run/secrets/nordvpn_token:ro`. Inline `token` options and old `NORDVPN_TOKEN`/`TOKEN` environment values are not supported. The provider CLI still receives the token in its short-lived in-container `login --token` argv: host root/Docker administrators can observe it, as they can read mounts. Docker access is a trusted-administrator boundary. Do not enable shell tracing.

Fresh containers log in only if `nordvpn account` does not show an existing account. Never run logout: token revocation is account-wide. Per-slot named volumes persist both `/var/lib/nordvpn` (`yj_autopost_vpn_N_state`) and `/root/.config/nordvpn` (`yj_autopost_vpn_N_auth`). Restrict and back these up as credentials. Removal intentionally omits `-v`; volume reclamation and provider-device removal are explicit operator tasks. Slots reused for a new account keep the slot's device identity, avoiding device registrations on every delete/recreate.

## Runtime and protection

`VpnSlotManager.ensure()` allocates slots 0–4 and publishes only `127.0.0.1:18801..18805 -> 1080`. It creates containers with NET_ADMIN, TUN, IPv6 disable sysctls, no-new-privileges, restart=unless-stopped and ownership/contract labels. It starts a compatible stopped container **in place**, rather than removing it. It performs no `docker exec` proxy installation or background startup. The image owns its daemon and permanent unprivileged UID-10001 microsocks. A daemon/proxy child death exits the supervisor (true process failure). External probe failures no longer exit it or rotate the tunnel. `sticky-health.sh` reconnects only after three failed probes plus a missing/down tunnel and explicit provider Disconnected status, with a 300-second reconnect cooldown and the pinned hostname in `/var/lib/nordvpn/yj-server`. Docker health stays false until full protected SOCKS HTTPS succeeds. Existing parsed legacy loops use `health-dispatch.sh` to distinguish supervisor keep-alive from truthful Docker probes; replacing the loop text alone cannot hot reload Bash. Startup is bounded by an independent 170-second guard; no individual hung provider CLI is abandoned in a surviving namespace.

The image installs provider firewall + kill switch and a second UID-scoped nftables output chain at priority 100. Consumer-originated plaintext connections, including remote SOCKS DNS, can leave only `nordlynx`; only established inbound SOCKS replies may go to the Docker host. Kernel WireGuard envelopes can inherit UID 10001 from the initiating process, so both guards also permit UDP/51820 bearing the provider's privileged SO_MARK `0xe1f1`. The unprivileged proxy has no effective/permitted capabilities and cannot set that mark. IPv6 is disabled and dropped separately. `/etc/resolv.conf` contains only provider DNS, never Docker/host DNS. Root is the trusted provider control plane and can reach the Internet before connection for authentication and origin-IP measurement; this is not a general root-egress sandbox. Do not add arbitrary root applications or namespace-sharing consumers.

Health requires an UP/addressed tunnel, active guard rules, protected DNS/IPv6, **HTTPS through SOCKS5h** and a valid exit IPv4 different from the pre-tunnel origin captured on every boot. The host also verifies the published proxy path and compares against its own current direct IP. Failure to obtain either IP fails closed. Provider/API/ipify outages can therefore make the container unavailable. A listening TCP socket or `Connected` text alone is never readiness proof.

## Safe mapping reconciliation API

```js
const plan = await manager.reconcile(); // read-only default, current state.accounts
// Review stale/conflicts; only after deployment approval:
const applied = await manager.reconcile({ dryRun: false });
// Optional authoritative account set: { accountIds: ['retained-id'], dryRun: true }
```

`reconcile` releases mappings absent from the supplied/current account set; active duplicate/out-of-range mappings fence apply. It never destroys a slot shared by a retained mapping. `release(id)` keeps the mapping reserved until container removal succeeds; absent containers count as successful removal. Manager operations serialize to prevent reuse while removal is in flight. This is process-local serialization; only one daemon/manager may mutate the store/container slots. A process crash after removal but before state update leaves a safe retryable reservation.

All legacy/unlabelled or incompatible containers are fenced with `image_migration_required`; they are **not** automatically retagged, removed, restarted or trusted. Main must explicitly migrate only this project's containers, preserve needed identity/auth state, and then apply reviewed mapping reconciliation. The runner must call reconciliation on startup/account replacement and release on every account-removal path; those integrations are outside this worker's file ownership.

## Deployment gate — operator/Main only

The original image-only implementation did not execute live tests. The subsequent authorized repair verified this project's slot-0 SOCKS HTTPS path and automatic Docker-restart recovery on NordVPN 6.0.2; see `../reports/final-independence/vpn-live-fix.md` for sanitized evidence and limitations. Before admitting production work, review the remaining gates:

1. Review/build the image; provision the private token-file path and persistent volumes. Explicitly migrate the project's legacy containers; do not touch other projects.
2. Start an authorized isolated slot with `ensure`; require Docker healthy and host SOCKS5h HTTPS IP different from host direct IP.
3. Restart **that authorized test slot only** and prove health/proxy recovery without external exec, stable identity files and no unnecessary login.
4. In that test namespace remove/disconnect the tunnel and prove UID-10001 requests and SOCKS DNS cannot use direct egress, then prove supervisor recovery. Test IPv6 denial as well. These effects must never be exercised on a live publishing account.
5. Verify caller startup/account-deletion reconciliation before deployment. No direct fallback if readiness fails.

The focused tests use injected Docker/curl transports and private temporary files, not production data. Their passing does not establish a credentialed tunnel or reboot recovery.
