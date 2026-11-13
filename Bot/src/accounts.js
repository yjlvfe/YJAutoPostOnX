'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { constants } = fsSync;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseCsv } = require('./csv');
const { parseCookies, detectFormat } = require('./cookieFormat');

const MAX_ACCOUNTS = Infinity;
const MAX_ACTIVE_ACCOUNTS = 5;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_COOKIE_FILE_BYTES = 1024 * 1024;
const MAX_COOKIE_BYTES = MAX_COOKIE_FILE_BYTES;

function isCaptchaStatus(status) {
  if (typeof status !== 'string') return false;
  const s = status.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return (
    s === 'كابتشا' ||
    s === 'كابتشا (مطلوب حل يدوي)' ||
    s === 'كابتشا - يتطلب حل يدوي' ||
    s.startsWith('كابتشا') ||
    s.includes('كابتشا') ||
    ['captcha', 'challenge', 'verification_required', 'needs_owner_captcha'].includes(lower)
  );
}

function isBannedStatus(status) {
  if (typeof status !== 'string') return false;
  const s = status.trim();
  if (!s) return false;
  return s === 'محظور' || ['suspended', 'banned'].includes(s.toLowerCase());
}

function isUnverifiedStatus(status) {
  if (typeof status !== 'string') return false;
  const s = status.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return (
    s === 'غير محقق' ||
    s === 'غير محقق (جلسة غير مؤكدة)' ||
    s === 'غير متحقق' ||
    s === 'غير متحقق (يتطلب فحص الجلسة)' ||
    s.includes('غير محقق') ||
    s.includes('غير متحقق') ||
    ['auth_session_unverified', 'unverified'].includes(lower)
  );
}

const INACTIVE_STATUSES = [
  'محظور',
  'كابتشا',
  'كابتشا (مطلوب حل يدوي)',
  'كابتشا - يتطلب حل يدوي',
  'غير محقق',
  'غير محقق (جلسة غير مؤكدة)',
  'غير متحقق',
  'غير متحقق (يتطلب فحص الجلسة)',
  'غير مفعل',
  'غير نشط',
  'معزول (3 إخفاقات)'
];

function isAccountInactive(status) {
  if (!status) return false;
  return (
    INACTIVE_STATUSES.includes(status) ||
    isCaptchaStatus(status) ||
    isBannedStatus(status) ||
    isUnverifiedStatus(status)
  );
}

const RESTRICTION_FLAGS = ['challenge', 'locked', 'captcha', 'suspended', 'banned', 'accountFailure'];
const DISABLED_STATUSES = ['غير مفعل', 'غير نشط', 'خامل', 'disabled', 'inactive'];
function hasHardRestriction(account) {
  return Boolean(account && (account.needsOwnerCaptcha || isCaptchaStatus(account.status) || isBannedStatus(account.status) ||
    ['locked', 'account_locked', 'quarantined', 'معزول (3 إخفاقات)'].includes(String(account.status || '').trim().toLowerCase()) ||
    RESTRICTION_FLAGS.some(key => Boolean(account[key]))));
}
function activeLimit(value = MAX_ACTIVE_ACCOUNTS) {
  return Number.isFinite(value) && value >= 0 ? Math.min(MAX_ACTIVE_ACCOUNTS, Math.floor(value)) : MAX_ACTIVE_ACCOUNTS;
}
function enabledCount(accounts, exceptId) {
  return (accounts || []).filter(account => account.id !== exceptId && account.enabled !== false).length;
}

// Cookie-backed owner intent is sufficient. Observations are optional, not an
// admission prerequisite; positive hard restrictions still fail closed.
function evaluateAccountUse(state, account, { expectedRevision, requireOwnerEnabled = true } = {}) {
  const deny = reason => ({ allowed: false, reason });
  if (!account) return deny('account_not_found');
  if (isBannedStatus(account.status)) return deny('banned');
  if (account.needsOwnerCaptcha || isCaptchaStatus(account.status)) return deny('captcha');
  if (hasHardRestriction(account)) return deny('account_restricted');
  if (requireOwnerEnabled && account.enabled === false) return deny('owner_disabled');
  const status = String(account.status || '').trim().toLowerCase();
  const activeStatus = !status || ['مفعل', 'active', 'enabled'].includes(status) || isUnverifiedStatus(status);
  if (!activeStatus && !(requireOwnerEnabled === false && DISABLED_STATUSES.includes(status))) return deny('status_unverified');
  if (expectedRevision !== undefined && expectedRevision !== account.checkGeneration) return deny('revision_changed');
  if (!account.cookieFile) return deny('session_missing');
  const session = state?.telegramUi?.accountChecks?.[account.id]?.session;
  // Ignore observations explicitly tied to superseded credentials/revisions.
  const currentSession = session && (!session.checkGeneration || session.checkGeneration === account.checkGeneration) &&
    (!session.cookieFile || session.cookieFile === account.cookieFile);
  if (currentSession) {
    if (hasHardRestriction(session)) return deny('session_restricted');
    const username = normalizeUsername(account.username)?.toLowerCase();
    if (username && session.username && normalizeUsername(session.username)?.toLowerCase() !== username) return deny('identity_mismatch');
    if (account.userId && session.userId && String(account.userId) !== String(session.userId)) return deny('identity_mismatch');
  }
  return { allowed: true, reason: null };
}

function applyOwnerEnabled(state, accountId, enabled, opts = {}) {
  const account = state?.accounts?.find(item => item.id === accountId);
  const result = (applied, reason = null) => ({ applied, reason, accountId });
  if (!account) return result(false, 'account_not_found');
  if (typeof enabled !== 'boolean') return result(false, 'invalid_enabled');
  if (!enabled) {
    account.enabled = false;
    if (['مفعل', 'active', 'enabled'].includes(account.status)) account.status = 'غير مفعل';
    return result(true);
  }
  const policy = evaluateAccountUse(state, account, { ...opts, requireOwnerEnabled: false });
  if (!policy.allowed) return result(false, policy.reason);
  const limit = activeLimit(opts.maxActiveAccounts);
  if (enabledCount(state.accounts, accountId) >= limit) return result(false, 'active_account_limit');
  account.enabled = true;
  account.status = 'مفعل';
  return result(true);
}

function normalizeAccountId(value) {
  const id = String(value ?? '').trim();
  if (!ACCOUNT_ID.test(id)) throw new Error('Account id must be 1-64 letters, numbers, dot, dash, or underscore');
  return id;
}

function normalizeUsername(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/^@/, '').trim().slice(0, 30);
  return cleaned || null;
}

function accountRecord(input = {}) {
  const id = normalizeAccountId(input.id ?? input.account ?? input.name);
  if (input.userId != null && (typeof input.userId !== 'string' || !/^\d+$/.test(input.userId))) {
    throw new Error('userId must be a numeric string');
  }
  const rawStatus = String(input.status || '').trim();
  let normStatus = rawStatus;
  if (isBannedStatus(rawStatus)) {
    normStatus = 'محظور';
  } else if (isCaptchaStatus(rawStatus) || Boolean(input.needsOwnerCaptcha)) {
    if (rawStatus === 'كابتشا - يتطلب حل يدوي') {
      normStatus = 'كابتشا - يتطلب حل يدوي';
    } else if (rawStatus.includes('حل يدوي')) {
      normStatus = 'كابتشا (مطلوب حل يدوي)';
    } else if (rawStatus === 'كابتشا') {
      normStatus = 'كابتشا';
    } else {
      normStatus = 'كابتشا (مطلوب حل يدوي)';
    }
  } else if (isUnverifiedStatus(rawStatus)) {
    normStatus = rawStatus === 'غير متحقق (يتطلب فحص الجلسة)'
      ? 'غير متحقق (يتطلب فحص الجلسة)'
      : 'غير محقق (جلسة غير مؤكدة)';
  } else if (rawStatus === 'معزول (3 إخفاقات)') {
    normStatus = 'معزول (3 إخفاقات)';
  } else if (['غير مفعل', 'غير نشط', 'خامل', 'disabled', 'inactive'].includes(rawStatus.toLowerCase()) || rawStatus === 'غير مفعل' || rawStatus === 'غير نشط') {
    normStatus = 'غير مفعل';
  } else if (input.enabled === false) {
    normStatus = 'غير مفعل';
  } else {
    // Preserve an explicit/unknown status; never turn it into an active status.
    normStatus = rawStatus || (input.enabled === false ? 'غير مفعل' : 'مفعل');
  }

  const isChallengePending = Boolean(input.needsOwnerCaptcha) || isCaptchaStatus(normStatus);
  const isRestricted = isChallengePending || hasHardRestriction({ ...input, status: normStatus }) || normStatus === 'غير مفعل' || normStatus === 'غير نشط';
  const enabled = !isRestricted && input.enabled !== false;

  const record = {
    id,
    label: String(input.label ?? id).trim().slice(0, 100) || id,
    username: normalizeUsername(input.username ?? input.handle),
    ...(input.userId != null ? { userId: input.userId } : {}),
    enabled,
    status: normStatus,
    ...Object.fromEntries(RESTRICTION_FLAGS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])),
    ...(require('./publicIp').isPublicIp(input.exitIp) ? { exitIp: input.exitIp } : {}),
    cookieFile: input.cookieFile ? String(input.cookieFile) : null,
    ...(input.verifiedAt ? { verifiedAt: String(input.verifiedAt) } : {}),
    ...(input.checkGeneration ? { checkGeneration: String(input.checkGeneration) } : {}),
    ...(input.vpnResource ? { vpnResource: String(input.vpnResource) } : {}),
    ...(input.needsOwnerCaptcha != null || isChallengePending
      ? { needsOwnerCaptcha: input.needsOwnerCaptcha != null ? Boolean(input.needsOwnerCaptcha) : true }
      : {}),
    ...(input.captchaDetectedAt != null ? { captchaDetectedAt: Number(input.captchaDetectedAt) } : {}),
    ...(input.captchaCode != null ? { captchaCode: Number(input.captchaCode) } : {}),
    ...(input.captchaReason ? { captchaReason: String(input.captchaReason) } : {}),
    ...(input.captchaIncidentId ? { captchaIncidentId: String(input.captchaIncidentId) } : {}),
    ...(input.lastCaptchaVerifyAt != null ? { lastCaptchaVerifyAt: Number(input.lastCaptchaVerifyAt) } : {}),
    ...(input.lastNotifiedCaptchaIncidentId ? { lastNotifiedCaptchaIncidentId: String(input.lastNotifiedCaptchaIncidentId) } : {}),
    ...(Array.isArray(input.captchaDeliveredChats) ? { captchaDeliveredChats: input.captchaDeliveredChats.map(String) } : {}),
    ...(input.captchaDeliveredIncidentId ? { captchaDeliveredIncidentId: String(input.captchaDeliveredIncidentId) } : {}),
    ...(input.lastCaptchaAlertAt != null ? { lastCaptchaAlertAt: Number(input.lastCaptchaAlertAt) } : {}),
    ...(input.captchaResolvedAt != null ? { captchaResolvedAt: Number(input.captchaResolvedAt) } : {}),
    ...(input.unverifiedReason ? { unverifiedReason: String(input.unverifiedReason) } : {}),
    ...(input.lastError ? { lastError: String(input.lastError) } : {}),
    ...(input.lastErrorAt ? { lastErrorAt: String(input.lastErrorAt) } : {}),
    failures: input.failures == null || input.failures === '' ? 0 : nonNegativeInteger(input.failures, 'failures'),
    quota: input.quota == null || input.quota === '' ? null : positiveInteger(input.quota, 'quota'),
    delayMs: input.delayMs == null || input.delayMs === '' ? null : nonNegativeInteger(input.delayMs, 'delayMs')
  };
  return record;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function isAuthorizedVerificationClear(current, patch = {}) {
  const wasCaptcha = Boolean(current.needsOwnerCaptcha) || isCaptchaStatus(current.status);
  const wasBanned = isBannedStatus(current.status);
  const wasUnverified = isUnverifiedStatus(current.status);

  if (wasBanned) {
    // Banned accounts can only be cleared when a new cookieFile is verified.
    return Boolean(patch.cookieFile && patch.cookieFile !== current.cookieFile && patch.verifiedAt != null);
  }
  if (wasCaptcha) {
    // Only explicit owner CAPTCHA verification transition (setting needsOwnerCaptcha: false and captchaResolvedAt or verifiedAt) can clear CAPTCHA.
    return patch.needsOwnerCaptcha === false && (patch.captchaResolvedAt != null || patch.verifiedAt != null) && patch.enabled !== true;
  }
  if (wasUnverified) {
    // Unverified accounts can only be cleared by explicit session verification or new verified cookie.
    return Boolean(patch.verifiedAt != null);
  }
  return true;
}

class AccountManager {
  constructor(store, { maxAccounts = Infinity, maxActiveAccounts = MAX_ACTIVE_ACCOUNTS, beforeMutation, onChange, activationVerifier } = {}) {
    if (!store) throw new TypeError('AccountManager requires a store');
    this.store = store;
    this.maxAccounts = maxAccounts;
    this.maxActiveAccounts = activeLimit(maxActiveAccounts);
    this.beforeMutation = typeof beforeMutation === 'function' ? beforeMutation : null;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.activationVerifier = typeof activationVerifier === 'function' ? activationVerifier : null;
    this.pending = Promise.resolve();
  }

  async _prepareActivation(account, operation, patch = {}) {
    const snapshot = await this.store.load();
    const captured = (snapshot.accounts || []).find(item => item.id === account.id);
    if (!captured) throw new Error('Account not found');
    if (captured.enabled === true) return null;
    const currentPolicy = evaluateAccountUse(snapshot, captured, {
      requireOwnerEnabled: false,
      expectedRevision: captured.checkGeneration
    });
    if (currentPolicy.allowed) return null;
    if (!this.activationVerifier) throw new Error(`ACTIVATION_DENIED:${currentPolicy.reason}`);
    const verified = await this.activationVerifier(structuredClone(captured), {
      operation,
      patch: structuredClone(patch),
      state: structuredClone(snapshot),
      reason: currentPolicy.reason
    });
    if (!verified) throw new Error('ACTIVATION_DENIED:verification_failed');
    const session = verified.session || verified.accountCheck?.session || (verified.authenticated === true ? verified : null);
    if (!session) throw new Error('ACTIVATION_DENIED:verification_missing');
    return { accountId: captured.id, revision: captured.checkGeneration, session: structuredClone(session) };
  }

  _applyActivationProof(state, proof) {
    if (!proof) return;
    const account = (state.accounts || []).find(item => item.id === proof.accountId);
    if (!account || account.checkGeneration !== proof.revision) throw new Error('ACTIVATION_DENIED:revision_changed');
    state.telegramUi ||= {}; state.telegramUi.accountChecks ||= {};
    const checks = state.telegramUi.accountChecks[proof.accountId] || {};
    checks.session = structuredClone(proof.session);
    state.telegramUi.accountChecks[proof.accountId] = checks;
  }

  _mutate(operation, mutator, credentialRecords = []) {
    const work = this.pending.then(async () => {
      const context = { operation, before: await this.list() };
      // Hooks must not hold the SQLite transaction while draining publishers.
      if (this.beforeMutation) await this.beforeMutation(structuredClone(context));
      // Fileless injected stores carry synthetic references, not filesystem
      // credentials. Durable stores may adopt only a private managed cookie.
      if (this.store.file && credentialRecords.length) {
        const current = await this.list();
        const cookies = new CookieStore(path.dirname(this.store.file));
        for (const record of credentialRecords) {
          const existing = current.find(item => item.id === record.id);
          if (record.cookieFile && record.cookieFile !== existing?.cookieFile) {
            await cookies.validateManaged(record.cookieFile);
          }
        }
      }
      const state = await this.store.update(draft => {
        context.before = structuredClone(draft.accounts || []);
        return mutator(draft);
      });
      if (this.onChange) await this.onChange(structuredClone(state.accounts || []), structuredClone(context));
      return state;
    });
    // Resource observers complete before another account mutation can begin.
    this.pending = work.catch(() => {});
    return work;
  }

  async list() {
    const accounts = this.store.section ? await this.store.section('accounts') : (await this.store.load()).accounts;
    return structuredClone(Array.isArray(accounts) ? accounts : []);
  }

  async add(input, { userKey, confirmationToken } = {}) {
    const record = accountRecord(input);
    return this._mutate('add', state => {
      const confirmation = userKey ? state.telegramUi?.users?.[userKey] : null;
      if (userKey && (!confirmation || confirmation.prompt !== 'cookieConfirm' || confirmation.flowToken !== confirmationToken || confirmation.draft?.id !== record.id)) throw new Error('STALE_CONFIRMATION');
      state.accounts ||= [];
      if (confirmation && state.accounts.some(a => a.username?.toLowerCase() === record.username?.toLowerCase())) throw new Error('Account already exists');
      if (state.accounts.some(item => item.id === record.id)) throw new Error('Account already exists');
      if (Number.isFinite(this.maxAccounts) && state.accounts.length >= this.maxAccounts) throw new Error(`At most ${this.maxAccounts} accounts are supported`);
      const activeCount = enabledCount(state.accounts);
      const toInsert = structuredClone(record);
      if (activeCount >= this.maxActiveAccounts) {
        toInsert.enabled = false;
        if (!isCaptchaStatus(toInsert.status) && !isBannedStatus(toInsert.status) && !isUnverifiedStatus(toInsert.status)) {
          toInsert.status = 'غير مفعل';
        }
      }
      toInsert.checkGeneration = randomUUID();
      if (state.telegramUi?.accountChecks) delete state.telegramUi.accountChecks[toInsert.id];
      state.accounts.push(toInsert);
      if (confirmation) Object.assign(confirmation, { draft: null, prompt: null, flowToken: null });
      return state;
    }, [record]).then(state => structuredClone(state.accounts.find(item => item.id === record.id)));
  }

  async update(id, patch = {}) {
    const accountId = normalizeAccountId(id);
    const activationProof = patch.enabled === true ? await this._prepareActivation({ id: accountId }, 'update', patch) : null;
    return this._mutate('update', state => {
      const current = (state.accounts || []).find(item => item.id === accountId);
      if (activationProof) this._applyActivationProof(state, activationProof);
      const activationState = activationProof ? evaluateAccountUse(state, current, { requireOwnerEnabled: false, expectedRevision: current?.checkGeneration }) : null;
      if (!current) throw new Error('Account not found');
      if (activationProof && !activationState.allowed) throw new Error(`ACTIVATION_DENIED:${activationState.reason}`);

      const hasCaptchaRestriction = Boolean(current.needsOwnerCaptcha) || isCaptchaStatus(current.status);
      const hasBanRestriction = isBannedStatus(current.status);
      const hasUnverifiedRestriction = isUnverifiedStatus(current.status);
      const isCurrentlyRestricted = hasCaptchaRestriction || hasBanRestriction || hasUnverifiedRestriction;
      const authorizedClear = isAuthorizedVerificationClear(current, patch);

      const effectivePatch = { ...patch };
      // Unknown/unverified is not a hard restriction. An explicit cookie-backed
      // owner activation must not require a network verification session.
      if (hasUnverifiedRestriction && !hasHardRestriction(current) && patch.enabled === true &&
          evaluateAccountUse(state, current, { requireOwnerEnabled: false }).allowed) {
        effectivePatch.status = 'مفعل';
      }
      if (isCurrentlyRestricted && !authorizedClear && !(hasUnverifiedRestriction && !hasHardRestriction(current) && effectivePatch.status === 'مفعل' && patch.enabled === true)) {
        effectivePatch.enabled = hasUnverifiedRestriction && !hasBanRestriction && !hasCaptchaRestriction ? current.enabled : false;
        effectivePatch.status = current.status;
        if (hasBanRestriction) {
          effectivePatch.status = 'محظور';
          effectivePatch.needsOwnerCaptcha = false;
        } else if (hasCaptchaRestriction) {
          effectivePatch.needsOwnerCaptcha = true;
          if (!isCaptchaStatus(effectivePatch.status)) {
            effectivePatch.status = 'كابتشا (مطلوب حل يدوي)';
          }
        }
      } else {
        if (hasBanRestriction && authorizedClear && !Object.hasOwn(effectivePatch, 'needsOwnerCaptcha')) {
          effectivePatch.needsOwnerCaptcha = false;
        }
        if (Object.hasOwn(effectivePatch, 'enabled') && !Object.hasOwn(effectivePatch, 'status')) {
          effectivePatch.status = effectivePatch.enabled === false ? 'غير مفعل' : 'مفعل';
        }
      }

      const input = { ...current, ...effectivePatch, id: accountId };
      const identityChanged = ['username', 'cookieFile'].some(key => Object.hasOwn(patch, key) && patch[key] !== current[key]);
      if (identityChanged) for (const key of ['userId', 'verifiedAt']) if (!Object.hasOwn(patch, key)) delete input[key];
      const next = accountRecord(input);
      if (next.enabled !== false && current.enabled === false) {
        // Recheck inside the atomic store mutation, not only a preflight load.
        const policy = evaluateAccountUse(state, next, { requireOwnerEnabled: false });
        if (!policy.allowed) throw new Error(`ACTIVATION_DENIED:${policy.reason}`);
        if (enabledCount(state.accounts, accountId) >= this.maxActiveAccounts) throw new Error(`At most ${this.maxActiveAccounts} active accounts are supported`);
      }
      if (next.enabled === true && next.status === 'مفعل' && !Object.hasOwn(patch, 'failures')) {
        next.failures = 0;
      }
      next.checkGeneration = randomUUID();
      if (state.telegramUi?.accountChecks) delete state.telegramUi.accountChecks[accountId];
      state.accounts[state.accounts.indexOf(current)] = next;
      return state;
    }, [{ id: accountId, cookieFile: patch.cookieFile }]).then(state => structuredClone(state.accounts.find(item => item.id === accountId)));
  }

  async remove(id) {
    const accountId = normalizeAccountId(id);
    let removed = false;
    await this._mutate('remove', state => {
      removed = false;
      const before = state.accounts || [];
      state.accounts = before.filter(item => {
        const keep = item.id !== accountId;
        if (!keep) removed = true;
        return keep;
      });
      if (!removed) throw new Error('Account not found');
      if (state.telegramUi?.accountChecks) delete state.telegramUi.accountChecks[accountId];
      return state;
    });
    return removed;
  }

  /** Replace is atomic: malformed input never removes the current account set. */
  async replace(records) {
    if (!Array.isArray(records) || (Number.isFinite(this.maxAccounts) && records.length > this.maxAccounts)) {
      throw new Error(`At most ${this.maxAccounts} accounts are supported`);
    }
    const normalized = records.map(accountRecord);
    if (new Set(normalized.map(item => item.id)).size !== normalized.length) throw new Error('Duplicate account id');

    return this._mutate('replace', state => {
      const existingAccounts = state.accounts || [];
      let activeCount = 0;

      const merged = normalized.map(incoming => {
        const account = structuredClone(incoming);
        const normUser = account.username ? account.username.toLowerCase() : null;
        const normUserId = account.userId != null ? String(account.userId) : null;

        // Match against existing accounts by id, normalized username, and userId
        const matchingExisting = existingAccounts.filter(ex => {
          if (!ex) return false;
          if (ex.id === account.id) return true;
          if (normUser && ex.username && ex.username.replace(/^@/, '').trim().toLowerCase() === normUser) return true;
          if (normUserId && ex.userId != null && String(ex.userId) === normUserId) return true;
          return false;
        });

        const restrictedExisting = matchingExisting.find(ex =>
          hasHardRestriction(ex) || isUnverifiedStatus(ex.status)
        );

        if (restrictedExisting) {
          account.enabled = hasHardRestriction(restrictedExisting) ? false : restrictedExisting.enabled !== false;
          for (const key of RESTRICTION_FLAGS) if (Object.hasOwn(restrictedExisting, key)) account[key] = restrictedExisting[key];
          if (hasHardRestriction(restrictedExisting)) account.status = restrictedExisting.status;
          if (isBannedStatus(restrictedExisting.status)) {
            account.status = 'محظور';
          } else if (restrictedExisting.needsOwnerCaptcha === true || isCaptchaStatus(restrictedExisting.status)) {
            account.status = isCaptchaStatus(restrictedExisting.status)
              ? restrictedExisting.status
              : 'كابتشا (مطلوب حل يدوي)';
            account.needsOwnerCaptcha = true;
            account.captchaIncidentId = restrictedExisting.captchaIncidentId || randomUUID();
            account.captchaDetectedAt = restrictedExisting.captchaDetectedAt ?? Date.now();
            if (restrictedExisting.captchaCode != null) account.captchaCode = restrictedExisting.captchaCode;
            if (restrictedExisting.captchaReason) account.captchaReason = restrictedExisting.captchaReason;
            if (Array.isArray(restrictedExisting.captchaDeliveredChats)) {
              account.captchaDeliveredChats = [...restrictedExisting.captchaDeliveredChats];
            }
            if (restrictedExisting.captchaDeliveredIncidentId) {
              account.captchaDeliveredIncidentId = restrictedExisting.captchaDeliveredIncidentId;
            }
            if (restrictedExisting.lastNotifiedCaptchaIncidentId) {
              account.lastNotifiedCaptchaIncidentId = restrictedExisting.lastNotifiedCaptchaIncidentId;
            }
            if (restrictedExisting.lastCaptchaAlertAt != null) {
              account.lastCaptchaAlertAt = restrictedExisting.lastCaptchaAlertAt;
            }
          } else if (isUnverifiedStatus(restrictedExisting.status)) {
            // CSV replacement must not clear a session-verification restriction.
            account.status = restrictedExisting.status;
            if (restrictedExisting.unverifiedReason != null) account.unverifiedReason = restrictedExisting.unverifiedReason;
          }
        }

        const isActive = account.enabled !== false;
        if (isActive) {
          activeCount++;
          if (activeCount > this.maxActiveAccounts) {
            account.enabled = false;
            account.status = 'غير مفعل';
          }
        }
        account.checkGeneration = randomUUID();
        return account;
      });

      state.accounts = merged;
      if (state.telegramUi) state.telegramUi.accountChecks = {};
      return state;
    }, normalized).then(state => structuredClone(state.accounts));
  }

  async replaceFromCsv(input) {
    let rows;
    try {
      rows = parseCsv(input, { required: ['account'], rejectFormulas: false });
    } catch (err) {
      if (err.message && (err.message.includes('must not be empty') || err.message.includes('at least one row'))) {
        throw new Error('EMPTY_ACCOUNTS_CSV: Refusing to replace accounts with an empty CSV file');
      }
      throw err;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('EMPTY_ACCOUNTS_CSV: Refusing to replace accounts with an empty CSV file');
    }
    return this.replace(rows.map((row, index) => {
      const rawAccount = String(row.account || '').trim();
      const account = rawAccount.replace(/^@/, '');
      if (rawAccount.startsWith('@') && !/^[A-Za-z0-9_]{1,15}$/.test(account)) {
        throw new Error(`CSV row ${index + 2} contains unsafe formula-like value`);
      }
      for (const [key, rawVal] of Object.entries(row)) {
        const val = String(rawVal ?? '');
        if (/^[=+\-]/.test(val)) {
          throw new Error(`CSV row ${index + 2} contains unsafe formula-like value`);
        }
        if (val.startsWith('@')) {
          const stripped = val.replace(/^@/, '');
          if (!['account', 'username', 'handle', 'label'].includes(key) || !/^[A-Za-z0-9_]{1,15}$/.test(stripped)) {
            throw new Error(`CSV row ${index + 2} contains unsafe formula-like value`);
          }
        }
      }
      const username = row.username != null
        ? String(row.username).trim().replace(/^@/, '')
        : (rawAccount.startsWith('@') ? account : undefined);
      return {
        ...row,
        id: account,
        account,
        ...(username !== undefined ? { username } : {}),
        label: (row.label && String(row.label).trim().replace(/^@/, '')) || account,
        cookieFile: row.cookie_file || row.cookieFile || null,
        quota: row.quota || null,
        delayMs: row.delay_ms || row.delayMs || null,
        enabled: row.enabled !== 'false'
      };
    }));
  }

  async resetFailures(id) {
    return resetAccountFailures(this.store, id);
  }

  async incrementFailures(id) {
    return incrementAccountFailures(this.store, id);
  }
}

function assertNoSymlinkedAncestors(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const parts = resolved.split(path.sep);
  let current = path.sep;
  for (const part of parts) {
    if (!part) continue;
    current = path.join(current, part);
    if (fsSync.existsSync(current)) {
      let stat;
      try {
        stat = fsSync.lstatSync(current);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isSymbolicLink()) {
        throw Object.assign(
          new Error(`COOKIE_DIR_SYMLINK_FORBIDDEN: Path component is a symbolic link: ${current}`),
          { code: 'COOKIE_DIR_SYMLINK_FORBIDDEN' }
        );
      }
    }
  }
  if (fsSync.existsSync(resolved)) {
    const real = fsSync.realpathSync(resolved);
    if (real !== resolved) {
      throw Object.assign(
        new Error(`COOKIE_DIR_SYMLINK_FORBIDDEN: Canonical realpath mismatch for ${resolved}`),
        { code: 'COOKIE_DIR_SYMLINK_FORBIDDEN' }
      );
    }
  }
}

class CookieStore {
  constructor(dataDir) {
    if (!dataDir) throw new TypeError('CookieStore requires a data path');
    this.directory = path.resolve(dataDir, 'cookies');
    assertNoSymlinkedAncestors(this.directory);
  }

  async validateManaged(file) {
    const resolved = path.resolve(String(file || ''));
    if (!path.isAbsolute(String(file || '')) || path.dirname(resolved) !== this.directory ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.cookies$/.test(path.basename(resolved))) {
      throw Object.assign(new Error('Cookie credential must be inside the managed CookieStore'), { code: 'COOKIE_PATH_UNMANAGED' });
    }
    assertNoSymlinkedAncestors(resolved);
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) {
      throw Object.assign(new Error('Managed cookie directory must be private and service-owned'), { code: 'COOKIE_FILE_NOT_PRIVATE' });
    }
    await validateCookieFile(resolved, { privateFile: true });
    return resolved;
  }

  async store(accountId, sourceFile) {
    const source = path.resolve(String(sourceFile || ''));
    const validation = await validateCookieFile(source);
    return this._storeValidated(accountId, validation);
  }

  async storeContent(accountId, content) {
    const validation = validateCookieContent(content);
    return this._storeValidated(accountId, validation);
  }

  async _storeValidated(accountId, validation) {
    const id = normalizeAccountId(accountId);
    assertNoSymlinkedAncestors(this.directory);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    assertNoSymlinkedAncestors(this.directory);
    const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const destination = path.join(this.directory, `${id}.cookies`);
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      await directory.chmod(0o700);
      let handle, created = false;
      try {
        handle = await fs.open(temp, 'wx', 0o600); created = true;
        await handle.writeFile(validation.content, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temp, destination); created = false;
        await directory.sync();
      } finally {
        try { if (handle) await handle.close(); }
        finally {
          if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      // Return metadata only. Never return or log cookie contents.
      return { path: destination, bytes: Buffer.byteLength(validation.content), format: validation.format };
    } finally { await directory.close(); }
  }
}

async function validateCookieFile(file, { privateFile = false } = {}) {
  const resolved = path.resolve(String(file || ''));
  assertNoSymlinkedAncestors(path.dirname(resolved));
  let handle;
  try { handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw new Error(`Cookie file is not readable: ${error.code || 'error'}`); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Cookie file must be a regular file');
    if (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.nlink !== 1)) {
      throw Object.assign(new Error('Managed cookie must be a private service-owned file without hardlinks'), { code: 'COOKIE_FILE_NOT_PRIVATE' });
    }
    if (stat.size === 0) throw new Error('Cookie file size is invalid');
    if (stat.size > MAX_COOKIE_FILE_BYTES) {
      throw Object.assign(new Error('COOKIE_FILE_TOO_LARGE: Cookie file size is invalid (exceeds 1 MiB)'), { code: 'COOKIE_FILE_TOO_LARGE' });
    }
    // One extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size || (await handle.stat()).size !== stat.size) throw new Error('Cookie file changed during validation');
    return validateCookieContent(buffer.subarray(0, total).toString('utf8'));
  } finally { await handle.close(); }
}

function validateCookieContent(content) {
  const text = String(content ?? '');
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen > MAX_COOKIE_FILE_BYTES) {
    throw Object.assign(new Error('COOKIE_FILE_TOO_LARGE: Cookie file content is invalid (exceeds 1 MiB)'), { code: 'COOKIE_FILE_TOO_LARGE' });
  }
  if (!text.trim() || text.includes('\u0000')) throw new Error('Cookie file content is invalid');
  const parsed = parseCookies(text);
  if (!parsed.cookies.length) throw new Error('Cookie file contains no usable cookies');
  return { content: text, format: parsed.format };
}

async function resetAccountFailures(store, accountId) {
  const id = normalizeAccountId(accountId);
  return store.update(state => {
    const acc = (state.accounts || []).find(item => item.id === id);
    if (acc) {
      acc.failures = 0;
    }
    return state;
  });
}

async function incrementAccountFailures(store, accountId) {
  const id = normalizeAccountId(accountId);
  let failures = 0;
  let isolated = false;
  await store.update(state => {
    failures = 0;
    isolated = false;
    const acc = (state.accounts || []).find(item => item.id === id);
    if (acc) {
      acc.failures = (acc.failures || 0) + 1;
      failures = acc.failures;
      if (acc.failures >= 3) {
        acc.enabled = false;
        if (!acc.needsOwnerCaptcha && !isCaptchaStatus(acc.status) && !isBannedStatus(acc.status)) {
          acc.status = 'معزول (3 إخفاقات)';
        }
        acc.checkGeneration = randomUUID();
        isolated = true;
      }
    }
    return state;
  });
  return { failures, isolated };
}

module.exports = {
  AccountManager,
  evaluateAccountUse,
  applyOwnerEnabled,
  CookieStore,
  validateCookieFile,
  validateCookieContent,
  detectCookieFormat: detectFormat,
  normalizeAccountId,
  accountRecord,
  resetAccountFailures,
  incrementAccountFailures,
  isCaptchaStatus,
  isBannedStatus,
  isUnverifiedStatus,
  isAccountInactive,
  MAX_ACCOUNTS,
  MAX_ACTIVE_ACCOUNTS,
  MAX_COOKIE_FILE_BYTES,
  MAX_COOKIE_BYTES
};
