const fs = require('fs').promises;
const path = require('path');
const { launchBrowser } = require('./browserManager');
const queueManager = require('./queueManager');
const { ReportEngine } = require('./reportEngine');
const rateLimitStore = require('./rateLimitStore');
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

async function stopActive() {
  global.isRunning = false;
  await Promise.allSettled(Array.from(activeContexts, context => context.close()));
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
  return path.join(queueManager.getProfileDataDir(profileName), 'reports');
}

// 🚨 Consecutive unrecognized-failure circuit breaker — see reportRateLimitAndThrow.
const CONSECUTIVE_FAILURE_LIMIT = 3;

// ⏸️ v5.12.0: cap on how many times a single post can be deferred (transient
// network failure) before it falls through to a permanent dead-letter. Without
// this, a post that's actually broken (but misclassified as 'network') would
// defer silently forever, one run after another, never surfacing as an error.
const DEFER_ATTEMPTS_LIMIT = 3;

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

async function start(config, onStatus) {
  const { speed, maxPosts, outputFolder, profile } = config;
  const profileName = profile || 'Default';

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
    if (pendingPost?.text) await queueManager.clearPosting(profileName, pendingPost.text);
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

  let queue;
  let context = null;
  try {
    // Shared consumable queue — ALWAYS starts at the first post. There is no
    // resume cursor any more: a published post is deleted from the queue
    // outright (consumePost), so whatever sits at index 0 is BY DEFINITION the
    // next unpublished post. Anything still in the queue has not gone out.
    //
    // This is also why a rate-limit hand-off needs no plumbing: the post the
    // previous profile couldn't publish was never consumed, so it's still at
    // the head and this profile picks it up first, naturally. Prepending it
    // (the old config.priorityPost path) would now publish it TWICE — once as
    // the injected copy, once from the queue itself.
    //
    // Same for the deferred backlog: a network-failed post stays in the queue,
    // so the next run retries it at the head on its own. deferred-posts.json is
    // now only an attempt COUNTER (see the network branch below) — never a
    // re-injection source.
    const interrupted = await queueManager.recoverInterruptedPosts(profileName);
    if (interrupted.length > 0) {
      onStatus({
        type: 'warning',
        message: `⚠️ تم عزل ${interrupted.length} منشور من تشغيل منقطع داخل "بانتظار التحقق" لمنع النشر المكرر.`,
      });
    }
    queue = await queueManager.getQueue();
    const queueTotalAtStart = queue.length;
    onStatus({
      type: 'info',
      message: `Starting automation — البروفايل \"${profileName}\" يبدأ من المنشور #1 (${queueTotalAtStart} في الطابور)`,
      queueCount: queue.length,
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
      throw new Error("AUTH_REQUIRED: Please log in first");
    }

    while (queue.length > 0 && postedCount < maxPosts) {
      if (!global.isRunning) break;

      const rawItem = queue[0];
      // The post EXACTLY as stored in queue.json. Every queue operation
      // (consumePost / addDeferred / addDeadLetter / addToPending) must key off
      // this — never off `postText` below, which spintax may have rewritten.
      const itemText = typeof rawItem === 'string' ? rawItem : rawItem.text;
      const rawText = parseSpintax(itemText);

      // 🔓 DECOUPLED: queue posts are published EXACTLY as stored. Referral
      // links (if any) were already baked in by the studio at generation
      // time — publishing never inspects, rewrites, or rejects post links.
      const postText = rawText;
      const mediaPath = typeof rawItem === 'object' ? rawItem.media_path : null;
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
        queueCount: queue.length,
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
        if (postingAttempted) {
          await queueManager.moveToPending(itemText, profileName, 'stopped_after_submit');
          await queueManager.removeDeferred(profileName, itemText);
          unconfirmedCount++;
          report.recordPostResult({
            postId: `post-${postedCount}`,
            text: itemText,
            status: 'unconfirmed',
            attempts,
            lastError: 'Stopped by user after submit',
          });
        } else {
          await queueManager.clearPosting(profileName, itemText);
        }
      }

      while (!postSuccess && attempts < maxRetries && global.isRunning && !global.isRateLimited) {
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
            await queueManager.markPosting(itemText, profileName);
            await page.keyboard.press('ControlOrMeta+Enter');
            postingAttempted = true;

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
            await interruptibleDelay(10000);
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
        successCount++;
        consecutiveFailures = 0;
        // ✅ PUBLISHED + LINK CAPTURED → delete from the shared queue NOW, for
        // good. This is the single point where the queue shrinks. It runs
        // before anything else that could throw (reporting, CSV, cooldown), so
        // a later failure can never resurrect an already-published post.
        // published: true also archives the text for the studio's semantic
        // dedup, which must keep seeing it long after it leaves the queue.
        await queueManager.consumePost(itemText, { published: true, profileName });
        // A post that had been network-deferred and finally went through — drop
        // its attempt counter so a future post never inherits a stale count.
        await queueManager.removeDeferred(profileName, itemText);
        queue = queue.slice(1);
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: itemText,
          status: 'success',
          attempts: attempts
        });
      } else if (postSuccess === 'unconfirmed') {
        // Remote outcome is ambiguous. Move atomically to the visible recovery
        // list and never auto-retry; the user decides after checking X.
        await queueManager.moveToPending(itemText, profileName, 'ambiguous_publish_result');
        await queueManager.removeDeferred(profileName, itemText);
        queue = queue.slice(1);
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

        // ⏸️ Transient (network) failures are NOT consumed — the post stays in
        // the queue exactly where it is, so the next run (or the next profile)
        // finds it at the head and retries it. Only the local `queue` copy
        // skips past it, giving "try another post now, retry this one later".
        // deferred-posts.json no longer re-injects anything; it survives purely
        // as an attempt COUNTER, so a post that can never go out is eventually
        // consumed into dead-letters instead of blocking the head of the queue
        // forever.
        if (errorType === 'network') {
          await queueManager.clearPosting(profileName, itemText);
          const attemptsSoFar = await queueManager.addDeferred(itemText, errorMsg, profileName);
          queue = queue.slice(1);
          if (attemptsSoFar > DEFER_ATTEMPTS_LIMIT) {
            await queueManager.removeDeferred(profileName, itemText);
            await queueManager.moveToDeadLetter(itemText, errorType, errorMsg, profileName);
            onStatus({ type: 'error', message: `❌ فشل شبكي متكرر (${attemptsSoFar} مرات) — تم نقله للمحذوفات نهائياً.` });
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
          if (queue.length > 0 && postedCount < maxPosts && global.isRunning) {
            const baseCooldownMs = speed * 60 * 1000;
            const minCooldownMs = 15000;
            const randomDelay = Math.floor(Math.random() * (baseCooldownMs - minCooldownMs + 1)) + minCooldownMs;
            const stopEarly = await countdown(randomDelay, onStatus, queue.length, liveStats().success, liveStats().failed);
            if (stopEarly) break;
          }
          continue;
        }

        onStatus({ type: 'error', message: `❌ فشل (${errorType}): ${errorMsg.slice(0, 60)}` });
        // A non-transient failure (selector/platform/unknown) will not fix
        // itself on a retry. Consume it into dead-letters so it can't block the
        // head of the queue forever (Zero-Queue-Block) — dead-letters.json
        // keeps the text, so nothing is actually lost.
        // Clear any stale posting-in-progress marker BEFORE dead-lettering (not
        // just relying on moveToDeadLetter's own internal clear at the end of
        // its multi-step write): if the process crashes between here and
        // moveToDeadLetter finishing, recoverInterruptedPosts() on the next
        // start unconditionally re-quarantines any surviving marker — clearing
        // it first means a crash mid-write leaves this post to be retried
        // once more, instead of surfacing as a duplicate recovery entry.
        await queueManager.clearPosting(profileName, itemText);
        await queueManager.removeDeferred(profileName, itemText);
        queue = queue.slice(1);
        await queueManager.moveToDeadLetter(itemText, errorType, errorMsg, profileName);
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
        queueCount: queue.length,
        stats: liveStats()
      });

      if (queue.length > 0 && postedCount < maxPosts && global.isRunning) {
        const baseCooldownMs = speed * 60 * 1000;
        const minCooldownMs = 15000;
        const randomDelay = Math.floor(Math.random() * (baseCooldownMs - minCooldownMs + 1)) + minCooldownMs;

        const stopEarly = await countdown(randomDelay, onStatus, queue.length, liveStats().success, liveStats().failed);
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
