'use strict';

/**
 * Shared token-bucket speed limiter. wait(n) resolves once n bytes may be processed.
 * bytesPerSec = 0 means unlimited.
 */
class SpeedLimiter {
  constructor(bytesPerSec = 0) {
    this.setLimit(bytesPerSec);
  }

  setLimit(bytesPerSec) {
    this.limit = Math.max(0, Number(bytesPerSec) || 0);
    this.available = this.limit; // allow a one-second burst
    this.last = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.available = Math.min(this.limit, this.available + elapsed * this.limit);
  }

  async wait(n) {
    if (!this.limit) { return; }
    // Re-check in a loop so setLimit() takes effect for sleepers too.
    for (;;) {
      if (!this.limit) { return; }
      this._refill();
      if (this.available >= n || this.available >= this.limit) {
        this.available -= n; // may go negative for chunks larger than one second of budget
        return;
      }
      const need = Math.min(n, this.limit) - this.available;
      const ms = Math.max(5, Math.ceil((need / this.limit) * 1000));
      await new Promise((r) => setTimeout(r, Math.min(ms, 250)));
    }
  }
}

/**
 * A download's own limiter: applies the per-file limit (read live from `getKB()`, 0 = none) and then the shared one,
 * so a file never exceeds its own cap and all files together never exceed the global cap.
 */
class TaskLimiter {
  constructor(shared, getKB) {
    this.shared = shared;
    this.getKB = getKB;
    this.own = new SpeedLimiter(0);
  }

  async wait(n) {
    const bps = Math.max(0, Number(this.getKB()) || 0) * 1024;
    if (bps !== this.own.limit) { this.own.setLimit(bps); }
    if (bps) { await this.own.wait(n); }
    await this.shared.wait(n);
  }
}

/** Moving-window speed meter (bytes/second over the last `windowMs`). */
class SpeedMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  add(bytes) {
    const now = Date.now();
    this.samples.push([now, bytes]);
    this._trim(now);
  }

  _trim(now) {
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0][0] < cutoff) { this.samples.shift(); }
  }

  get speed() {
    const now = Date.now();
    this._trim(now);
    if (!this.samples.length) { return 0; }
    let total = 0;
    for (const [, b] of this.samples) { total += b; }
    const span = Math.max(500, now - this.samples[0][0]);
    return (total / span) * 1000;
  }

  reset() { this.samples = []; }
}

module.exports = { SpeedLimiter, SpeedMeter, TaskLimiter };
