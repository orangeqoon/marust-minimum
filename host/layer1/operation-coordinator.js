'use strict';

// Registry-owned locks survive context replacement. Retiring a lease revokes new
// requests, but only settlement of the task releases its plugin's lock.
function createOperationCoordinator() {
  const plugins = new Map();

  function createLease(pluginId) {
    let state = plugins.get(pluginId);
    if (!state) {
      state = { current: null, pending: null };
      plugins.set(pluginId, state);
    }
    if (state.current) state.current.retire();
    let retired = false;
    const isCurrent = () => !retired && state.current === lease;
    const lease = Object.freeze({
      isCurrent,
      retire() {
        retired = true;
        if (state.current === lease) state.current = null;
      },
      run(task) {
        if (!isCurrent()) return { ok: false, error: 'stale-generation' };
        if (state.pending) return { ok: false, error: 'operation-busy' };
        const token = {};
        state.pending = token;
        let result;
        try { result = task(Object.freeze({ isCurrent })); }
        catch (_) { result = Promise.reject(new Error('operation-failed')); }
        return Promise.resolve(result)
          .catch(() => ({ ok: false, error: 'operation-failed' }))
          .finally(() => { if (state.pending === token) state.pending = null; });
      }
    });
    state.current = lease;
    return lease;
  }

  return Object.freeze({ createLease });
}

module.exports = { createOperationCoordinator };
