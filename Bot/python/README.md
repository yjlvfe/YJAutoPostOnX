# Browserless direct X adapter

Owned implementation: `src/directX.js`, `python/direct_x_bridge.py`,
`python/direct_x_compat.py`, `requirements-direct-x.txt`.
There is **no runtime import or filesystem reference to openstanley**, no browser,
no healing/unlock service and no hidden Playwright fallback. Only plain-text posts
are supported. Unsupported payload keys are rejected rather than silently dropped.

## Install contract

Run from Bot with a supported Python environment (tested: Python 3.14.9 / Linux,
Node 26.8.2). Twikit and its protocol-sensitive HTTP dependencies are pinned and
runtime checked. Other Python versions must run these tests before deployment.
The Node adapter uses only Node built-ins; it does not require Playwright.

```sh
python3 -m venv .venv-direct-x
.venv-direct-x/bin/python -m pip install -r requirements-direct-x.txt
.venv-direct-x/bin/python -m pip check
.venv-direct-x/bin/python -m unittest discover -s python -p 'test_direct_x.py' -v
DIRECT_X_PYTHON="$PWD/.venv-direct-x/bin/python" node --test test/directX.test.js
```

Configure an **absolute** `pythonExecutable` or `DIRECT_X_PYTHON` pointing at this
venv. Do not use an interpreter supplied by a sibling project. The scratch venv
used for development is not a deployment dependency and will be pruned. A Python
3.14 upstream Js2Py `co_lnotab` deprecation warning is known; tests still pass.

## API

```js
const { DirectXAdapter } = require('./directX');
const adapter = new DirectXAdapter({
  pythonExecutable: '/absolute/path/Bot/.venv-direct-x/bin/python',
  allowPublish: true,
  openTimeoutMs: 30_000,
  publishTimeoutMs: 30_000,
});
const session = await adapter.open({ account, proxy: vpn.proxy, signal });
try {
  if (!session.identity.authenticated) throw new Error('identity rejected');
  const result = await adapter.publish({
    session, payload: { text }, confirmPublish: true, signal,
    onDispatch: async ({ accountId }) => {
      // Commit the attempt's durable 'dispatching' state in the authoritative
      // SQLite transaction. Return true ONLY if the correct item/run/account
      // is still admitted and that durable commit completed successfully.
      // No timer, event emission, in-memory flag or log is an adequate fence.
      await persistDispatchFence({ accountId, itemId, runId });
      return true;
    },
  });
} finally {
  await adapter.close({ session });
}
```

`onDispatch` may also be supplied in the constructor (closure must bind the exact
attempt). It **must explicitly return `true`**, after durable persistence. Missing
callback prevents send. Rejected, timed-out or non-true ACK is conservatively
ambiguous: a durable commit can succeed even when its acknowledgement is lost.
Once dispatch starts, the session refuses every subsequent write, even if its
child dies. Across restart/new adapter instances the runner's persisted fence is
the authority; the adapter cannot deduplicate external callers by itself.

## Required main-runner wiring (not edited by this work)

1. Import `DirectXAdapter` and choose it for the production publishing factory
   instead of `PlaywrightBrowserAdapter`. The existing `publishAdapterFactory`
   seam can provide the constructor; no fallback to a browser on failure.
2. Keep `vpnSlots.ensure(accountId)` and pass **its** `vpn.proxy` to `open`.
   Accepted strings are only `socks5h://127.0.0.1:18801` ... `18805` (or localhost).
   Slot/account assignment remains the VPN manager's durable responsibility.
3. Pass `signal` to `open` as well as `publish`. Check
   `session.identity.authenticated` before proceeding. Identity includes a
   verified authenticated handle and numeric `userId`; add-account discovery may
   omit expected username, but cannot omit actual authenticated identity.
4. Move/encapsulate the runner's current durable `dispatching` transaction
   (baseline runner lines 350–359) into `onDispatch` passed to `publish`.
   Preserve the cycle/run/item/claimed-phase and stop checks. Set the runner's
   `dispatchEntered = true` **before** attempting this transaction because a
   rejected commit acknowledgement may have committed. Return `true` only after
   a successful durable commit and positive admission. Throw otherwise. Never
   use `onDispatch: () => true` as a production shortcut.
5. Keep result semantics: `published && url` means confirmed; `ambiguous` means
   halt and manual reconciliation, never automatic retry. Pre-dispatch blocked
   auth/proxy failures may remain pending. Keep the existing crash recovery fence,
   quota (Riyadh, confirmed-only), link persistence, exports and finally-close.
6. If retaining the old pre-publish durable marker temporarily, supply a callback
   that **verifies that persisted exact attempt/run/account fence** before ACK;
   do not assume the adapter writes it automatically. Without a callback the
   adapter intentionally will not publish, even with both publish confirmations.

## Safety and result contract

- One isolated `python -I` process and in-memory jar per open account; cookies are
  read from a bounded, regular non-symlink file. JSON name/value maps, browser
  arrays / `{cookies:[...]}`, and Netscape formats are accepted. Only X/Twitter
  cookie domains are accepted; conflicting duplicate values and expired auth
  material fail closed. Cookie state is not written or shared.
- HTTPX uses one explicit SOCKS transport, `trust_env=False`, retries=0 and no
  redirects or direct mounts. Twikit's proxy setter is overridden because even
  `proxy=None` otherwise creates a bypassing **direct** `all://` mount.
  Bootstrap HTML, migration and JS requests all use this same transport. X
  hostname resolution is encoded as a SOCKS DOMAIN request, not local DNS.
  CDN bootstrap requests have cookie/auth/CSRF headers removed. Targets outside
  the explicit HTTPS X/Twitter/API/static-CDN allowlist are blocked.
- The authenticated settings endpoint must provide an actual handle, then the
  matching user must provide a numeric ID. Missing/mismatched/changing identity
  blocks before any dispatch. The check is repeated immediately before dispatch.
  No requested/expected handle is substituted for missing actual identity.
- CreateTweet is called once after the durable ACK. No auto-unlock, healing,
  captcha, 429 replay, redirected POST, transport retry or write retry exists.
  Success requires the returned tweet's numeric ID and author handle **and user
  ID** to match the authenticated identity. Canonical URL is built only then.
- Unreadable/missing confirmation, wrong author/ID, HTTP/API failure, reset,
  process failure, cancellation or timeout after dispatch is ambiguous. The
  runner must not retry it, including with a newly opened session.
- `open` and `publish` have bounded deadlines (30 seconds each by default);
  network requests have 10-second phase timeouts. `close` kills the isolated
  process without waiting on network shutdown. Thus adapter work in a normal
  open/publish/close attempt is bounded by roughly the sum of both deadlines,
  excluding OS scheduling. VPN ensure / store persistence / runner work need
  their own outer attempt deadline. Signal kills a blocked bridge immediately.
- Public errors and logs never include cookies, payloads, remote response bodies
  or Python tracebacks. Stderr is drained and discarded by the parent.

## Compatibility and limits

The independent patch supports current/legacy ondemand webpack chunk lookup,
optional transaction-ID degradation, and missing non-identity user description
fields (via an idempotent process-scoped `twikit.user.User.__init__` normalization
wrapper `_compat_user_data` in the isolated single-account bridge process). If X
changes the private API, it may stop working. A missing transaction header never
counts as identity proof. Migration redirect failures are blocked, not bypassed;
no direct fallback. Browser onboarding/session verifier replacement is separate
runner integration work.

Tests use fixture identities/payloads and intercepted HTTP/socket I/O. They test
actual Twikit bootstrap/create_tweet and HTTPX/SOCKS internals, plus real child
process timeout/ACK/cancellation handling. **No live X read or publish was run.**
This is implemented code with offline regression evidence, not a claim that the
current live X private API accepted it. A separately authorized canary is needed
after integration; do not run it as part of installation/tests.
