(function (root, factory) {
  var create = factory();
  if (typeof module === 'object' && module.exports) module.exports = { createPopoutTabActivation: create };
  if (root) root.createPopoutTabActivation = create;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  return function createPopoutTabActivation(options) {
    var dock = options.dockview;
    function attach(targetWindow) {
      var press = null, dragging = false, removed = false;
      function resolve(event) {
        var node = event.target;
        if (!node || typeof node.closest !== 'function') return null;
        if (node.closest('button,a,input,select,textarea,[role="button"],.dv-default-tab-action,.dock-icon-btn')) return null;
        var tab = node.closest('.dv-tab');
        if (!tab || tab.ownerDocument !== targetWindow.document) return null;
        var id = tab.dataset && tab.dataset.tabPanelId;
        var panel = id && dock.getPanel(id);
        if (!panel || !panel.group || !panel.group.element || !panel.group.element.contains(tab)) return null;
        return { tab: tab, panel: panel };
      }
      function modified(e) { return e.button !== 0 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey; }
      function down(e) {
        dragging = false;
        var match = !modified(e) && resolve(e);
        press = match ? { tab: match.tab, x: e.clientX, y: e.clientY } : null;
      }
      function move(e) { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) dragging = true; }
      function drag() { dragging = true; }
      function cancel() { press = null; dragging = true; }
      function click(e) {
        var match = resolve(e), selected = press;
        press = null;
        if (e.defaultPrevented || modified(e) || !match) return;
        if (e.detail !== 0 && (dragging || !selected || selected.tab !== match.tab)) return;
        // The completed click runs in the visible popup; do not await the
        // opener's requestAnimationFrame (which can be throttled or suspended).
        match.panel.api.setActive();
      }
      var handlers = { pointerdown: down, pointermove: move, pointercancel: cancel, dragstart: drag, click: click };
      Object.keys(handlers).forEach(function (name) { targetWindow.addEventListener(name, handlers[name]); });
      return function dispose() {
        if (removed) return;
        removed = true;
        Object.keys(handlers).forEach(function (name) { try { targetWindow.removeEventListener(name, handlers[name]); } catch (_) { /* closed popup */ } });
        press = null;
      };
    }
    return { attach: attach };
  };
}));
