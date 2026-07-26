const fs = require('fs').promises;
const path = require('path');
const { launchBrowser } = require('./browserManager');
const { DurableSession } = require('./durableSession');
const { profileDataDir } = require('./profileRegistry');
const { ReportEngine } = require('./reportEngine');
const rateLimitStore = require('./rateLimitStore');
const { RunRegistry, DEFAULT_JOIN_TIMEOUT_MS } = require('./runControl');
// 🔓 DECOUPLED: publishing is 100% referral-agnostic. The referral link is a
// STUDIO concern — it's baked into post text at generation time. This engine
// only takes posts from the queue and publishes them AS-IS: no referral gate,
// no link sanitization, no link validation. (referralService/validator are
// intentionally NOT imported here — see v5.9.1.)

// 🔧 Platform-aware key label — shown in status messages (Ctrl+Enter / ⌘+Enter).
// Note: Playwright's 'ControlOrMeta' virtual key handles the actual shortcut,
// so we only need the display label here.
const PLATFORM_KEY_LABEL = process.platform === 'darwin' ? '⌘' : 'Ctrl';

function parseSpintax(text) {
  const regex = /\{([^{}]+)\}/g;
  return text.replace(regex, (match, options) => {
    const choices = options.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

// Interruptible replacements for Playwright blocking calls — poll every 500ms
// and check global.isRunning, enabling instant stop-button response.
async function waitForSelectorInterruptible(page, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!global.isRunning) throw new Error('STOPPED_BY_USER');
    const el = await page.$(selector);
    if (el) return el;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

async function waitForFunctionInterruptible(page, pageFn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!global.isRunning) throw new Error('STOPPED_BY_USER');
    try {
      const result = await page.evaluate(pageFn);
      if (result) return result;
    } catch (e) {
      // Element or DOM not ready — continue polling
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// 🛑 Stop-button responsiveness: every fixed delay in the posting flow must
// go through this instead of a raw setTimeout — it polls global.isRunning
// every ≤200ms so pressing Stop takes effect almost immediately instead of
// waiting out whatever delay happens to be in flight (previously up to 10s+
// on the pre-recovery wait alone).
async function interruptibleDelay(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!global.isRunning) throw new Error('STOPPED_BY_USER');
    await new Promise(r => setTimeout(r, Math.min(200, ms - (Date.now() - start))));
  }
}

// 🚫 Rate-limit text scan — extracted so it can run mid-retry (as soon as the
// first attempt fails) instead of only after all 3 retries are burned against
// an already-limited account.
const RATE_LIMIT_PATTERNS = [
  /\brate\b.*\blimit\b/i, /\btoo many requests\b/i, /\b429\b/,
  /\bplease wait a few minutes\b/i, /\brate limited\b/i, /\bratelimit\b/i,
  /معدل\s+الطلبات/i, /تم\s+تقييد/i, /حالة\s+معدل/i,
  // X.com specific rate limit error messages
  /you are unable to post/i, /slow down/i, /temporary limit/i,
];
// ⛔ Daily-post-limit URL detection: when the account hits its daily limit,
// X sometimes still shows a confirmation toast — but its link points to the
// premium upsell page (https://x.com/i/premium_sign_up?referring_page=daily_post_limit)
// instead of a real /status/<id> URL. The old code captured that link as the
// post URL and counted the post as a SUCCESS, silently burning the queue
// against a limited account. Any captured URL matching this is a rate limit.
const LIMIT_URL_RE = /premium_sign_up|daily_post_limit/i;
const activeContexts = new Set();

/**
 * Every live run's cancellation token. Stop flips all of them synchronously,
 * so no run anywhere can start a new dispatch, and only THEN joins.
 */
const runRegistry = new RunRegistry();

/**
 * Stop every active run and wait for it to actually be over.
 *
 * The old version set a boolean, fired context.close() and resolved — before
 * any in-flight keystroke had settled and before any worker had unwound. That
 * is why Stop could report success while a post was on its way out.
 *
 * Order matters and is not negotiable:
 *   1. flip every token (synchronous) — no new dispatch can be claimed;
 *   2. flip the legacy global so the interruptible waits unblock;
 *   3. join every in-flight dispatch, with a timeout that is reported, never
 *      swallowed into success;
 *   4. only then close the browser contexts.
 *
 * Closing contexts first would tear the page out from under a keystroke that
 * had already been committed durably, turning a knowable outcome into an
 * unnecessary ambiguous one.
 */
async function stopActive(reason = 'user_stop', { joinTimeoutMs = DEFAULT_JOIN_TIMEOUT_MS } = {}) {
  const stop = runRegistry.stopAll(reason, joinTimeoutMs);
  global.isRunning = false;

  const results = await stop.join();
  const timedOut = results.filter((r) => r.timedOut);

  await Promise.allSettled(Array.from(activeContexts, context => context.close()));

  return {
    stopped: timedOut.length === 0,
    reason,
    runsJoined: results.length,
    dispatchInFlight: stop.dispatchInFlight,
    timedOut: timedOut.length,
    runs: results,
  };
}
function isLimitUrl(url) {
  return typeof url === 'string' && LIMIT_URL_RE.test(url);
}

const TOAST_ERROR_RE = /something went wrong|failed|could not|unable to post|try again|duplicate|خطأ|فشل|تعذر|لم يتم/i;
const TOAST_SUCCESS_RE = /post was sent|your post was sent|posted|تم النشر|تم الإرسال/i;

async function inspectToast(toast) {
  if (!toast) return null;
  let text = '';
  let href = null;
  try { if (typeof toast.textContent === 'function') text = (await toast.textContent()) || ''; } catch {}
  try {
    const link = await toast.$('a');
    if (link) href = await link.getAttribute('href');
  } catch {}
  if (href && !href.startsWith('http')) href = `https://x.com${href}`;
  const signature = `${href || ''}|${text.trim()}`;
  if (isLimitUrl(href) || RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text))) {
    return { kind: 'rate-limit', href, text, signature };
  }
  if (href && /\/status\//i.test(href)) return { kind: 'confirmed', href, text, signature };
  if (TOAST_ERROR_RE.test(text)) return { kind: 'error', href, text, signature };
  if (TOAST_SUCCESS_RE.test(text)) return { kind: 'unconfirmed', href, text, signature };
  return { kind: 'unknown', href, text, signature };
}

async function getToastSnapshot(page) {
  try { return await inspectToast(await page.$('[data-testid="toast"]')); }
  catch { return null; }
}

async function waitForPostConfirmation(page, baseline, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!global.isRunning) throw new Error('STOPPED_BY_USER');
    const snapshot = await getToastSnapshot(page);
    if (snapshot && snapshot.signature !== baseline?.signature) {
      if (snapshot.kind === 'confirmed' || snapshot.kind === 'unconfirmed') return snapshot;
      if (snapshot.kind === 'rate-limit') {
        const err = new Error('RATE_LIMIT_TOAST');
        err.toastText = snapshot.text;
        throw err;
      }
      if (snapshot.kind === 'error') throw new Error(`X_TOAST_ERROR: ${snapshot.text || 'unknown error'}`);
    }
    await interruptibleDelay(200);
  }
  throw new Error('Timeout waiting for a fresh post confirmation');
}

async function scanForRateLimit(page) {
  try {
    const pageContent = await page.evaluate(() => document.body.innerText);
    return { isRateLimited: RATE_LIMIT_PATTERNS.some(p => p.test(pageContent)), pageContent };
  } catch (e) {
    try {
      const pageContent = await page.content();
      return { isRateLimited: RATE_LIMIT_PATTERNS.some(p => p.test(pageContent)), pageContent };
    } catch (e2) {
      return { isRateLimited: false, pageContent: '' };
    }
  }
}

// ⚡ C5/M5: escape a CSV field — wraps in double quotes and doubles
// any embedded double-quotes, per RFC 4180. Prevents column injection
// when errorMsg / postUrl / postText contain commas, quotes, or newlines.
function escCsv(value) {
  const s = (value == null ? '' : String(value));
  return '"' + s.replace(/"/g, '""') + '"';
}

function getReportDir(profileName) {
  return path.join(profileDataDir(profileName), 'reports');
}

// 🚨 Consecutive unrecognized-failure circuit breaker — see reportRateLimitAndThrow.
const CONSECUTIVE_FAILURE_LIMIT = 3;

// The cap on how many times one post may be deferred before it is retired now
// lives in the store (WorkflowStore's maxPreDispatchFailures), so a post that is
// actually broken can never defer forever across runs or processes. The old
// module-local DEFER_ATTEMPTS_LIMIT counted only within a single run.

// 🔗 Last-resort tweet URL lookup: scans the DOM for a status link when the
// confirmation toast disappeared before we could read its href. This was
// previously called but never defined (a dangling reference left over from
// an earlier refactor) — every call silently threw a ReferenceError that got
// swallowed by the enclosing try/catch, so postUrl always fell through to
// 'N/A' in the output CSV whenever the toast-link read failed.
async function getTweetUrlFromDOM(page) {
  try {
    const href = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/status/"]');
      return link ? link.getAttribute('href') : null;
    });
    if (!href) return null;
    return href.startsWith('http') ? href : `https://x.com${href}`;
  } catch (e) {
    return null;
  }
}

// Anti-detection floor between two posts. Even at speed 0 the engine never
// fires two tweets back to back — that pattern is exactly what gets an account
// flagged. Overridable only through `config`, never from the UI.
const DEFAULT_MIN_COOLDOWN_MS = 15_000;
// Pause before attempting DOM recovery after a network/timeout failure, giving
// a flapping connection time to settle instead of retrying into the same fault.
const DEFAULT_NETWORK_RECOVERY_MS = 10_000;

/**
 * Wait between posts: a random point between the anti-detection floor and the
 * user's configured speed. Identical at both call sites (normal completion and
 * the deferred-failure branch), so it lives here rather than being written out
 * twice with two chances to drift.
 */
function nextCooldownMs(speed, minCooldownMs) {
  const baseCooldownMs = speed * 60 * 1000;
  const span = baseCooldownMs - minCooldownMs + 1;
  return Math.floor(Math.random() * span) + minCooldownMs;
}

async function start(config, onStatus) {
  const { speed, maxPosts, outputFolder, profile } = config;
  const profileName = profile || 'Default';
  // Timing overrides. The app never sets these; the test harness sets them to 0
  // so the suite does not spend minutes asleep proving logic that has nothing
  // to do with waiting. Absent or invalid values fall back to the real floors,
  // so a missed override slows a run down — it can never silently remove the
  // anti-detection gap in production.
  const minCooldownMs = Number.isFinite(config.minCooldownMs) && config.minCooldownMs >= 0
    ? config.minCooldownMs : DEFAULT_MIN_COOLDOWN_MS;
  const networkRecoveryMs = Number.isFinite(config.networkRecoveryMs) && config.networkRecoveryMs >= 0
    ? config.networkRecoveryMs : DEFAULT_NETWORK_RECOVERY_MS;

  // ⚡ M5: validate outputFolder early — create it if missing so the CSV
  // appendFile calls below never hit ENOENT. Best-effort; a failure here
  // is reported but doesn't block posting.
  if (!outputFolder || typeof outputFolder !== 'string' || !outputFolder.trim()) {
    onStatus({ type: 'warning', message: '⚠️ لم يتم تحديد مجلد الإخراج — ستُتجاوز سجلات CSV.' });
  } else {
    try { await fs.mkdir(outputFolder, { recursive: true }); }
    catch (e) { onStatus({ type: 'warning', message: `تعذّر إنشاء مجلد الإخراج: ${e.message}` }); }
  }

  // 🚫 Refuse to start a profile that is still cooling down from a rate limit.
  const existingCd = rateLimitStore.getCooldown(profileName);
  if (existingCd) {
    const remainTxt = rateLimitStore.formatRemaining(existingCd.remainingMs);
    onStatus({
      type: 'error',
      message: `⏳ البروفايل "${profileName}" تحت كول داون — متبقٍّ ${remainTxt}. تم تخطّيه.`,
      rateLimited: true,
      profile: profileName,
      cooldownUntil: existingCd.until,
    });
    return { status: 'cooldown', profile: profileName, cooldownUntil: existingCd.until, success: 0, failed: 0 };
  }

  const report = new ReportEngine(getReportDir(profileName));
  report.startRun();
  global.isRateLimited = false; // Ensure clean state at start of each run
  let postedCount = 0;
  let successCount = 0;
  let unconfirmedCount = 0;
  let failedCount = 0;
  let skippedPosts = 0;
  let consecutiveFailures = 0;

  // 📊 v5.11.0 fix #3: cumulative stats across profile hand-offs. When the
  // orchestrator moves to the NEXT profile after a rate limit, the UI counter
  // used to restart from 0 — as if no work had happened. statsBase carries
  // the totals of all profiles that already ran, so the numbers CONTINUE
  // (41, 42, …) instead of resetting.
  const statsBase = (config.statsBase && typeof config.statsBase === 'object')
    ? { success: config.statsBase.success || 0, failed: config.statsBase.failed || 0 }
    : { success: 0, failed: 0 };
  const liveStats = () => ({
    success: statsBase.success + successCount,
    failed: statsBase.failed + failedCount,
  });

  // 🚫 Shared rate-limit reporting: records the cooldown, notifies the UI,
  // and throws RATE_LIMITED so this profile stops IMMEDIATELY and the
  // orchestrator (startMulti) moves to the next profile without burning
  // through the rest of the queue. `pendingPost` ({ text }), when given, is the
  // exact post that was in flight when the limit was hit. It was NOT consumed
  // (it never went out), so it is still sitting at the head of the shared queue
  // and the next profile will pick it up on its own — this value rides along on
  // the error for REPORTING only, so the UI can name the post that was
  // interrupted.
  async function reportRateLimitAndThrow(pageContent, attemptNum, opts = {}, pendingPost = null) {
    global.isRateLimited = true;
    // Hand the claim back so the next profile can pick the post up immediately
    // instead of waiting out the lease. Which way depends on the boundary: some
    // callers reach here AFTER the keystroke (the "daily post limit" URL check),
    // and a post that may already be live must never return to the queue.
    if (session) {
      try {
        if (session.pastBoundary) {
          session.markAmbiguous('rate_limited_after_submit', null, { profileName });
        } else if (session.current) {
          // A rate limit is not this post's fault — do not spend its retry budget.
          session.release('rate_limited', { countAsFailure: false });
        }
      } catch (e) { /* best-effort: the throw below must still happen */ }
    }
    const parsedMs = pageContent ? rateLimitStore.parseCooldownFromText(pageContent) : null;
    const cd = rateLimitStore.setCooldown(profileName, parsedMs, {
      source: parsedMs ? 'x' : 'default',
      note: opts.suspected
        ? 'إيقاف احترازي بعد فشل متكرر غير مبرر'
        : (parsedMs ? 'مدة مأخوذة من رسالة تويتر' : 'مدة افتراضية'),
    });
    const remainTxt = rateLimitStore.formatRemaining(cd.until - Date.now());
    onStatus({
      type: 'error',
      message: opts.suspected
        ? `🚨 البروفايل "${profileName}" أُوقف احترازياً (اشتباه حظر/تقييد) — الكول داون: ${remainTxt}`
        : `🚫 البروفايل "${profileName}" ضرب حد تويتر — توقف فوراً. الكول داون: ${remainTxt}`,
      rateLimited: true,
      profile: profileName,
      cooldownUntil: cd.until,
    });
    report.logEvent({ level: 'error', event: 'RATE_LIMIT', postId: `post-${postedCount}`, attempt: attemptNum, message: `Rate limited — cooldown until ${new Date(cd.until).toISOString()}` });
    const err = new Error('RATE_LIMITED');
    if (!opts.suspected && pendingPost) err.pendingPost = pendingPost;
    throw err;
  }

  // No queue snapshot: every iteration claims the next post from the live store,
  // so a post deleted or published elsewhere can never be picked up from a stale
  // local copy. `session` owns all queue state for this run.
  //
  // Declared here on purpose. This file is not in strict mode, so the bare
  // `session = await DurableSession.open(...)` below was creating an implicit
  // GLOBAL — one shared binding for every concurrent start() call, which would
  // let one profile resolve another profile's leased item.
  let session = null;
  let context = null;

  // A run that starts while a Stop is still joining would race the very
  // dispatch that Stop is waiting on. Refuse instead — the UI shows
  // "stopping" until the join completes and the button becomes live again.
  if (runRegistry.stopping) {
    onStatus({
      type: 'warning',
      message: '⏳ جارٍ إيقاف تشغيل سابق — انتظر حتى يكتمل الإيقاف قبل بدء تشغيل جديد.',
    });
    return {
      status: 'refused', reason: 'stop_in_progress', profile: profileName,
      success: 0, unconfirmed: 0, failed: 0, skipped: 0,
    };
  }

  // This run's cancellation token — the thing Stop actually competes with.
  const runToken = runRegistry.create({ label: profileName });
  // The gate ticket for a keystroke that is currently in flight, if any.
  let dispatchTicket = null;
  try {
    // Shared consumable queue — ALWAYS starts at the head. There is no resume
    // cursor: a published post leaves the queue outright, so whatever sits at
    // the head is BY DEFINITION the next unpublished post, and anything still
    // queued has not gone out.
    //
    // This is why a rate-limit hand-off needs no plumbing: the post the previous
    // profile couldn't publish was never consumed, so it is still at the head and
    // this profile claims it first, naturally. Prepending it (the old
    // config.priorityPost path) would publish it TWICE — once as the injected
    // copy, once from the queue itself. The same holds for a network-deferred
    // post: the store brings it back on its own once the backoff elapses.
    //
    // Durable session: the queue, recovery, and every state transition live in
    // the SQLite workflow store. Startup reconciliation already ran when the
    // store opened, so anything left mid-flight by a previous process has been
    // resolved into a durable state before we claim anything.
    session = await DurableSession.open(profileName);
    const unresolvedAtStart = session.unresolvedCount();
    if (unresolvedAtStart > 0) {
      onStatus({
        type: 'warning',
        message: `⚠️ يوجد ${unresolvedAtStart} منشور غير محسوم من تشغيل سابق — النشر متوقف حتى تراجعها في قائمة الاسترداد.`,
      });
    }
    const queueTotalAtStart = session.queuedCount();
    onStatus({
      type: 'info',
      message: `Starting automation — البروفايل \"${profileName}\" يبدأ من المنشور #1 (${queueTotalAtStart} في الطابور)`,
      queueCount: queueTotalAtStart,
      queueStart: 1,
      queueTotal: queueTotalAtStart,
    });

    // 📍 How many posts this profile has worked through this run — drives the
    // live "المنشور رقم X من Y" message. Tracked separately from postedCount,
    // which counts attempts rather than queue slots.
    let sequentialPosted = 0;

    context = await launchBrowser(profile || 'Default');
    activeContexts.add(context);

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    await page.goto('https://x.com/home');
    await page.bringToFront();
    await page.setViewportSize({ width: 1280, height: 800 });

    onStatus({ type: 'info', message: 'Checking authentication status...' });
    try {
      await waitForSelectorInterruptible(page, '[data-testid="SideNav_AccountSwitcher_Button"]', 15000);
    } catch (e) {
      // A Stop landing during the auth probe is a stop, not a login problem.
      // Rewriting it as AUTH_REQUIRED sent the operator to re-authenticate an
      // account that was fine, and hid the fact that their Stop was honoured.
      if (e.message === 'STOPPED_BY_USER') throw e;
      throw new Error("AUTH_REQUIRED: Please log in first");
    }

    // The worker no longer holds a publishable snapshot: every iteration claims
    // the next post from the live store. A snapshot is exactly how a deleted or
    // already-published post used to go out anyway.
    while (postedCount < maxPosts) {
      if (!global.isRunning) break;

      const claim = session.claimNext({ leaseMs: 180_000 });
      if (!claim) break; // queue empty
      if (claim.blocked) {
        onStatus({
          type: 'error',
          message: '⛔ يوجد منشور سابق غير محسوم — لن يُنشر أي منشور جديد حتى تؤكد حالته في قائمة الاسترداد.',
        });
        break;
      }

      const itemText = claim.text;
      const rawText = parseSpintax(itemText);

      // 🔓 DECOUPLED: queue posts are published EXACTLY as stored. Referral
      // links (if any) were already baked in by the studio at generation
      // time — publishing never inspects, rewrites, or rejects post links.
      const postText = rawText;
      const mediaPath = claim.mediaPath;
      postedCount++;
      const postStartTime = Date.now();
      report.logEvent({ level: 'info', event: 'POST_START', postId: `post-${postedCount}`, attempt: 1, message: `Processing post ${postedCount}` });

      // 🩹 "looks random every time it starts" fix: this used to print
      // `Processing post ${postedCount}` — a SESSION-LOCAL attempt counter, not
      // a queue position. Now that the queue is consumed as it's published,
      // the head of the queue IS post #1 and the count below is honest by
      // construction: X of Y where Y is what was waiting when the run started.
      sequentialPosted++;
      const progressMessage = `📝 نشر المنشور رقم ${sequentialPosted} من ${queueTotalAtStart}...`;

      onStatus({
        type: 'action',
        message: progressMessage,
        queueCount: session.queuedCount(),
        stats: liveStats()
      });

      // Anti-detection: always start from top, minimal human-like nudges
      await page.evaluate(() => window.scrollTo(0, 0));
      await interruptibleDelay(500);

      onStatus({ type: 'info', message: 'Human emulation scrolling...' });
      const nudges = Math.random() < 0.5 ? 1 : 2;
      for (let i = 0; i < nudges; i++) {
        await page.mouse.wheel(0, Math.floor(Math.random() * 200) + 1);
        await interruptibleDelay(Math.floor(Math.random() * 1001) + 500);
      }

      onStatus({ type: 'info', message: 'Resetting scroll position...' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await interruptibleDelay(500);

      if (!global.isRunning) break;

      let postSuccess = false;
      let confirmedPostUrl = null;
      let attempts = 0;
      let lastError = null;
      let postingAttempted = false;
      const maxRetries = 3;
      let stoppedCleanupDone = false;
      // Set when a pre-boundary guard refused the dispatch. The item is already
      // resolved durably, so this post is finished — skip straight to the next.
      let dispatchRefused = false;

      // Stopping is not a publishing failure. Keep an untouched post in the
      // queue; if submit may have happened, quarantine it for verification.
      // Shared by both exit paths below: a STOPPED_BY_USER thrown mid-attempt
      // (e.g. during the toast-confirmation wait, right after Ctrl+Enter — the
      // highest-risk window) unwinds straight past the loop via the catch
      // blocks' rethrows, never reaching the "loop exited normally" code path,
      // so that path alone used to miss this cleanup entirely.
      async function handleStoppedDuringAttempt() {
        if (stoppedCleanupDone) return;
        stoppedCleanupDone = true;
        // pastBoundary, not postingAttempted: the dispatch is committed the
        // instant beginDispatch returns, which is before the keystroke. Stopping
        // in that window is exactly the ambiguous case — the post may be live.
        if (session.pastBoundary) {
          session.markAmbiguous('stopped_after_submit', null, { stoppedByUser: true });
          unconfirmedCount++;
          report.recordPostResult({
            postId: `post-${postedCount}`,
            text: itemText,
            status: 'unconfirmed',
            attempts,
            lastError: 'Stopped by user after submit',
          });
        } else {
          // Nothing left the app. Stopping is an operator action, not a
          // publishing failure, so it must not burn the item's retry budget.
          session.release('stopped_by_user', { countAsFailure: false });
        }
      }

      while (!postSuccess && attempts < maxRetries && global.isRunning && !global.isRateLimited) {
        // Once the dispatch is committed, the keystroke may already have gone
        // out. Retrying would press Ctrl+Enter a second time for the same
        // committed attempt — the exact duplicate-publish the durable design
        // exists to prevent. The outcome is resolved below instead.
        if (session.pastBoundary || dispatchRefused) break;
        attempts++;
        if (attempts >= 2) {
          report.logEvent({ level: 'warn', event: 'RETRY', postId: `post-${postedCount}`, attempt: attempts, message: `Retry attempt ${attempts}/${maxRetries}` });
        }
        
        try {
          // Wait for textarea with visibility+enabled check to prevent partial-DOM race
          await waitForSelectorInterruptible(page, '[data-testid="tweetTextarea_0"]', 15000);
          await waitForFunctionInterruptible(page, () => {
            const el = document.querySelector('[data-testid="tweetTextarea_0"]');
            return el && !el.disabled && el.offsetParent !== null;
          }, 5000);
          const textarea = page.locator('[data-testid="tweetTextarea_0"]');
          // Mouse movement before clicking textarea — human-like behavior
          await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100, { steps: 10 });
          await interruptibleDelay(100 + Math.random() * 200);
          await textarea.click({ force: true });
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.press('Backspace');
          await interruptibleDelay(500);
           
          await page.keyboard.type(postText, { delay: Math.floor(Math.random() * 150) + 50 });
          await interruptibleDelay(500);

          if (mediaPath) {
            onStatus({ type: 'info', message: 'Uploading media...' });
            try {
              await fs.access(mediaPath);
              const fileInput = await waitForSelectorInterruptible(page, 'input[type="file"]', 5000);
              await fileInput.setInputFiles(mediaPath);
              await waitForSelectorInterruptible(page, '[data-testid="imageCropper"]', 15000);
              onStatus({ type: 'info', message: 'Media uploaded' });
            } catch (mediaErr) {
              // 🛑 Don't swallow a user-initiated stop into a generic upload error —
              // it must propagate untouched so the run halts instead of retrying.
              if (mediaErr.message === 'STOPPED_BY_USER') throw mediaErr;
              onStatus({ type: 'warning', message: `Media error: ${mediaErr.message}` });
              // Clear textarea to prevent half-composed state on retry
              try {
                await page.keyboard.press('ControlOrMeta+A');
                await page.keyboard.press('Backspace');
              } catch (e) { /* best-effort cleanup */ }
              throw new Error('Media upload failed: ' + mediaErr.message);
            }
          }

          await interruptibleDelay(1000);

          confirmedPostUrl = null;
          postSuccess = false;

          try {
            await interruptibleDelay(1000);
            await textarea.focus();
            // Mouse movement before posting — human-like behavior
            await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100, { steps: 10 });
            await interruptibleDelay(100 + Math.random() * 200);
            const baselineToast = await getToastSnapshot(page);

            // ── THE IRREVERSIBLE BOUNDARY ──────────────────────────────────
            // Everything from here to the keystroke is SYNCHRONOUS on purpose.
            // Do not introduce an `await` between the gate and the press: that
            // gap is exactly where a Stop used to slip through unobserved,
            // leaving the operator with a tweet they had already cancelled.
            //
            // 1. Take the run gate. If Stop got here first this refuses, and
            //    nothing irreversible happens.
            const gate = runToken.tryEnterDispatch(`post-${postedCount}`);
            if (!gate.ok) {
              dispatchRefused = true;
              // Nothing left the app, so this is not a publishing failure and
              // must not spend the item's retry budget.
              try { session.release('stopped_before_dispatch', { countAsFailure: false }); }
              catch (e) { console.error('release after stop-wins failed:', e?.message); }
              stoppedCleanupDone = true;
              onStatus({
                type: 'warning',
                message: '🛑 وصل أمر الإيقاف قبل الإرسال — لم يُضغط الإرسال ولم يُنشر شيء، والمنشور باقٍ في الطابور.',
              });
              break;
            }

            // 2. Commit the dispatch durably BEFORE the keystroke, never after:
            //    a crash between the two must leave a record that something may
            //    already be live on X. If a guard refuses, the keystroke must
            //    not happen at all — beginDispatch has already landed the item
            //    somewhere durable and released the claim.
            let dispatch;
            try {
              dispatch = session.beginDispatch(postText);
            } catch (beginErr) {
              runToken.leaveDispatch(gate.ticket, { outcome: 'begin_threw' });
              throw beginErr;
            }
            if (!dispatch.ok) {
              runToken.leaveDispatch(gate.ticket, { outcome: 'refused' });
              dispatchRefused = true;
              onStatus({
                type: 'warning',
                message: `⛔ رُفض النشر قبل الإرسال (${dispatch.code}) — لم يُضغط الإرسال ولم يُنشر شيء.`,
              });
              break;
            }

            // 3. The transport call. From here the outcome can only be
            //    published or ambiguous — never back to the queue.
            //
            //    `postingAttempted` is set BEFORE the await, not after it. The
            //    boundary is the point of no return, not the moment a promise
            //    happens to resolve: if the keystroke reached the page and the
            //    promise then rejected (a context torn down, a navigation, a
            //    timeout), setting it afterwards left pastBoundary=true with
            //    postingAttempted=false. The unwind then tried markTerminal on
            //    an item already in `dispatch_started`, got INVALID_STATE, and
            //    stranded it there — invisible in both queue and recovery, and
            //    blocking every profile until a restart reconciled it.
            dispatchTicket = gate.ticket;
            postingAttempted = true;
            try {
              await page.keyboard.press('ControlOrMeta+Enter');
            } finally {
              // Release the gate as soon as the keystroke itself has settled.
              // A Stop waiting to join is unblocked here; the outcome is
              // resolved by the code below either way.
              runToken.leaveDispatch(dispatchTicket, { outcome: 'submitted' });
              dispatchTicket = null;
            }

            onStatus({ type: 'info', message: `Post triggered via ${PLATFORM_KEY_LABEL}+Enter, awaiting server confirmation...` });
            try {
              const confirmation = await waitForPostConfirmation(page, baselineToast, 10000);
              confirmedPostUrl = confirmation.href || null;
              postSuccess = confirmation.kind === 'confirmed' ? true : 'unconfirmed';
            } catch (toastErr) {
              // 🛑 A stop request surfaces here as a STOPPED_BY_USER throw from the
              // interruptible toast wait — it must abort immediately, not be treated
              // as "toast missing, let's double-check and retry" (that silently kept
              // the run going for several more seconds/attempts after Stop was pressed).
              if (toastErr.message === 'STOPPED_BY_USER') throw toastErr;
              if (toastErr.message === 'RATE_LIMIT_TOAST') {
                await reportRateLimitAndThrow(toastErr.toastText || null, attempts, {}, { text: itemText });
              }
              onStatus({ type: 'warning', message: 'لم يصل تأكيد نشر صالح — جاري التحقق من حالة المحرر...' });

              // 🔎 The composer content is the reliable "did it post?" signal:
              // X clears the textarea the instant a tweet is accepted. The old
              // check (`tweetButtonInline` still visible) was ALWAYS true on
              // x.com/home — the inline composer button never leaves that DOM —
              // so a missed toast could NEVER be classified as posted: the text
              // got retyped and re-sent, X rejected it as a duplicate, all
              // retries burned, and an actually-published post was dead-lettered
              // as failed. That was the "huge deleted count while everything
              // visibly posts fine" bug (v5.11.0 fix #1).
              const composerText = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="tweetTextarea_0"]');
                return el ? (el.textContent || '') : null;
              });

              if (composerText !== null && composerText.trim().length === 0) {
                postSuccess = 'unconfirmed';
                onStatus({ type: 'warning', message: 'Composer cleared but no confirmation toast - marking as unconfirmed' });
              } else {
                const earlyScan = await scanForRateLimit(page);
                if (earlyScan.isRateLimited && global.isRunning) {
                  await reportRateLimitAndThrow(earlyScan.pageContent, attempts, {}, { text: itemText });
                }
                lastError = toastErr;
                postSuccess = 'unconfirmed';
                onStatus({
                  type: 'warning',
                  message: '⚠️ محاولة النشر أصبحت غير محسومة؛ لن يُعاد الضغط تلقائياً وسيُنقل المنشور للتحقق اليدوي.',
                });
              }
            }
          } catch (clickErr) {
            if (clickErr.message === 'STOPPED_BY_USER' || clickErr.message === 'RATE_LIMITED') throw clickErr;
            lastError = clickErr;
            postSuccess = false;
            onStatus({ type: 'warning', message: `Attempt ${attempts}/${maxRetries}: تعذر إطلاق النشر، ستُعاد المحاولة بأمان.` });
          }

        } catch (err) {
          if (err.message === 'STOPPED_BY_USER') {
            await handleStoppedDuringAttempt();
            throw err;
          }
          if (err.message === 'RATE_LIMITED') throw err;
          lastError = err;
          onStatus({ type: 'warning', message: `Attempt ${attempts} failed: ${err.message}` });
          await page.evaluate(() => window.scrollTo(0, 0));
          await interruptibleDelay(1500);

          if (err.name === 'TimeoutError' || err.message.includes('net::') || err.message.includes('connection')) {
            onStatus({ type: 'warning', message: 'Network/Timeout error, attempting recovery...' });
            await interruptibleDelay(networkRecoveryMs);
            // 🛑 Recovery navigations below can take up to 45-60s each and
            // aren't pollable mid-flight — at minimum, skip them entirely if
            // Stop was already pressed during the delay above.
            if (!global.isRunning) throw new Error('STOPPED_BY_USER');
            // DOM recovery — try reload first, then full navigation, then fallback
            let recoverySuccess = false;
            try {
              await page.goto('https://x.com/home', { timeout: 45000, waitUntil: 'domcontentloaded' });
              recoverySuccess = true;
            } catch (reloadErr) {
              console.error('Recovery reload failed, trying navigation:', reloadErr.message);
            }
            if (!recoverySuccess && global.isRunning) {
              try {
                await page.goto('https://x.com', { timeout: 60000, waitUntil: 'load' });
                await page.goto('https://x.com/home', { timeout: 60000, waitUntil: 'domcontentloaded' });
              } catch (navErr) {
                console.error('Full navigation recovery failed:', navErr.message);
              }
            }
          }
        }
      }

      if (!global.isRunning) {
        await handleStoppedDuringAttempt();
        break;
      }

      // Once Ctrl+Enter was accepted by Playwright, a missing/unknown response is
      // an ambiguous external side effect. Never retry it automatically or call
      // it failed: park it for manual reconciliation to prevent duplicates.
      if (!postSuccess && postingAttempted) postSuccess = 'unconfirmed';

      // Record post timing and log outcome
      const postDuration = Date.now() - (typeof postStartTime !== 'undefined' ? postStartTime : Date.now());
      report.recordPostTime(postDuration);
      if (postSuccess === true) {
        report.logEvent({ level: 'info', event: 'POST_SUCCESS', postId: `post-${postedCount}`, attempt: attempts, message: 'Post published successfully' });
      } else if (postSuccess === 'unconfirmed') {
        report.logEvent({ level: 'warn', event: 'POST_SUCCESS', postId: `post-${postedCount}`, attempt: attempts, message: 'Post published (unconfirmed - no confirmation toast)' });
      } else if (attempts >= maxRetries) {
        report.logEvent({ level: 'error', event: 'POST_FAIL', postId: `post-${postedCount}`, attempt: attempts, message: `Failed after ${maxRetries} attempts` });
      }

      if (!postSuccess && attempts >= maxRetries) {
        const scan = await scanForRateLimit(page);
        if (scan.isRateLimited && global.isRunning) {
          await reportRateLimitAndThrow(scan.pageContent, attempts, {}, { text: itemText });
        }
      }

      // 🔗 Resolve the final post URL BEFORE any accounting — it used to run
      // after success was already recorded and the queue advanced, so a
      // limit-redirect URL discovered here couldn't undo the bogus "success".
      let postUrl = confirmedPostUrl || null;
      if (!postUrl && (postSuccess === true || postSuccess === 'unconfirmed')) {
        try {
          // Attempt 1: Check for toast with link
          const toast = await waitForSelectorInterruptible(page, '[data-testid="toast"]', 5000);
          const link = await toast.$('a');
          if (link) {
            postUrl = await link.getAttribute('href');
            if (postUrl && !postUrl.startsWith('http')) postUrl = `https://x.com${postUrl}`;
          }
          // Attempt 2: Extract from DOM if toast didn't have a link
          if (!postUrl) {
            postUrl = await getTweetUrlFromDOM(page);
          }
          // Attempt 3: Check page URL
          if (!postUrl) {
            const u = page.url();
            if (u.includes('/status/')) postUrl = u;
          }
        } catch (e) {
          if (e.message === 'STOPPED_BY_USER') throw e;
          // Last resort: try DOM extraction silently
          try { postUrl = await getTweetUrlFromDOM(page); } catch {}
        }
      }

      // ⛔ Daily post limit: a "confirmation" whose link points to the premium
      // upsell page means the post was NOT published — the account hit its
      // daily limit. Stop this account NOW, keep the cursor on this post, and
      // hand it to the next account (per the hand-off flow) so it still goes out.
      if ((postSuccess === true || postSuccess === 'unconfirmed') && isLimitUrl(postUrl) && global.isRunning) {
        onStatus({
          type: 'error',
          message: `⛔ رابط التأكيد يشير لصفحة "حد النشر اليومي" (${postUrl}) — المنشور لم يُنشر فعلياً والحساب ضرب الحد.`,
        });
        const scan = await scanForRateLimit(page);
        await reportRateLimitAndThrow(scan.pageContent || null, attempts, {}, { text: itemText });
      }
      postUrl = postUrl || 'N/A';

      if (postSuccess === true) {
        // ✅ PUBLISHED + LINK CAPTURED. Recorded before anything else that could
        // throw (reporting, CSV, cooldown), so a later failure can never
        // resurrect an already-published post. The item stays in the store as
        // `published` — that is what keeps feeding the studio's semantic dedup
        // long after it leaves the queue.
        //
        // The counter is incremented AFTER the commit returns, never before.
        // Incrementing first meant the duplicate-URL path below moved the item
        // to `ambiguous` while the run still reported it as a success: a probe
        // measured success=2/unconfirmed=1 against a database holding
        // published=1/ambiguous=1. The summary has to come from what committed.
        try {
          session.markPublished({
            externalUrl: confirmedPostUrl || null,
            evidence: { profileName, attempts, postUrl },
          });
          successCount++;
          consecutiveFailures = 0;
        } catch (publishErr) {
          // external_url is UNIQUE: a scraped URL that already belongs to
          // another attempt means the DOM handed us a stale link, so we cannot
          // attribute this URL to this post. The post itself very likely DID go
          // out, so it must not go back in the queue — but we have no proof of
          // which URL is its own. That is precisely "ambiguous": park it for a
          // human. Throwing here instead would strand the item in
          // dispatch_started and block publishing for every profile.
          if (publishErr && publishErr.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            onStatus({
              type: 'warning',
              message: '⚠️ رابط التأكيد مُسجَّل لمنشور آخر — تعذّر إثبات رابط هذا المنشور، نُقل للتحقق اليدوي.',
            });
            session.markAmbiguous('duplicate_external_url', publishErr, {
              profileName,
              attempts,
              scrapedUrl: confirmedPostUrl || postUrl || null,
            });
            unconfirmedCount++;
            report.recordPostResult({
              postId: `post-${postedCount}`,
              text: itemText,
              status: 'unconfirmed',
              attempts,
              lastError: 'Duplicate external URL — could not attribute the link',
            });
            continue;
          }
          throw publishErr;
        }
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: itemText,
          status: 'success',
          attempts: attempts
        });
      } else if (postSuccess === 'unconfirmed') {
        // Remote outcome is ambiguous. Move atomically to the visible recovery
        // list and never auto-retry; the user decides after checking X.
        session.markAmbiguous('ambiguous_publish_result', lastError, {
          profileName,
          attempts,
          composerCleared: true,
        });
        unconfirmedCount++;
        consecutiveFailures = 0;
        onStatus({ type: 'warning', message: 'Post moved to pending verification (unconfirmed status)' });
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: itemText,
          status: 'unconfirmed',
          attempts: attempts
        });
      } else {
        // Classify error type from last captured error. Selector/locator
        // checks run BEFORE the generic TimeoutError catch-all (v5.12.0 fix):
        // Playwright's native locator actions (e.g. textarea.click() below)
        // throw their OWN errors.TimeoutError on a genuine DOM/selector
        // regression — checking .name first mis-bucketed that as 'network',
        // which would have made it eligible for infinite silent deferral
        // instead of surfacing as a dead-letter.
        let errorType = 'unknown';
        let errorMsg = `Failed after ${maxRetries} attempts`;
        if (lastError) {
          errorMsg = lastError.message || errorMsg;
          const msg = lastError.message || '';
          if (msg.includes('waitForSelector') || msg.includes('selector') || msg.includes('locator') || msg.includes('strict mode violation')) {
            errorType = 'selector';
          } else if (msg.includes('Target closed') || msg.includes('browser') || msg.includes('context') || msg.includes('page') || msg.includes('crash')) {
            errorType = 'platform';
          } else if (msg.includes('net::') || msg.includes('ECONN') || msg.includes('connection') || lastError.name === 'TimeoutError') {
            errorType = 'network';
          }
        }
        failedCount++;
        consecutiveFailures++;

        // ⏸️ Transient (network) failures are NOT consumed. The post is deferred
        // with a backoff, so this run moves on to the next post and the store
        // brings this one back on its own — "try another post now, retry this
        // one later" without ever stalling on the head of the queue.
        if (errorType === 'network') {
          // The store owns the retry budget: markDeferred increments the
          // pre-dispatch failure count and retires the item to `dead` on its own
          // once the budget is spent, so the returned state IS the outcome.
          const deferredItem = session.markDeferred('network_failure', lastError);
          const retired = deferredItem && deferredItem.state === 'dead';
          if (retired) {
            onStatus({ type: 'error', message: `❌ فشل شبكي متكرر — تم نقله للمحذوفات نهائياً.` });
            report.recordPostResult({
              postId: `post-${postedCount}`, text: itemText, status: 'dead_letter',
              attempts: attempts, errorType, lastError: errorMsg,
            });
          } else {
            onStatus({ type: 'warning', message: `⏸️ فشل مؤقت (شبكة) — بقي المنشور في الطابور، وسيُعاد تلقائياً في التشغيل القادم.` });
            report.recordPostResult({
              postId: `post-${postedCount}`, text: itemText, status: 'deferred',
              attempts: attempts, errorType, lastError: errorMsg,
            });
          }
          // 🚨 Circuit breaker still applies to network failures — a fully-dead
          // local connection must not spin silently through the entire
          // remaining queue deferring one post after another. Same check as
          // the dead-letter path below, duplicated here because this branch
          // returns early (see `continue`) before reaching it.
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT && global.isRunning) {
            onStatus({
              type: 'error',
              message: `🚨 البروفايل "${profileName}" فشل ${consecutiveFailures} منشورات متتالية دون سبب معروف — يُشتبه بحظر/تقييد غير معروف. توقف احترازي فوري.`,
            });
            await reportRateLimitAndThrow(null, attempts, { suspected: true });
          }
          // Skip the shared error-log CSV + generic status message below —
          // this branch already reported its own outcome above.
          const remainingAfterDefer = session.queuedCount();
          if (remainingAfterDefer > 0 && postedCount < maxPosts && global.isRunning) {
            const randomDelay = nextCooldownMs(speed, minCooldownMs);
            const stopEarly = await countdown(randomDelay, onStatus, remainingAfterDefer, liveStats().success, liveStats().failed);
            if (stopEarly) break;
          }
          continue;
        }

        onStatus({ type: 'error', message: `❌ فشل (${errorType}): ${errorMsg.slice(0, 60)}` });
        // A non-transient failure (selector/platform/unknown) will not fix
        // itself on a retry, so the post is retired rather than left to block
        // the head of the queue forever (Zero-Queue-Block). This is one durable
        // transaction, not a multi-step write, so a crash cannot land halfway.
        // Strictly pre-boundary: nothing was ever submitted, so retiring it can
        // never hide a published post. Dead items keep their text and stay
        // visible in the recovery list, so nothing is lost.
        session.markTerminal(errorType, lastError);
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: itemText,
          status: 'dead_letter',
          attempts: attempts,
          errorType: errorType,
          lastError: errorMsg
        });
        // Write to error log
        const errTimestamp = new Date().toLocaleString('ar-EG');
        // ⚡ C5: escape ALL fields via escCsv — errorMsg/postText may contain quotes/newlines
        const errLine = `${escCsv(errTimestamp)},${escCsv(postText)},${escCsv(errorType)},${escCsv(errorMsg)}\n`;
        const errPath = path.join(outputFolder, `error-log-${new Date().toISOString().split('T')[0]}.csv`);
        try {
          await fs.mkdir(path.dirname(errPath), { recursive: true });
          try { await fs.access(errPath); } catch { await fs.writeFile(errPath, 'Time,Content,ErrorType,ErrorReason\n'); }
          await fs.appendFile(errPath, errLine);
        } catch (err2) {
          onStatus({ type: 'error', message: `Failed to write error log: ${err2.message}` });
        }

        // 🚨 Circuit breaker: N unrecognized consecutive failures almost always
        // means X silently blocked/limited this account without matching any of
        // our known rate-limit phrasings — continuing would burn the ENTIRE
        // remaining queue into dead-letters, one slow retry-cycle at a time.
        // Stop this profile now (same cooldown treatment as an explicit rate
        // limit) so the orchestrator moves to the next account immediately.
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT && global.isRunning) {
          onStatus({
            type: 'error',
            message: `🚨 البروفايل "${profileName}" فشل ${consecutiveFailures} منشورات متتالية دون سبب معروف — يُشتبه بحظر/تقييد غير معروف. توقف احترازي فوري.`,
          });
          await reportRateLimitAndThrow(null, attempts, { suspected: true });
        }
      }

      // Write to success/confirmed CSV only
      if (postSuccess === true || postSuccess === 'unconfirmed') {
        const timestamp = new Date().toLocaleString('ar-EG');
        const status = postSuccess === true ? 'SUCCESS' : 'UNCONFIRMED';
        // ⚡ C5: escape ALL fields via escCsv — postUrl/postText may contain quotes/newlines
        const outputLine = `${escCsv(timestamp)},${escCsv(postText)},${escCsv(postUrl)},${escCsv(status)}\n`;
        const outputPath = path.join(outputFolder, `x-poster-output-${new Date().toISOString().split('T')[0]}.csv`);
        try {
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          try { await fs.access(outputPath); } catch { await fs.writeFile(outputPath, 'Time,Content,Link,Status\n'); }
          await fs.appendFile(outputPath, outputLine);
        } catch (err3) {
          onStatus({ type: 'error', message: `Failed to write log: ${err3.message}` });
        }
      }

      let statusType;
      let statusMessage;
      if (postSuccess === true) {
        statusType = 'success';
        statusMessage = `Posted: ${postUrl}`;
      } else if (postSuccess === 'unconfirmed') {
        statusType = 'warning';
        statusMessage = `Unconfirmed post: ${postUrl}`;
      } else {
        statusType = 'error';
        statusMessage = 'Failed post';
      }

      onStatus({ 
        type: statusType, 
        message: statusMessage,
        queueCount: session.queuedCount(),
        stats: liveStats()
      });

      const remainingQueued = session.queuedCount();
      if (remainingQueued > 0 && postedCount < maxPosts && global.isRunning) {
        const randomDelay = nextCooldownMs(speed, minCooldownMs);
        const stopEarly = await countdown(randomDelay, onStatus, remainingQueued, liveStats().success, liveStats().failed);
        if (stopEarly) break;
      }
    }

    if (!global.isRunning) {
      onStatus({ type: 'warning', message: 'Automation stopped by user', stats: liveStats() });
    } else {
      onStatus({ type: 'info', message: 'Task completed', stats: liveStats() });
    }
    await report.endRun();
    return {
      status: global.isRunning ? 'completed' : 'stopped',
      profile: profileName,
      success: successCount,
      unconfirmed: unconfirmedCount,
      failed: failedCount,
      skipped: skippedPosts,
    };
  } catch (error) {
    if (error.message === 'STOPPED_BY_USER') {
      onStatus({ type: 'warning', message: 'Automation stopped by user', stats: liveStats() });
      await report.endRun();
      return { status: 'stopped', profile: profileName, success: successCount, unconfirmed: unconfirmedCount, failed: failedCount, skipped: skippedPosts };
    }
    if (error.message === 'RATE_LIMITED') {
      // Already reported + cooldown stored inside the loop. Stop this profile
      // cleanly so the orchestrator can advance to the next profile.
      await report.endRun();
      const cd = rateLimitStore.getCooldown(profileName);
      return {
        status: 'rate_limited',
        profile: profileName,
        success: successCount,
        unconfirmed: unconfirmedCount,
        failed: failedCount,
        skipped: skippedPosts,
        cooldownUntil: cd ? cd.until : null,
        pendingPost: error.pendingPost || null,
      };
    }
    onStatus({ type: 'error', message: error.message, stats: liveStats() });
    report.logEvent({ level: 'error', event: 'RUN_ERROR', postId: null, attempt: 0, message: error.message });
    await report.endRun();
    throw error;
  } finally {
    // Close the run in the SAME finally that closes the browser. Without this
    // the row stayed 'active' forever: workflow_runs grew one row per run and
    // the next startup reconciliation relabelled every one of them 'crashed',
    // so a clean run was indistinguishable from a real crash. It also releases
    // a claim still held on an early break, instead of waiting out the lease.
    // A user pressing Stop is still a CLEAN close — 'crashed' is reserved for
    // runs that never reached this line at all.
    // A ticket still held here means the run unwound between the keystroke and
    // its own finally (a throw from deep inside Playwright, for instance).
    // Release it so a Stop waiting to join is never wedged behind a dead run.
    if (dispatchTicket) {
      try { runToken.leaveDispatch(dispatchTicket, { outcome: 'run_unwound' }); }
      catch (e) { console.error('Failed to release dispatch gate:', e?.message); }
      dispatchTicket = null;
    }
    runRegistry.release(runToken);
    if (session) {
      try { session.close('closed'); }
      catch (e) { console.error('Failed to close workflow run:', e?.message); }
    }
    if (context) activeContexts.delete(context);
    try {
      if (context) await context.close();
    } catch (e) {
      console.error('Failed to close browser context:', e?.message);
    }
  }
}

async function countdown(ms, onStatus, queueCount, success, failed) {
  const THROTTLE_SECONDS = 10;
  let remaining = Math.floor(ms / 1000);
  let lastUpdateTime = Date.now();
  
  while (remaining > 0) {
    if (!global.isRunning) return true;
    
    const now = Date.now();
    const timeSinceLastUpdate = Math.floor((now - lastUpdateTime) / 1000);
    
    if (timeSinceLastUpdate >= THROTTLE_SECONDS || remaining === Math.floor(ms / 1000)) {
      onStatus({
        type: 'countdown',
        message: `Next post in ${remaining}s`,
        countdown: remaining,
        queueCount: queueCount,
        stats: { success, failed }
      });
      lastUpdateTime = now;
    }
    
    await new Promise(r => setTimeout(r, 1000));
    remaining--;
  }
  
  onStatus({
    type: 'countdown',
    message: 'Next post in 0s',
    countdown: 0,
    queueCount: queueCount,
    stats: { success, failed }
  });
  
  return false;
}

/**
 * Multi-profile orchestrator. Runs `start` for each profile in order.
 * Behaviour per the user's spec:
 *   1. When a profile hits a rate limit → it stops IMMEDIATELY (handled in
 *      `start` via RATE_LIMITED) and a cooldown is recorded.
 *   2. We then advance to the NEXT profile automatically.
 *   3. Profiles already under an active cooldown are skipped with a notice.
 *
 * @param {object} config - { speed, maxPosts, outputFolder, profiles: string[] }
 * @param {function} onStatus
 * @returns {Promise<{ results: object[], summary: object }>}
 */
async function startMulti(config, onStatus) {
  const profiles = Array.isArray(config.profiles) && config.profiles.length
    ? config.profiles
    : [config.profile || 'Default'];

  const results = [];
  let totalSuccess = 0, totalUnconfirmed = 0, totalFailed = 0, totalSkippedPosts = 0, limitedCount = 0, skippedCount = 0;
  // 🔁 The post a profile was mid-way through when it hit a rate limit. It was
  // never published, so it was never consumed — it is still at the head of the
  // shared queue and the next profile picks it up automatically. Kept only to
  // report the outcome at the end of the run.
  let interruptedPost = null;

  // 🎯 v5.11.0 fix #3: "الحد الأقصى للمنشورات" is ONE GLOBAL target shared by
  // all profiles — not a fresh quota per profile. When a profile hits its
  // rate limit after publishing 40 of 100, the next profile continues with
  // the REMAINING 60 (and the UI counters continue from 40), instead of
  // restarting the full 100 from zero.
  const globalMax = Number(config.maxPosts);
  const hasGlobalMax = Number.isFinite(globalMax) && globalMax > 0;

  for (let i = 0; i < profiles.length; i++) {
    if (!global.isRunning) {
      onStatus({ type: 'warning', message: '🛑 تم الإيقاف بواسطة المستخدم.' });
      break;
    }
    // Published (confirmed + unconfirmed) so far across ALL profiles this run.
    const doneSoFar = totalSuccess + totalUnconfirmed;
    if (hasGlobalMax && doneSoFar >= globalMax) {
      onStatus({
        type: 'success',
        message: `🎯 اكتمل العدد المطلوب (${globalMax}) عبر الحسابات — لا حاجة لتشغيل بقية البروفايلات.`,
      });
      break;
    }
    const profileName = profiles[i];

    onStatus({
      type: 'info',
      message: `▶️ البروفايل (${i + 1}/${profiles.length}): "${profileName}"`,
      activeProfile: profileName,
      profileIndex: i + 1,
      profileTotal: profiles.length,
    });

    let res;
    try {
      res = await start({
        ...config,
        profile: profileName,
        // Remaining share of the global target + cumulative counter base so
        // the next profile CONTINUES the numbers instead of resetting them.
        maxPosts: hasGlobalMax ? (globalMax - doneSoFar) : config.maxPosts,
        statsBase: { success: totalSuccess, failed: totalFailed },
      }, onStatus);
    } catch (err) {
      // A hard error on one profile shouldn't kill the whole batch.
      onStatus({ type: 'error', message: `خطأ في "${profileName}": ${err.message}` });
      res = { status: 'error', profile: profileName, success: 0, failed: 0, error: err.message };
    }
    // This profile ran, so any post interrupted BEFORE it has either gone out
    // or is back at the head of the queue — either way it's no longer pending.
    interruptedPost = null;
    results.push(res);
    totalSuccess += res.success || 0;
    totalUnconfirmed += res.unconfirmed || 0;
    totalFailed += res.failed || 0;
    totalSkippedPosts += res.skipped || 0;

    // 🛑 Stop must ALWAYS win. Without this check, a Stop press that lands at
    // the exact moment a profile also hits its rate limit would fall through
    // to the rate_limited branch below and incorrectly launch the NEXT
    // profile — exactly the "stop doesn't stop immediately" bug being fixed.
    if (!global.isRunning || res.status === 'stopped') {
      if (res.status !== 'stopped') {
        onStatus({ type: 'warning', message: '🛑 تم الإيقاف بواسطة المستخدم.' });
      }
      break;
    }

    if (res.status === 'rate_limited') {
      limitedCount++;
      interruptedPost = res.pendingPost || null;
      onStatus({
        type: 'warning',
        message: `➡️ "${profileName}" ضرب حد — الانتقال للبروفايل التالي...`,
      });
      // global.isRateLimited was set true inside start(); reset before next.
      global.isRateLimited = false;
      continue;
    }
    if (res.status === 'cooldown') { skippedCount++; continue; }
  }

  // 📌 A post interrupted by a rate limit with no account left to take it is
  // NOT lost: it was never published, so it was never consumed and is still
  // first in the queue for the next run.
  if (interruptedPost && interruptedPost.text) {
    onStatus({
      type: 'warning',
      message: '📌 منشور ضرب الحد لم يجد حساباً متاحاً لنشره الآن — لم يُحذف من الطابور، وسيكون أول منشور في التشغيل القادم.',
    });
  }

  const summary = {
    profilesRun: results.length,
    totalSuccess,
    totalUnconfirmed,
    totalFailed,
    skippedPosts: totalSkippedPosts,
    rateLimited: limitedCount,
    skippedCooldown: skippedCount,
    targetReached: hasGlobalMax ? (totalSuccess + totalUnconfirmed) >= globalMax : null,
  };
  onStatus({
    type: 'info',
    message: `✅ انتهى التشغيل المتعدد — نجح ${totalSuccess}${totalUnconfirmed ? ` (+${totalUnconfirmed} قيد التحقق)` : ''}، فشل ${totalFailed}، منشورات متخطّاة ${totalSkippedPosts}، حسابات ضربت الحد ${limitedCount}، حسابات تحت كولداون ${skippedCount}.`,
    multiDone: true,
    summary,
  });
  return { results, summary };
}

module.exports = { start, startMulti, stopActive, escCsv, isLimitUrl, inspectToast };
