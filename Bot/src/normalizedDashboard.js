'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class NormalizedDashboardReader {
  constructor(file, { clock = () => Date.now(), timeoutMs = 900, workerPath = path.join(__dirname, 'normalizedDashboardWorker.js') } = {}) {
    this.file = path.resolve(file);
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.worker = new Worker(workerPath, { workerData: { file: this.file } });
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.worker.on('message', message => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
      else request.resolve(message.snapshot);
    });
    this.worker.on('error', error => this._failAll(error));
    this.worker.on('exit', code => { if (!this.closed && code !== 0) this._failAll(new Error(`NORMALIZED_DASHBOARD_WORKER_EXIT_${code}`)); });
  }
  _failAll(error) {
    for (const [id, request] of this.pending) { clearTimeout(request.timer); request.reject(error); this.pending.delete(id); }
  }
  read(day = null) {
    if (this.closed) return Promise.reject(new Error('NORMALIZED_DASHBOARD_READER_CLOSED'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('NORMALIZED_DASHBOARD_READ_TIMEOUT'), { code: 'NORMALIZED_DASHBOARD_READ_TIMEOUT' }));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'read', id, day });
    });
  }
  close() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this._failAll(new Error('NORMALIZED_DASHBOARD_READER_CLOSED'));
    this.worker.postMessage({ type: 'close' });
    return this.worker.terminate();
  }
}

class DashboardDeliveryLoop {
  constructor({ reader, ui, intervalMs = 1000, clock = () => Date.now() } = {}) {
    if (!reader || !ui) throw new TypeError('DASHBOARD_READER_AND_UI_REQUIRED');
    this.reader = reader;
    this.ui = ui;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.timer = null;
    this.running = false;
    this.tickInFlight = null;
    this.generation = 0;
    this.latest = null;
    this.deliveryInFlight = null;
  }
  start() {
    if (this.timer) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  async tick() {
    if (!this.running || this.tickInFlight) return this.tickInFlight;
    const generation = ++this.generation;
    const work = this.reader.read().then(snapshot => {
      if (!this.running || generation !== this.generation) return;
      this.latest = { snapshot, generation };
      this._deliverLatest();
    }).catch(error => this.ui._logWarn?.('normalized_dashboard_tick_failed', 'normalizedDashboard', error));
    this.tickInFlight = work;
    try { return await work; } finally { if (this.tickInFlight === work) this.tickInFlight = null; }
  }
  _deliverLatest() {
    if (this.deliveryInFlight || !this.running || !this.latest) return;
    const work = Promise.resolve().then(async () => {
      while (this.running && this.latest) {
        const { snapshot, generation } = this.latest;
        this.latest = null;
        try { await this.ui.applyNormalizedDashboardSnapshot(snapshot, { generation, fromLoop: true, polling: true }); }
        catch (error) { this.ui._logWarn?.('normalized_dashboard_delivery_failed', 'normalizedDashboard', error); }
      }
    });
    this.deliveryInFlight = work;
    void work.finally(() => {
      if (this.deliveryInFlight === work) this.deliveryInFlight = null;
      this._deliverLatest();
    });
  }
  async stop() {
    this.running = false;
    this.generation++;
    this.latest = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.tickInFlight;
    await this.deliveryInFlight;
  }
}

module.exports = { NormalizedDashboardReader, DashboardDeliveryLoop };
