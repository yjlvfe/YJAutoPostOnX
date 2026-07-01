const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { launchBrowser } = require('./browserManager');
const queueManager = require('./queueManager');
const { ReportEngine } = require('./reportEngine');
const rateLimitStore = require('./rateLimitStore');

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

// ⚡ C5/M5: escape a CSV field — wraps in double quotes and doubles
// any embedded double-quotes, per RFC 4180. Prevents column injection
// when errorMsg / postUrl / postText contain commas, quotes, or newlines.
function escCsv(value) {
  const s = (value == null ? '' : String(value));
  return '"' + s.replace(/"/g, '""') + '"';
}

function getReportDir(profileName) {
  const name = profileName || 'Default';
  if (name === 'Default') {
    return path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'reports');
  }
  return path.join(os.homedir(), '.config', 'x-poster-profiles', name, 'reports');
}

// 🎯 Multi-strategy post confirmation for X.com changing UI + weak networks
const TOAST_SELECTORS = [
  '[data-testid="toast"]',
  '[data-testid="snackbar"]',
  '[role="status"]',
  'div[role="alert"]',
  'a[href*="/status/"]',
];

/**
 * Get the latest tweet URL from the page DOM (picks the last /status/ link).
 * @param {Page} page
 * @returns {Promise<string|null>}
 */
async function getTweetUrlFromDOM(page) {
  try {
    return await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/status/"]');
      if (links.length === 0) return null;
      // Last link in DOM order is typically the most recent tweet
      const last = links[links.length - 1];
      let href = last.href;
      if (href && !href.startsWith('http')) href = 'https://x.com' + href;
      return href;
    });
  } catch { return null; }
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
  let failedCount = 0;
  const failedPosts = [];

  let queue;
  let context = null;
  try {
    // Shared queue — load only the slice starting from this profile's position
    const profileQueueData = await queueManager.getProfileQueue(profileName);
    queue = profileQueueData.posts;
    const queueStartIndex = profileQueueData.startIndex;
    onStatus({
      type: 'info',
      message: `Starting automation — البروفايل \"${profileName}\" يبدأ من المنشور #${queueStartIndex + 1} (${queue.length} متبقٍّ من ${profileQueueData.total})`,
      queueCount: queue.length,
      queueStart: queueStartIndex + 1,
      queueTotal: profileQueueData.total,
    });

    context = await launchBrowser(profile || 'Default');

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
      const postText = parseSpintax(typeof rawItem === 'string' ? rawItem : rawItem.text);
      const mediaPath = typeof rawItem === 'object' ? rawItem.media_path : null;
      postedCount++;
      const postStartTime = Date.now();
      report.logEvent({ level: 'info', event: 'POST_START', postId: `post-${postedCount}`, attempt: 1, message: `Processing post ${postedCount}` });

      onStatus({
        type: 'action',
        message: `Processing post ${postedCount}...`,
        queueCount: queue.length,
        stats: { success: successCount, failed: failedCount }
      });

      // Anti-detection: always start from top, minimal human-like nudges
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 500));

      onStatus({ type: 'info', message: 'Human emulation scrolling...' });
      const nudges = Math.random() < 0.5 ? 1 : 2;
      for (let i = 0; i < nudges; i++) {
        await page.mouse.wheel(0, Math.floor(Math.random() * 200) + 1);
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1001) + 500));
      }

      onStatus({ type: 'info', message: 'Resetting scroll position...' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(r => setTimeout(r, 500));

      if (!global.isRunning) break;

      let postSuccess = false;
      let confirmedPostUrl = null;
      let attempts = 0;
      let lastError = null;
      const maxRetries = 3;

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
          await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
          await textarea.click({ force: true });
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 500));
           
          await page.keyboard.type(postText, { delay: Math.floor(Math.random() * 150) + 50 });
          await new Promise(r => setTimeout(r, 500));

          if (mediaPath) {
            onStatus({ type: 'info', message: 'Uploading media...' });
            try {
              await fs.access(mediaPath);
              const fileInput = await waitForSelectorInterruptible(page, 'input[type="file"]', 5000);
              await fileInput.setInputFiles(mediaPath);
              await waitForSelectorInterruptible(page, '[data-testid="imageCropper"]', 15000);
              onStatus({ type: 'info', message: 'Media uploaded' });
            } catch (mediaErr) {
              onStatus({ type: 'warning', message: `Media error: ${mediaErr.message}` });
              // Clear textarea to prevent half-composed state on retry
              try {
                await page.keyboard.press('ControlOrMeta+A');
                await page.keyboard.press('Backspace');
              } catch (e) { /* best-effort cleanup */ }
              throw new Error('Media upload failed: ' + mediaErr.message);
            }
          }

          await new Promise(r => setTimeout(r, 1000));

          confirmedPostUrl = null;
          postSuccess = false;

          try {
            await new Promise(r => setTimeout(r, 1000));
            await textarea.focus();
            // Mouse movement before posting — human-like behavior
            await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100, { steps: 10 });
            await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
            await page.keyboard.press('ControlOrMeta+Enter');
            
            onStatus({ type: 'info', message: `Post triggered via ${PLATFORM_KEY_LABEL}+Enter, awaiting server confirmation...` });
            try {
              const toast = await waitForSelectorInterruptible(page, '[data-testid="toast"]', 10000);
              const link = await toast.$('a');
              if (link) {
                confirmedPostUrl = await link.getAttribute('href');
                if (confirmedPostUrl && !confirmedPostUrl.startsWith('http')) {
                  confirmedPostUrl = `https://x.com${confirmedPostUrl}`;
                }
              }
              postSuccess = true;
            } catch (toastErr) {
              onStatus({ type: 'warning', message: 'Toast not detected, performing double-check...' });
              
              const buttonVisible = await page.locator('[data-testid="tweetButtonInline"]').count() > 0;
              
              if (!buttonVisible) {
                postSuccess = 'unconfirmed';
                onStatus({ type: 'warning', message: 'Post button disappeared but no confirmation toast - marking as unconfirmed' });
              } else {
                onStatus({ type: 'warning', message: `Attempt ${attempts}/${maxRetries}: trying Ctrl+Enter...` });
                try {
                  // Mouse movement before fallback post — human-like behavior
                  await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100, { steps: 10 });
                  await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
                  await page.keyboard.press('ControlOrMeta+Enter');
                  const toast = await waitForSelectorInterruptible(page, '[data-testid="toast"]', 8000);
                  const link = await toast.$('a');
                  if (link) {
                    confirmedPostUrl = await link.getAttribute('href');
                    if (confirmedPostUrl && !confirmedPostUrl.startsWith('http')) {
                      confirmedPostUrl = `https://x.com${confirmedPostUrl}`;
                    }
                  }
                  postSuccess = true;
                } catch (fallbackErr) {
                  postSuccess = false;
                }
              }
            }
          } catch (clickErr) {
            onStatus({ type: 'warning', message: `Attempt ${attempts}/${maxRetries}: Control+Enter failed, retrying...` });
            try {
              // Mouse movement before retry post — human-like behavior
              await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100, { steps: 10 });
              await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
              await page.keyboard.press('ControlOrMeta+Enter');
              const toast = await waitForSelectorInterruptible(page, '[data-testid="toast"]', 8000);
              const link = await toast.$('a');
              if (link) {
                confirmedPostUrl = await link.getAttribute('href');
                if (confirmedPostUrl && !confirmedPostUrl.startsWith('http')) {
                  confirmedPostUrl = `https://x.com${confirmedPostUrl}`;
                }
              }
              postSuccess = true;
            } catch (fallbackErr) {
              postSuccess = false;
            }
          }

        } catch (err) {
          if (err.message === 'STOPPED_BY_USER') throw err;
          lastError = err;
          onStatus({ type: 'warning', message: `Attempt ${attempts} failed: ${err.message}` });
          await page.evaluate(() => window.scrollTo(0, 0));
          await new Promise(r => setTimeout(r, 1500));

          if (err.name === 'TimeoutError' || err.message.includes('net::') || err.message.includes('connection')) {
            onStatus({ type: 'warning', message: 'Network/Timeout error, attempting recovery...' });
            await new Promise(r => setTimeout(r, 10000));
            // DOM recovery — try reload first, then full navigation, then fallback
            let recoverySuccess = false;
            try {
              await page.goto('https://x.com/home', { timeout: 45000, waitUntil: 'domcontentloaded' });
              recoverySuccess = true;
            } catch (reloadErr) {
              console.error('Recovery reload failed, trying navigation:', reloadErr.message);
            }
            if (!recoverySuccess) {
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
        let pageContent;
        let isRateLimitedVal = false;
        try {
          // 🛡️ ONLY scan visible text — not full HTML (prevents false positives from JS/CSS)
          pageContent = await page.evaluate(() => document.body.innerText);
          const rateLimitPatterns = [
            /\brate\b.*\blimit\b/i, /\btoo many requests\b/i, /\b429\b/,
            /\bplease wait a few minutes\b/i, /\brate limited\b/i, /\bratelimit\b/i,
            /معدل\s+الطلبات/i, /تم\s+تقييد/i, /حالة\s+معدل/i,
            // X.com specific rate limit error messages
            /you are unable to post/i, /slow down/i, /temporary limit/i,
          ];
          isRateLimitedVal = rateLimitPatterns.some(pattern => pattern.test(pageContent));
        } catch (e) {
          // If evaluate fails (page crash), fallback to old method
          try {
            pageContent = await page.content();
            const fallbackPatterns = [
              /\brate\b.*\blimit\b/i, /\btoo many requests\b/i, /\b429\b/,
              /\bplease wait a few minutes\b/i, /\brate limited\b/i,
            ];
            isRateLimitedVal = fallbackPatterns.some(pattern => pattern.test(pageContent));
          } catch (e2) {
            isRateLimitedVal = false;
          }
        }
        
        if (isRateLimitedVal && global.isRunning) {
          global.isRateLimited = true;
          // Try to read an explicit cooldown duration from the page text
          // ("try again in 25 minutes" / "بعد 30 دقيقة"); fall back to default.
          const parsedMs = rateLimitStore.parseCooldownFromText(pageContent);
          const cd = rateLimitStore.setCooldown(profileName, parsedMs, {
            source: parsedMs ? 'x' : 'default',
            note: parsedMs ? 'مدة مأخوذة من رسالة تويتر' : 'مدة افتراضية',
          });
          const remainTxt = rateLimitStore.formatRemaining(cd.until - Date.now());
          onStatus({
            type: 'error',
            message: `🚫 البروفايل "${profileName}" ضرب حد تويتر — توقف فوراً. الكول داون: ${remainTxt}`,
            rateLimited: true,
            profile: profileName,
            cooldownUntil: cd.until,
          });
          report.logEvent({ level: 'error', event: 'RATE_LIMIT', postId: `post-${postedCount}`, attempt: attempts, message: `Rate limited — cooldown until ${new Date(cd.until).toISOString()}` });
          // Stop this profile's run IMMEDIATELY (no 15-min sleep, no retry).
          // The orchestrator (main.js) will move to the next profile.
          throw new Error('RATE_LIMITED');
        }
      }

      if (postSuccess === true) {
        successCount++;
        await queueManager.advancePosition(profileName);
        queue = queue.slice(1);
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: typeof rawItem === 'string' ? rawItem : rawItem.text,
          status: 'success',
          attempts: attempts
        });
      } else if (postSuccess === 'unconfirmed') {
        const itemText = typeof rawItem === 'string' ? rawItem : rawItem.text;
        await queueManager.advancePosition(profileName);
        queue = queue.slice(1);
        await queueManager.addToPending(itemText, profileName);
        onStatus({ type: 'warning', message: 'Post moved to pending verification (unconfirmed status)' });
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: itemText,
          status: 'unconfirmed',
          attempts: attempts
        });
      } else {
        // Classify error type from last captured error
        let errorType = 'unknown';
        let errorMsg = `Failed after ${maxRetries} attempts`;
        if (lastError) {
          errorMsg = lastError.message || errorMsg;
          const msg = lastError.message || '';
          if (msg.includes('net::') || msg.includes('ECONN') || msg.includes('connection') || lastError.name === 'TimeoutError') {
            errorType = 'network';
          } else if (msg.includes('waitForSelector') || msg.includes('selector') || msg.includes('locator') || msg.includes('strict mode violation')) {
            errorType = 'selector';
          } else if (msg.includes('Target closed') || msg.includes('browser') || msg.includes('context') || msg.includes('page') || msg.includes('crash')) {
            errorType = 'platform';
          }
        }
        failedCount++;
        failedPosts.push(postText);
        onStatus({ type: 'error', message: `❌ فشل (${errorType}): ${errorMsg.slice(0, 60)}` });
        // Advance position to prevent infinite retry loop (Zero-Queue-Block)
        const itemToDelete = typeof rawItem === 'string' ? rawItem : rawItem.text;
        await queueManager.advancePosition(profileName);
        queue = queue.slice(1);
        await queueManager.addDeadLetter(itemToDelete, errorType, errorMsg, profileName);
        report.recordPostResult({
          postId: `post-${postedCount}`,
          text: typeof rawItem === 'string' ? rawItem : rawItem.text,
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
      }

      // 🔗 Fallback URL extraction if confirmation missed the URL
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
      postUrl = postUrl || 'N/A';

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
        stats: { success: successCount, failed: failedCount }
      });

      if (queue.length > 0 && postedCount < maxPosts && global.isRunning) {
        const baseCooldownMs = speed * 60 * 1000;
        const minCooldownMs = 15000;
        const randomDelay = Math.floor(Math.random() * (baseCooldownMs - minCooldownMs + 1)) + minCooldownMs;

        const stopEarly = await countdown(randomDelay, onStatus, queue.length, successCount, failedCount);
        if (stopEarly) break;
      }
    }

    if (!global.isRunning) {
      onStatus({ type: 'warning', message: 'Automation stopped by user', stats: { success: successCount, failed: failedCount } });
    } else {
      onStatus({ type: 'info', message: 'Task completed', stats: { success: successCount, failed: failedCount } });
    }
    await report.endRun();
    return {
      status: global.isRunning ? 'completed' : 'stopped',
      profile: profileName,
      success: successCount,
      failed: failedCount,
    };
  } catch (error) {
    if (error.message === 'STOPPED_BY_USER') {
      onStatus({ type: 'warning', message: 'Automation stopped by user', stats: { success: successCount, failed: failedCount } });
      await report.endRun();
      return { status: 'stopped', profile: profileName, success: successCount, failed: failedCount };
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
        failed: failedCount,
        cooldownUntil: cd ? cd.until : null,
      };
    }
    onStatus({ type: 'error', message: error.message, stats: { success: successCount, failed: failedCount } });
    report.logEvent({ level: 'error', event: 'RUN_ERROR', postId: null, attempt: 0, message: error.message });
    await report.endRun();
    throw error;
  } finally {
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
  let totalSuccess = 0, totalFailed = 0, limitedCount = 0, skippedCount = 0;

  for (let i = 0; i < profiles.length; i++) {
    if (!global.isRunning) {
      onStatus({ type: 'warning', message: '🛑 تم الإيقاف بواسطة المستخدم.' });
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
      res = await start({ ...config, profile: profileName }, onStatus);
    } catch (err) {
      // A hard error on one profile shouldn't kill the whole batch.
      onStatus({ type: 'error', message: `خطأ في "${profileName}": ${err.message}` });
      res = { status: 'error', profile: profileName, success: 0, failed: 0, error: err.message };
    }
    results.push(res);
    totalSuccess += res.success || 0;
    totalFailed += res.failed || 0;

    if (res.status === 'rate_limited') {
      limitedCount++;
      onStatus({
        type: 'warning',
        message: `➡️ "${profileName}" ضرب حد — الانتقال للبروفايل التالي...`,
      });
      // global.isRateLimited was set true inside start(); reset before next.
      global.isRateLimited = false;
      continue;
    }
    if (res.status === 'cooldown') { skippedCount++; continue; }
    if (res.status === 'stopped') break;
  }

  const summary = {
    profilesRun: results.length,
    totalSuccess,
    totalFailed,
    rateLimited: limitedCount,
    skippedCooldown: skippedCount,
  };
  onStatus({
    type: 'info',
    message: `✅ انتهى التشغيل المتعدد — نجح ${totalSuccess}، فشل ${totalFailed}، حدود ${limitedCount}، متخطّى ${skippedCount}.`,
    multiDone: true,
    summary,
  });
  return { results, summary };
}

module.exports = { start, startMulti };
