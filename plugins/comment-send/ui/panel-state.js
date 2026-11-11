'use strict';
// Self-contained copy shipped inside each plugin. No API calls or persistent storage.
(function () {
  if (window.marustCapturePanelState) return;
  var touched = new WeakSet(), handshake = false, applying = false, drafts = null, scrollTimer = null;
  var MAX = 131072;
  function fields() { return Array.from(document.querySelectorAll('input,textarea,select')); }
  function safe(element) {
    return element && (element.id || element.name) && !(element.hasAttribute && element.hasAttribute('data-chat-site')) && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) &&
      !/^(password|hidden|file|button|submit|reset|image)$/i.test(element.type || '') &&
      !/password|secret|token|cookie|client.?id|credential|key/i.test([element.id, element.name, element.autocomplete].join(' '));
  }
  function bounded(value) {
    try { var text = JSON.stringify(value); return text && text.length <= MAX ? JSON.parse(text) : null; } catch (_) { return null; }
  }
  function capture() {
    var values = [], needsFileReselect = false;
    var all = fields();
    all.forEach(function (element, index) {
      if (element.type === 'file' && element.files && element.files.length) needsFileReselect = true;
      if (!safe(element) || !touched.has(element) || values.length >= 200) return;
      var value = String(element.value || '');
      if (value.length > 32768) return;
      var row = { id: element.id || '', name: element.name || '', index: index, type: element.type || '', value: value, checked: !!element.checked };
      if (element.multiple && element.options) row.selectedValues = Array.from(element.options).filter(function (option) { return option.selected; }).map(function (option) { return String(option.value); });
      var restored = drafts && drafts.find(function (item) { return find(item, all) === element; });
      if (restored) row = Object.assign({}, restored, { index: index });
      values.push(row);
    });
    var custom = null;
    try { if (window.marustPanelStateAdapter) custom = window.marustPanelStateAdapter.capture(); } catch (_) {}
    var scrolling = document.scrollingElement;
    return bounded({ fields: values, needsFileReselect: needsFileReselect, scroll: { x: scrolling ? scrolling.scrollLeft : 0, y: scrolling ? scrolling.scrollTop : 0 }, custom: custom });
  }
  function publish() {
    if (!handshake || applying) return;
    var state = capture();
    if (state) parent.postMessage({ type: 'marust:panel-state', state: state }, '*');
  }
  function find(row, elements) {
    var element = elements[row.index];
    function matches(node) { return safe(node) && (node.id || '') === row.id && (node.name || '') === row.name && (node.type || '') === row.type && (!/^(checkbox|radio)$/.test(row.type) || node.value === row.value); }
    return matches(element) ? element : elements.find(matches);
  }
  function restoreFields(rows) {
    if (!Array.isArray(rows)) return;
    applying = true;
    try {
      var elements = fields();
      rows.slice(0, 200).forEach(function (row) {
        if (!row || typeof row.value !== 'string' || row.value.length > 32768) return;
        var element = find(row, elements);
        if (!element) return;
        if (!/^(checkbox|radio)$/.test(element.type)) element.value = row.value;
        if (element.type === 'checkbox' || element.type === 'radio') element.checked = row.checked === true;
        if (element.multiple && element.options && Array.isArray(row.selectedValues)) Array.from(element.options).forEach(function (option) { option.selected = row.selectedValues.indexOf(String(option.value)) !== -1; });
        touched.add(element);
      });
    } finally { applying = false; }
  }
  function consumeDrafts() { drafts = null; }
  function restore(state) {
    var value = bounded(state);
    if (value) {
      consumeDrafts();
      drafts = value.fields;
      restoreFields(drafts);
      try { if (window.marustPanelStateAdapter && typeof window.marustPanelStateAdapter.restore === 'function') window.marustPanelStateAdapter.restore(value.custom); } catch (_) {}
      if (value.scroll && Number.isFinite(value.scroll.x) && Number.isFinite(value.scroll.y)) {
        var scrolling = document.scrollingElement;
        if (scrolling) { scrolling.scrollLeft = Math.max(0, value.scroll.x); scrolling.scrollTop = Math.max(0, value.scroll.y); }
      }
      if (value.needsFileReselect && !(value.custom && value.custom.filePath)) {
        var notice = document.getElementById('marust-panel-file-notice');
        if (!notice) { notice = document.createElement('p'); notice.id = 'marust-panel-file-notice'; notice.setAttribute('role', 'status'); document.body.appendChild(notice); }
        notice.textContent = '別窓への移動でファイル選択は解除されました。ファイルを選び直してください。';
      }
    }
    handshake = true;
    document.dispatchEvent(new CustomEvent('marust:panel-state-restored'));
  }
  function changed(event) {
    if (applying) return;
    if (safe(event.target)) {
      touched.add(event.target);
      if (drafts) {
        var all = fields();
        drafts = drafts.filter(function (row) { return find(row, all) !== event.target; });
        var current = capture();
        if (current) drafts = current.fields;
      }
    }
    publish();
  }
  document.addEventListener('input', changed, true);
  document.addEventListener('change', changed, true);
  document.addEventListener('marust:panel-state-dirty', function () { consumeDrafts(); publish(); });
  document.addEventListener('submit', consumeDrafts, true);
  document.addEventListener('marust:panel-state-publish', publish);
  document.addEventListener('scroll', function () { if (scrollTimer !== null) clearTimeout(scrollTimer); scrollTimer = setTimeout(function () { scrollTimer = null; publish(); }, 100); }, true);
  window.addEventListener('pagehide', function () { if (scrollTimer !== null) clearTimeout(scrollTimer); publish(); });
  window.addEventListener('message', function (event) {
    if (event.source !== parent || !event.data) return;
    if (event.data.type === 'marust:panel-state-restore') restore(event.data.state);
    else if (event.data.type === 'marust:result' && handshake && drafts) setTimeout(function () { if (handshake && drafts) restoreFields(drafts); }, 0);
  });
  window.marustCapturePanelState = capture;
  window.marustPanelFieldDirty = function (element) { return !!(drafts && drafts.some(function (row) { return find(row, fields()) === element; })); };
  window.marustPanelReleaseFields = function (elements) {
    var all = fields();
    (elements || []).forEach(function (element) {
      touched.delete(element);
      if (drafts) drafts = drafts.filter(function (row) { return find(row, all) !== element; });
    });
    publish();
  };
  function ready() { parent.postMessage({ type: 'marust:panel-state-ready' }, '*'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
}());
