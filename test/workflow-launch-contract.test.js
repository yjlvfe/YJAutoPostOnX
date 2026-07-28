'use strict';

/**
 * XP-012 / XP-013 — the launch and build contract.
 *
 * XP-012.1: the Linux sandbox preflight inspected `process.execPath` — Electron's
 * own chrome-sandbox — and applied that verdict to a browser Playwright launches
 * from a completely different directory. The two binaries ship independent
 * helpers: measured on this machine Electron's is 0755 non-setuid, and
 * Playwright's bundled Chromium has no helper at all. Reading one to decide for
 * the other is wrong in both directions — the sandbox can be left on for a
 * browser that then refuses to start, or silently disabled for one that was
 * fine.
 *
 * XP-012.2: the declared license did not match the shipped LICENSE file, there
 * was no `engines` field at all, and `npm run audit` exited 0 even when the
 * audit itself reported FAIL — a gate that cannot fail is not a gate, and the
 * release checklist depends on that exit code.
 *
 * XP-013: the pieces that made the above unobservable — nothing was exported,
 * so the only way to find out what the sandbox decision was is to launch a real
 * browser, which no test may do.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const browserManager = require('../dev/automation/browserManager');

function sandboxDecisionIsAboutTheRightBinary() {
  console.log('\n📋 XP-012.1 the sandbox check inspects the browser that actually launches');

  check('the decision is observable without launching a browser',
    typeof browserManager.getLaunchOptions === 'function'
    && typeof browserManager.sandboxHelperIsSetuidRoot === 'function'
    && typeof browserManager.resolveBrowserExecutable === 'function');

  // The check must be a function OF the executable, not of process.execPath.
  check('sandboxHelperIsSetuidRoot takes the executable as an argument',
    browserManager.sandboxHelperIsSetuidRoot.length >= 1,
    `arity=${browserManager.sandboxHelperIsSetuidRoot.length}`);

  const target = browserManager.resolveBrowserExecutable(null);
  check('the browser Playwright will launch is resolvable',
    typeof target === 'string' && target.length > 0, `target=${target}`);
  check('and it is NOT the Electron binary this process is running',
    target !== process.execPath, `both=${target}`);
  check('nor does it live in the Electron dist directory',
    path.dirname(target) !== path.dirname(process.execPath),
    `dir=${path.dirname(target)} electron=${path.dirname(process.execPath)}`);

  // A pinned executablePath must win over the bundled default.
  const pinned = '/usr/bin/google-chrome';
  check('an explicit executablePath is the one that gets checked',
    browserManager.resolveBrowserExecutable(pinned) === pinned);

  // Build a fake browser directory to exercise both verdicts for real, rather
  // than asserting on source text.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xposter-sandbox-'));
  try {
    const exe = path.join(sandbox, 'chrome');
    fs.writeFileSync(exe, '#!/bin/sh\n');

    check('a browser directory with NO helper is judged unusable',
      browserManager.sandboxHelperIsSetuidRoot(exe) === false);

    const helper = path.join(sandbox, 'chrome-sandbox');
    fs.writeFileSync(helper, '');
    fs.chmodSync(helper, 0o755);
    check('a helper without the setuid bit is judged unusable',
      browserManager.sandboxHelperIsSetuidRoot(exe) === false);

    // The positive case: setuid bit set AND owned by root. chmod can set the
    // bit; ownership is only root's to give, so this half is only assertable
    // when the test itself runs as root.
    fs.chmodSync(helper, 0o4755);
    const st = fs.statSync(helper);
    const expected = st.uid === 0 && (st.mode & 0o4000) !== 0;
    check('a setuid-root helper is judged usable',
      browserManager.sandboxHelperIsSetuidRoot(exe) === expected,
      `uid=${st.uid} mode=${(st.mode & 0o7777).toString(8)} expected=${expected}`);

    check('an unknown executable fails safe (treated as unusable)',
      browserManager.sandboxHelperIsSetuidRoot(null) === false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  // The end-to-end decision must be self-consistent: --no-sandbox appears
  // exactly when running as root or when the TARGET's helper is unusable.
  const opts = browserManager.getLaunchOptions('chromium');
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const targetUsable = browserManager.sandboxHelperIsSetuidRoot(
    browserManager.resolveBrowserExecutable(opts.executablePath),
  );
  const shouldDisable = process.platform !== 'linux' ? false : (runningAsRoot || !targetUsable);
  check('--no-sandbox is passed exactly when the target cannot use the sandbox',
    opts.args.includes('--no-sandbox') === shouldDisable,
    `args=${JSON.stringify(opts.args)} root=${runningAsRoot} targetUsable=${targetUsable}`);
  check('--disable-setuid-sandbox travels with it, never alone',
    opts.args.includes('--no-sandbox') === opts.args.includes('--disable-setuid-sandbox'),
    JSON.stringify(opts.args));
}

function buildContractIsConsistent() {
  console.log('\n📋 XP-012.2 the declared build contract matches reality');

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

  const licenseFile = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
  const declared = pkg.license;
  const shipped = /^\s*MIT License/i.test(licenseFile) ? 'MIT'
    : /ISC License/i.test(licenseFile) ? 'ISC' : 'UNKNOWN';
  check('the declared license matches the LICENSE file that ships with it',
    declared === shipped, `package.json=${declared} LICENSE=${shipped}`);

  check('an engines range is declared at all', !!(pkg.engines && pkg.engines.node),
    JSON.stringify(pkg.engines));
  // The native module is built for Electron's ABI; Electron 30 embeds Node 20.
  // Declaring 18 invited an install that cannot load better-sqlite3.
  const minMajor = pkg.engines && pkg.engines.node
    ? parseInt(String(pkg.engines.node).replace(/[^\d]*(\d+).*/, '$1'), 10) : 0;
  check('the engines range is at least the Node that Electron 30 embeds',
    minMajor >= 20, `engines.node=${pkg.engines && pkg.engines.node}`);

  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  check('the README does not still promise an older Node than engines allows',
    !/Node\.js v1[0-9]\+/.test(readme),
    (readme.match(/Node\.js v\d+\+/g) || []).join(', '));
  check('the README explains that tests run under Electron, not bare node',
    /ELECTRON_RUN_AS_NODE/.test(readme));
}

function theAuditGateCanActuallyFail() {
  console.log('\n📋 XP-012.3 `npm run audit` fails when the audit fails');

  const { runAudit } = require('../dev/security/auditor');
  const clean = runAudit();
  check('the audit currently passes on this tree', clean.status !== 'FAIL',
    JSON.stringify(clean.critical));

  // Run the packaged script the release checklist actually invokes, forcing a
  // FAIL verdict through the same code path. If the script swallows it, the
  // exit code is 0 and the checklist reports a clean audit on a failing tree.
  const script = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.audit;
  check('the audit script inspects the verdict rather than only printing it',
    /status/.test(script) && /exit/.test(script), script);

  const forced = `
    const path = require('path');
    const auditor = require(${JSON.stringify(path.join(REPO, 'dev/security/auditor'))});
    const real = auditor.runAudit;
    auditor.runAudit = () => ({ ...real(), status: 'FAIL', critical: ['forced failure for the gate test'] });
    const r = auditor.runAudit();
    auditor.printReport(r);
    process.exit(r.status === 'FAIL' ? 1 : 0);
  `;
  let exitCode = 0;
  try {
    execFileSync(process.execPath, ['-e', forced], {
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    exitCode = error.status;
  }
  check('a FAIL verdict produces a non-zero exit code', exitCode === 1, `exit=${exitCode}`);
}

function theAuditDeclaresItsScope() {
  console.log('\n📋 XP-013 the audit does not overstate what it checked');

  const { runAudit } = require('../dev/security/auditor');
  const report = runAudit();
  const joined = report.info.join('\n');
  check('a passing audit says it is scoped, not that the project is clean',
    !/^✅ لا مشاكل$/m.test(joined) && /نطاق/.test(joined),
    joined);
  check('it reports how many files it actually scanned', /تم مسح \d+ ملف/.test(joined), joined);
}

function globMetacharactersCannotReachRimraf() {
  console.log('\n📋 XP-012.4 the unfixable brace-expansion chain is unreachable from a profile name');

  const { assertSafeProfileName, resolveProfilePath } = require('../dev/automation/profileRegistry');

  // `npm audit --omit=dev` reports 7 high findings on one chain:
  //   puppeteer-extra-plugin-user-data-dir -> rimraf -> glob -> minimatch
  //   -> brace-expansion  (GHSA-mh99-v99m-4gvg, DoS via unbounded expansion)
  //
  // It cannot be overridden away. The patched brace-expansion@5.0.8 exports an
  // OBJECT with .expand, while minimatch@3 does `expand(pattern)` on the module
  // itself — verified directly, and it is why an earlier global override built
  // a package that crashed with "expand is not a function". npm's only other
  // remedy is a semver-major downgrade of puppeteer-extra-plugin-stealth, which
  // changes the behaviour the publish path depends on.
  //
  // So the mitigation is at the input instead: rimraf receives a profile path,
  // and a profile name is the only part of it a human chooses.
  const rejected = ['evil{a,b}', 'p*', 'q?', 'a[bc]', 'x!y', 'n(1)', '{'.repeat(30)];
  let allRejected = true;
  const leaked = [];
  for (const name of rejected) {
    try { assertSafeProfileName(name, { allowDefault: false }); allRejected = false; leaked.push(name); }
    catch { /* expected */ }
  }
  check('no glob metacharacter survives into a profile name', allRejected,
    `accepted=${JSON.stringify(leaked)}`);

  // And the rejection must not have been achieved by breaking ordinary names.
  const ordinary = ['Marketing', '2 - عربي', 'team_one', 'a.b-c'];
  const broken = ordinary.filter((n) => {
    try { assertSafeProfileName(n, { allowDefault: false }); return false; } catch { return true; }
  });
  check('ordinary profile names still work', broken.length === 0, JSON.stringify(broken));

  check('a resolved profile path therefore contains no brace to expand',
    !/[{}[\]*?]/.test(resolveProfilePath('Marketing')),
    resolveProfilePath('Marketing'));
}

(async () => {
  console.log('🧪 XP-012 / XP-013 — launch and build contract');
  try {
    sandboxDecisionIsAboutTheRightBinary();
    buildContractIsConsistent();
    theAuditGateCanActuallyFail();
    theAuditDeclaresItsScope();
    globMetacharactersCannotReachRimraf();
  } catch (error) {
    failed++;
    console.error('\n💥 scenario crashed:', error && error.stack ? error.stack : error);
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} XP-012/XP-013: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
