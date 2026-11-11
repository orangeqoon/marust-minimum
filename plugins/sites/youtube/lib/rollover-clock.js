'use strict';

/** Pure YouTube枠時計。OBS全体経過やプロセス起動時刻は使わない。 */

const DEFAULT_THRESHOLD_SEC = 42600;
const MIN_THRESHOLD_SEC = 600;
const MAX_THRESHOLD_SEC = 43200;
const SOURCES = Object.freeze({ ACTUAL: 'youtube-actual', LOCAL: 'local-live', TARGET: 'target-connected' });

function number(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function threshold(value, fallback) {
  const n = number(value);
  if (Number.isInteger(n) && n >= MIN_THRESHOLD_SEC && n <= MAX_THRESHOLD_SEC) return n;
  const f = number(fallback);
  return Number.isInteger(f) && f >= MIN_THRESHOLD_SEC && f <= MAX_THRESHOLD_SEC ? f : DEFAULT_THRESHOLD_SEC;
}

function validStartMs(value, nowMs) {
  const n = number(value);
  const now = number(nowMs);
  return Number.isInteger(n) && n > 0 && n <= now;
}

function deadlineAt(startedAtMs, thresholdSec) {
  if (!Number.isInteger(startedAtMs) || startedAtMs <= 0) return 0;
  const deadline = startedAtMs + threshold(thresholdSec) * 1000;
  return Number.isSafeInteger(deadline) ? deadline : 0;
}

function remainingSec(deadlineAtMs, nowMs) {
  const deadline = number(deadlineAtMs);
  const now = number(nowMs);
  if (!(deadline > 0) || !Number.isFinite(now)) return null;
  return Math.ceil((deadline - now) / 1000);
}

function chooseStart(input, nowMs) {
  const src = input || {};
  const now = number(nowMs);
  const errors = [];
  const candidates = [
    { value: src.actualStartMs, source: SOURCES.ACTUAL },
    { value: src.savedStartMs, source: src.savedSource || SOURCES.LOCAL },
    { value: src.targetConnectedAt, source: SOURCES.TARGET }
  ];
  for (const candidate of candidates) {
    if (candidate.value == null || candidate.value === '' || Number(candidate.value) === 0) continue;
    if (!validStartMs(candidate.value, now)) {
      errors.push(number(candidate.value) > now ? 'future-start' : 'invalid-start');
      continue;
    }
    if (!Object.values(SOURCES).includes(candidate.source)) {
      errors.push('invalid-source');
      continue;
    }
    return { ok: true, startedAtMs: Number(candidate.value), source: candidate.source, error: errors[0] || '' };
  }
  return { ok: false, startedAtMs: 0, source: '', error: errors[0] || 'start-time-unknown' };
}

function buildClock(input) {
  const src = input || {};
  const now = number(src.nowMs == null ? src.now : src.nowMs);
  const sec = threshold(src.thresholdSec, src.defaultThresholdSec);
  const selected = src.startedAtMs > 0
    ? chooseStart({ savedStartMs: src.startedAtMs, savedSource: src.source }, now)
    : chooseStart(src, now);
  if (!selected.ok) return { ok: false, startedAtMs: 0, source: '', thresholdSec: sec, deadlineAtMs: 0, remainingSec: null, elapsedSec: 0, due: false, error: selected.error };
  const deadline = deadlineAt(selected.startedAtMs, sec);
  if (!deadline) return { ok: false, startedAtMs: 0, source: '', thresholdSec: sec, deadlineAtMs: 0, remainingSec: null, elapsedSec: 0, due: false, error: 'invalid-deadline' };
  const elapsed = Math.max(0, (now - selected.startedAtMs) / 1000);
  return { ok: true, startedAtMs: selected.startedAtMs, source: selected.source, thresholdSec: sec, deadlineAtMs: deadline, remainingSec: remainingSec(deadline, now), elapsedSec: elapsed, due: now >= deadline, error: selected.error || '' };
}

function clockFromState(state, nowMs, defaultThresholdSec) {
  const src = state || {};
  return buildClock({ nowMs, startedAtMs: src.startedAtMs, source: src.source, thresholdSec: src.thresholdSec, defaultThresholdSec });
}

module.exports = { DEFAULT_THRESHOLD_SEC, MIN_THRESHOLD_SEC, MAX_THRESHOLD_SEC, SOURCES, threshold, validStartMs, deadlineAt, remainingSec, chooseStart, buildClock, clockFromState };
