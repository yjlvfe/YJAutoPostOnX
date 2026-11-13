'use strict';
// Derived, process-local UI only. Business decisions always use the store.
const { normalizeSettings } = require('./settings');
const {formatAccountTable}=require('./accountTable');
class FastNavigation {
  constructor(ui, state) {
    this.ui = ui;
    this.users = structuredClone(state.telegramUi?.users || {});
    this.interfacePanelsByChatId = structuredClone(state.telegramUi?.interfacePanelsByChatId || {});
    for (const [chat, panel] of Object.entries(state.telegramUi?.activePanelsByChatId || state.telegramUi?.dashboards || {})) {
      this.interfacePanelsByChatId[chat] ||= {};
      this.interfacePanelsByChatId[chat].dashboard ||= structuredClone(panel);
    }
    this.panels = Object.fromEntries(Object.entries(this.interfacePanelsByChatId).filter(([, p]) => p.dashboard).map(([chat, p]) => [chat, p.dashboard]));
    this.pending = new Map();
    this.panelPatches = new Map();
    this.settings = normalizeSettings(state.settings);
    this.snapshot = state;
    this.generation = 0;
    this.validUntil = 0;
    this.dirty = false;
    this.closed = false;
    this._supersededRefreshCount = 0;
    this._coalesceScheduled = false;
  }
  scheduleCoalescedRefresh() {
    if (this.closed || this.ui?.destroyed || !this.dirty || this._coalesceScheduled) return;
    if ((this._supersededRefreshCount || 0) >= 5) return;
    this._supersededRefreshCount = (this._supersededRefreshCount || 0) + 1;
    this._coalesceScheduled = true;
    queueMicrotask(() => {
      this._coalesceScheduled = false;
      if (!this.closed && !this.ui?.destroyed && this.dirty) {
        void this.refresh();
      }
    });
  }
  user(key) { return this.users[key] || {}; }
  patch(id, patch) {
    const { panel: _panel, ...navigation } = patch;
    patch = navigation;
    this.users[id.key] = { ...this.user(id.key), chatId: id.chat, userId: id.user, ...patch };
    this.pending.set(id.key, { ...this.pending.get(id.key), chatId: id.chat, userId: id.user, ...patch });
  }
  mergeUi(state, ownerRevision = this.ownerRevision || 0) {
    if (!state) return;
    if (state.settings !== undefined) {
      this.settings = normalizeSettings(state.settings);
    }
    if (state.telegramUi === undefined) return;
    this.users = { ...(state.telegramUi?.users || {}) };
    for (const [key, patch] of this.pending) this.users[key] = { ...this.users[key], ...patch };
    if (ownerRevision !== (this.ownerRevision || 0)) {
      for (const [key, user] of Object.entries(this.users)) {
        const panel = this.interfacePanelsByChatId[String(user.chatId)]?.dashboard;
        if (panel) this.users[key] = { ...user, panel };
      }
      return;
    }
    this.interfacePanelsByChatId = structuredClone(state.telegramUi?.interfacePanelsByChatId || {});
    for (const [chat, panel] of Object.entries(state.telegramUi?.activePanelsByChatId || state.telegramUi?.dashboards || {})) {
      this.interfacePanelsByChatId[chat] ||= {};
      this.interfacePanelsByChatId[chat].dashboard ||= structuredClone(panel);
    }
    this.panels = Object.fromEntries(Object.entries(this.interfacePanelsByChatId).filter(([, p]) => p.dashboard).map(([chat, p]) => [chat, p.dashboard]));
  }
  observe(state) {
    if (this.closed) return;
    this.generation++;
    this.validUntil = 0;
    this.dirty = true;
    this.eventBuild = true;
    if (state) this.mergeUi(state);
    // PostgreSQL has its own small, committed projection sampler. A canonical
    // write must never enqueue a full 50k-item render behind that projection.
    if (this.ui.normalizedDashboardReader) {
      if (state?.cycle !== undefined) {
        this.snapshot = { ...(this.snapshot || {}), cycle: structuredClone(state.cycle) };
        this.ui?.evaluateDashboardPolling?.();
      }
      return;
    }
    if (!state) { this.refresh(); return; }
    this.nextBuild = { state, generation: this.generation };
    if (this.buildTimer) return;
    this.buildTimer = setTimeout(() => {
      this.buildTimer = null;
      const next = this.nextBuild;
      this.nextBuild = null;
      if (!this.closed) void this.build(next.state, next.generation);
    }, 200);
  }
  async build(state, generation = this.generation) {
    if (generation !== this.generation || this.closed) return;
    const projectionVersion = this.projectionVersion || 0;
    try {
      let panelView;
      const html = await this.ui.render(state,{onView:view=>{panelView=view;}});
      const accountsHtml=formatAccountTable(state,{now:this.ui.clock(),all:true,refreshingIds:this.ui.accountRefreshJob?.pending,mode:'rich'});
      const accountIds=(state.accounts||[]).map(account=>account.id);
      if (generation !== this.generation || this.closed || projectionVersion !== (this.projectionVersion || 0)) {
        if (generation !== this.generation && this.dirty && !this.closed && !this.ui?.destroyed) {
          this.scheduleCoalescedRefresh();
        }
        return;
      }
      this.html = html;this.panelView=panelView;
      this.accountsHtml=accountsHtml;
      this.accountIds=accountIds;
      this.snapshot = {cycle:state.cycle};
      this.validUntil = Date.now() + (this.ui.normalizedDashboardIntervalMs || 1000);
      this.dirty = false;
      this._supersededRefreshCount = 0;
      this.ui.syncPanelClock();
      // Coalesced canonical mutation, not a periodic Telegram redraw.
      if (this.eventBuild || this.ui.hasPendingPanelDelivery?.()) this.ui.refreshPanels(true).catch(error=>this.ui._logWarn('panel_event_refresh_failed','event',error));
      this.eventBuild = false;
    } catch (error) { this.ui._logWarn('navigation_cache_build_failed', 'cache', error); }
  }
  refresh() {
    if (this.refreshTask || this.closed) return this.refreshTask;
    let generation, ownerRevision, superseded = false;
    this.refreshTask = require('./telegram').navigationContext.run(null,()=>Promise.resolve()
      .then(() => {
        generation = this.generation;
        ownerRevision = this.ownerRevision || 0;
        return this.ui.normalizedDashboardReader ? this.ui.readDashboardSnapshot() : this.ui.bot.store.load();
      })
      .then(state => {
        if (generation !== this.generation) { superseded = true; return; }
        if (this.ui.normalizedDashboardReader) return this.ui.applyNormalizedDashboardSnapshot(state);
        this.mergeUi(state, ownerRevision);
        return this.build(state, generation);
      })
      .catch(error => this.ui._logWarn('navigation_cache_refresh_failed', 'cache', error))
      .finally(() => {
        this.refreshTask = null;
        if (superseded && this.dirty && !this.closed && !this.ui?.destroyed) {
          this.scheduleCoalescedRefresh();
        }
      }));
    return this.refreshTask;
  }
  // Joins the canonical progress transaction, never writes per static click.
  async persist(repo) {
    if (!this.pending.size && !this.panelPatches.size) return;
    const saved = { users: new Map(this.pending), panels: new Map(this.panelPatches) };
    const state=await repo.header(),root=state.telegramUi ||= {};
    root.users ||= {};
    for (const [key, patch] of saved.users) {
      const { panel: _panel, ...navigation } = patch;
      root.users[key] = { ...root.users[key], ...navigation };
    }
    await repo.saveHeader(state);
    return saved;
  }
  committed(saved) {
    for (const [key, patch] of saved?.users || []) if (this.pending.get(key) === patch) this.pending.delete(key);
    for (const [key, panel] of saved?.panels || []) if (this.panelPatches.get(key) === panel) this.panelPatches.delete(key);
  }
  async flush() {
    if (!this.pending.size && !this.panelPatches.size) return;
    if (typeof this.ui.bot.store.flushUiNavigation === 'function') {
      const saved = { users: new Map(this.pending), panels: new Map(this.panelPatches) };
      await this.ui.bot.store.flushUiNavigation(saved);
      this.committed(saved);
      return;
    }
    const saved = await this.ui.bot.store.importTransaction(db => this.persist(db), { uiOnly: true });
    this.committed(saved);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.buildTimer);
    await this.refreshTask;
    await this.flush();
    this.unsubscribe?.();
  }
}
module.exports = { FastNavigation };
