/**
 * 🔄 Config Migrator — backfills new config fields on old installs.
 * ================================================================
 * Idempotent. migrateConfig() adds `referral_enabled: true` to any
 * existing config.json that predates the referral-toggle feature.
 * Returns { migrated: bool, ... } — false when nothing changed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function configFile() {
  return path.join(os.homedir(), '.config', 'x-poster-bot-profile', 'config.json');
}

function migrateConfig() {
  const file = configFile();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No config yet → nothing to migrate
    return { migrated: false, reason: 'NO_CONFIG' };
  }

  let changed = false;
  const added = [];

  if (typeof cfg.referral_enabled !== 'boolean') {
    cfg.referral_enabled = true;
    added.push('referral_enabled');
    changed = true;
  }
  if (typeof cfg.referral_link !== 'string') {
    cfg.referral_link = '';
    added.push('referral_link');
    changed = true;
  }

  if (!changed) {
    return { migrated: false, reason: 'ALREADY_MIGRATED' };
  }

  try {
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    return { migrated: false, reason: 'WRITE_FAILED', error: e.message };
  }

  return { migrated: true, added };
}

module.exports = { migrateConfig };
