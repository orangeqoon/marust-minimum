'use strict';

/**
 * 開発時だけ使う性能の基準値計測。
 * 既定では無効で、秘密・引数・返り値は記録しない。
 */
function createPerformanceMetrics(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const enabled = opts.enabled === true;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs >= 1000 ? opts.intervalMs : 10000;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cpuUsage = typeof opts.cpuUsage === 'function' ? opts.cpuUsage : process.cpuUsage.bind(process);
  const memoryUsage = typeof opts.memoryUsage === 'function' ? opts.memoryUsage : process.memoryUsage.bind(process);
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const calls = Object.create(null);
  let previousCpu = null;
  let previousAt = null;
  let timer = null;

  function begin(method) {
    if (!enabled) return null;
    return { method: String(method || ''), startedAt: now() };
  }

  function end(token) {
    if (!enabled || !token) return;
    const elapsedMs = Math.max(0, now() - token.startedAt);
    const row = calls[token.method] || (calls[token.method] = { count: 0, totalMs: 0, maxMs: 0 });
    row.count += 1;
    row.totalMs += elapsedMs;
    if (elapsedMs > row.maxMs) row.maxMs = elapsedMs;
  }

  function snapshot(at) {
    if (!enabled) return null;
    const stamp = at == null ? now() : at;
    const cpu = cpuUsage();
    const memory = memoryUsage();
    const elapsedMs = previousAt == null ? null : Math.max(1, stamp - previousAt);
    const cpuMs = previousCpu == null ? null : Math.round((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000);
    const out = {
      at: new Date(stamp).toISOString(),
      intervalMs: elapsedMs,
      cpuMs: cpuMs,
      cpuPercent: cpuMs == null || elapsedMs == null ? null : Math.round(cpuMs / elapsedMs * 1000) / 10,
      memory: {
        rss: Number(memory.rss) || 0,
        heapUsed: Number(memory.heapUsed) || 0,
        heapTotal: Number(memory.heapTotal) || 0,
        external: Number(memory.external) || 0,
        arrayBuffers: Number(memory.arrayBuffers) || 0
      },
      api: Object.keys(calls).sort().reduce(function (all, method) {
        const row = calls[method];
        all[method] = { count: row.count, totalMs: row.totalMs, maxMs: row.maxMs };
        return all;
      }, {})
    };
    previousCpu = cpu;
    previousAt = stamp;
    Object.keys(calls).forEach(function (method) { delete calls[method]; });
    return out;
  }

  function sample() {
    const out = snapshot();
    if (out) log('[marust][perf] ' + JSON.stringify(out));
    return out;
  }

  function start() {
    if (!enabled || timer) return false;
    previousCpu = cpuUsage();
    previousAt = now();
    timer = setInterval(sample, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return { enabled, begin, end, snapshot, sample, start, stop };
}

module.exports = { createPerformanceMetrics };
