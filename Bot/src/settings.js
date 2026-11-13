'use strict';

const VALID_PUBLISH_MODES = Object.freeze(['direct_x', 'owner_assisted', 'dry_run']);
const DEFAULT_SETTINGS = Object.freeze({ delayMs: 0, delayMinSeconds: 15, delayMaxSeconds: 30, dailyQuota: null, publishMode: 'direct_x', schedule: { enabled: false, hour: 9, minute: 0 } });

function normalizePublishMode(value, fallback = 'direct_x') {
  if (value === undefined || value === null || value === '') return fallback;
  const mode = String(value).trim().toLowerCase();
  if (!VALID_PUBLISH_MODES.includes(mode)) {
    throw new Error(`publishMode must be one of: ${VALID_PUBLISH_MODES.join(', ')}`);
  }
  return mode;
}

function normalizeSettings(settings = {}) {
  const base = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const publishMode = VALID_PUBLISH_MODES.includes(base.publishMode) ? base.publishMode : 'direct_x';
  return {
    ...base,
    ...normalizedRange(settings),
    publishMode,
    schedule: normalizeSchedule(settings?.schedule)
  };
}

function parseDuration(value) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(value)) throw new Error('Duration must be M:S');
  const [minutes, seconds] = value.split(':').map(Number);
  if (minutes > 60 || seconds > 59 || (minutes === 60 && seconds !== 0)) throw new RangeError('Duration must be between 0:00 and 60:00');
  return minutes * 60 + seconds;
}

function formatDuration(value) {
  const seconds = integer(value, 'duration', { max: 3600 });
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function normalizedRange(settings = {}) {
  const legacy = settings.delayMs === undefined ? null : Math.min(3600, Math.max(0, Math.ceil((Number(settings.delayMs) || 0) / 1000)));
  const min = integer(settings.delayMinSeconds ?? legacy ?? 15, 'delayMinSeconds', { max: 3600 });
  const max = integer(settings.delayMaxSeconds ?? legacy ?? 30, 'delayMaxSeconds', { max: 3600 });
  if (max < min) throw new RangeError('delayMaxSeconds must be greater than or equal to delayMinSeconds');
  return { delayMinSeconds: min, delayMaxSeconds: max };
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return number;
}

function normalizeSchedule(schedule = {}) {
  return {
    enabled: schedule.enabled === true,
    hour: integer(schedule.hour ?? 9, 'schedule hour', { min: 0, max: 23 }),
    minute: integer(schedule.minute ?? 0, 'schedule minute', { min: 0, max: 59 })
  };
}

class SettingsManager {
  constructor(store, { onChange } = {}) {
    if (!store) throw new TypeError('SettingsManager requires a store');
    this.store = store;
    this.onChange = typeof onChange === 'function' ? onChange : null;
  }

  async get() {
    return normalizeSettings(this.store.section ? await this.store.section('settings') : (await this.store.load()).settings);
  }

  async update(patch = {}) {
    return this.store.update(state => {
      const current = normalizeSettings(state.settings);
      const legacyMs = patch.delayMs === undefined ? current.delayMs : integer(patch.delayMs, 'delayMs', { max: 3600000 });
      const legacySeconds = patch.delayMs === undefined ? null : Math.ceil(legacyMs / 1000);
      const range = normalizedRange({
        delayMinSeconds: patch.delayMinSeconds ?? legacySeconds ?? current.delayMinSeconds,
        delayMaxSeconds: patch.delayMaxSeconds ?? legacySeconds ?? current.delayMaxSeconds
      });
      const publishMode = patch.publishMode === undefined || patch.publishMode === null || patch.publishMode === ''
        ? current.publishMode
        : normalizePublishMode(patch.publishMode, current.publishMode);
      state.settings = {
        delayMs: legacyMs,
        ...range,
        dailyQuota: patch.dailyQuota === undefined || patch.dailyQuota === null || patch.dailyQuota === '' ? current.dailyQuota : integer(patch.dailyQuota, 'dailyQuota', { min: 1 }),
        publishMode,
        scheduleRevision: patch.schedule ? require('node:crypto').randomUUID() : (current.scheduleRevision || 0),
        schedule: normalizeSchedule({ ...current.schedule, ...(patch.schedule || {}) })
      };
      return state;
    }).then(async state => {
      if (this.onChange) await this.onChange(structuredClone(state.settings));
      return structuredClone(state.settings);
    });
  }

  async updateSettings(patch = {}) { return this.update(patch); }
  async setPublishMode(publishMode) { return this.update({ publishMode }); }
  async setDelay(value) { return this.update({ delayMs: value }); }
  async setDelayRange({ minSeconds, maxSeconds }) {
    if (minSeconds === undefined || maxSeconds === undefined || minSeconds === null || maxSeconds === null) throw new Error('Both delay bounds are required');
    return this.update({ delayMinSeconds: minSeconds, delayMaxSeconds: maxSeconds });
  }
  async setQuota(value) { return this.update({ dailyQuota: value }); }
  async setSchedule(schedule) { return this.update({ schedule }); }
}

function formatReport({ status, accounts = [], settings } = {}) {
  const lines = [
    'تقرير التشغيل',
    `الدورة: ${{ running: 'تعمل', stopping: 'جارٍ الإيقاف', stopped: 'متوقفة', failed: 'تعذّر التشغيل' }[status?.cycleState] || 'متوقفة'}`,
    `الطابور: ${status?.queueLength ?? 0}`,
    `ناجحة: ${status?.counts?.successful ?? ((status?.counts?.published ?? 0) + (status?.counts?.done ?? 0))}`,
    `فاشلة: ${status?.counts?.failed ?? 0}`,
    `الحسابات: ${accounts.length}`,
    ...(status?.operational?.vpnAccounts ? [`VPN: ${status.operational.vpnAccounts.filter(entry => entry.healthy).length}/${status.operational.vpnAccounts.length} اتصالات سليمة`] : []),
    `التأخير: ${formatDuration(settings?.delayMinSeconds ?? 15)} – ${formatDuration(settings?.delayMaxSeconds ?? 30)} (الحد الآمن الفعلي 0:15)`,
    `الحصة اليومية: ${settings?.dailyQuota ?? 'غير محددة'}`,
    `الجدولة: ${settings?.schedule?.enabled ? `${settings.schedule.hour}:${String(settings.schedule.minute).padStart(2, '0')}` : 'متوقفة'}`
  ];
  return lines.join('\n');
}

module.exports = { SettingsManager, DEFAULT_SETTINGS, VALID_PUBLISH_MODES, normalizePublishMode, normalizeSettings, normalizeSchedule, normalizedRange, parseDuration, formatDuration, formatReport };
