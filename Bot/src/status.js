'use strict';

async function projectStatus({ cycle, queue, account, vpn, vpnSlots, lock, health } = {}) {
  const cycleState = cycle ? await cycle.get() : { state: 'stopped' };
  const state = queue?.store ? await queue.store.load() : {};
  const counts = (state.items || []).reduce((result, item) => {
    const key = item.state || 'unknown';
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  let vpnHealth;
  let vpnAccounts;
  if (vpnSlots) {
    const accounts = (state.accounts || []).filter(entry => entry.enabled !== false && (!account || entry.id === account));
    vpnAccounts = await Promise.all(accounts.map(async entry => {
      let result;
      try { result = await vpnSlots.health(entry.id); }
      catch { result = { healthy: false, reason: 'health_check_failed' }; }
      return { accountId: entry.id, slot: state.vpnSlots?.[entry.id] ?? null,
        healthy: result?.healthy === true, active: result?.active === true || result?.healthy === true,
        lastError: result?.lastError || result?.reason || null };
    }));
    vpnHealth = { healthy: vpnAccounts.length > 0 && vpnAccounts.every(entry => entry.healthy),
      active: vpnAccounts.some(entry => entry.active), account: account || null, reconnects: 0,
      lastError: vpnAccounts.find(entry => !entry.healthy)?.lastError || null };
  } else {
    vpnHealth = vpn?.health ? await vpn.health() : { active: false, healthy: false, account: null, reconnects: 0, lastError: null };
  }
  const operational = {
    lockHeld: Boolean(lock?.locked),
    vpnHealthy: Boolean(vpnHealth.healthy),
    vpnAccount: vpnHealth.account || null,
    reconnects: vpnHealth.reconnects || 0,
    lastError: vpnHealth.lastError || null,
    ...(vpnAccounts ? { vpnAccounts } : {}),
    ...(health || {})
  };
  return {
    cycleState: cycleState.state,
    runId: cycleState.runId || null,
    account: account || null,
    queueLength: counts.pending || 0,
    counts: {
      pending: counts.pending || 0,
      processing: counts.processing || 0,
      failed: counts.failed || 0,
      ambiguous: counts.ambiguous || 0,
      done: counts.done || 0,
      published: counts.published || 0,
      successful: (counts.published || 0) + (counts.done || 0)
    },
    vpnActive: vpnSlots ? Boolean(vpnHealth.active) : Boolean(vpn?.isActive?.(account)),
    operational,
    generatedAt: new Date().toISOString()
  };
}
module.exports = { projectStatus };
