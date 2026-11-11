'use strict';

(function (root, factory) {
  var exported = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  if (typeof root !== 'undefined') {
    root.marustSnippetHistory = exported;
  }
  if (typeof window !== 'undefined') {
    window.marustSnippetHistory = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var DEFAULT_SNIPPETS = [
    {
      id: 'default-discord',
      command: '!discord',
      title: 'Discordサーバー',
      content: 'Discordサーバーはこちら: https://discord.gg/example'
    },
    {
      id: 'default-rules',
      command: '!rules',
      title: '配信ルール',
      content: '【配信ルール】誹謗中傷や連投はお控えください。みんなで楽しく交流しましょう！'
    },
    {
      id: 'default-stream',
      command: '!stream',
      title: '配信応援・登録',
      content: '高評価・チャンネル登録・フォローよろしくお願いします！'
    }
  ];

  var SNIPPET_STORAGE_KEY = 'marust:comment-snippets';
  var HISTORY_STORAGE_KEY = 'marust:comment-history';

  function normalizeCommand(command) {
    if (typeof command !== 'string') return '';
    var trimmed = command.trim();
    if (!trimmed) return '';
    if (!trimmed.startsWith('!')) {
      trimmed = '!' + trimmed;
    }
    return trimmed;
  }

  /**
   * スニペットマネージャーのファクトリ関数
   * @param {Object} [storage] Web Storage 互換オブジェクト (localStorage等)
   */
  function createSnippetManager(storage) {
    var snippets = [];

    function save() {
      if (storage && typeof storage.setItem === 'function') {
        try {
          storage.setItem(SNIPPET_STORAGE_KEY, JSON.stringify(snippets));
        } catch (_) {}
      }
    }

    function load() {
      if (storage && typeof storage.getItem === 'function') {
        try {
          var raw = storage.getItem(SNIPPET_STORAGE_KEY);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              snippets = parsed;
              return;
            }
          }
        } catch (_) {}
      }
      snippets = DEFAULT_SNIPPETS.map(function (item) {
        return Object.assign({}, item);
      });
      save();
    }

    load();

    function list() {
      return snippets.map(function (item) {
        return Object.assign({}, item);
      });
    }

    function add(item) {
      if (!item || typeof item !== 'object') {
        throw new Error('Snippet item must be an object');
      }
      var cmd = normalizeCommand(item.command);
      if (!cmd || cmd === '!') {
        throw new Error('Valid command starting with ! is required');
      }
      var content = String(item.content !== undefined ? item.content : '');
      if (content.length > 200) {
        throw new Error('Snippet content exceeds 200 characters (max 200)');
      }
      var title = item.title ? String(item.title).trim() : cmd;
      var id = item.id || ('snip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      var snippet = {
        id: id,
        command: cmd,
        title: title,
        content: content
      };
      snippets.push(snippet);
      save();
      return Object.assign({}, snippet);
    }

    function remove(id) {
      var idx = snippets.findIndex(function (s) { return s.id === id; });
      if (idx === -1) return false;
      snippets.splice(idx, 1);
      save();
      return true;
    }

    function update(id, fields) {
      var snippet = snippets.find(function (s) { return s.id === id; });
      if (!snippet) return null;
      if (!fields || typeof fields !== 'object') return Object.assign({}, snippet);

      if (fields.command !== undefined) {
        var cmd = normalizeCommand(fields.command);
        if (!cmd || cmd === '!') {
          throw new Error('Valid command starting with ! is required');
        }
        snippet.command = cmd;
      }
      if (fields.content !== undefined) {
        var content = String(fields.content);
        if (content.length > 200) {
          throw new Error('Snippet content exceeds 200 characters (max 200)');
        }
        snippet.content = content;
      }
      if (fields.title !== undefined) {
        snippet.title = String(fields.title).trim();
      }
      save();
      return Object.assign({}, snippet);
    }

    function findByCommand(input) {
      if (typeof input !== 'string') return null;
      var trimmed = input.trim();
      if (!trimmed) return null;
      var token = trimmed.split(/\s+/)[0];
      if (!token.startsWith('!')) {
        token = '!' + token;
      }
      var target = token.toLowerCase();
      var found = snippets.find(function (s) {
        return s.command && s.command.toLowerCase() === target;
      });
      return found ? Object.assign({}, found) : null;
    }

    function exportJson() {
      return JSON.stringify(snippets, null, 2);
    }

    function importJson(jsonStr) {
      if (typeof jsonStr !== 'string') {
        return { success: false, error: 'Input must be a JSON string', count: 0 };
      }
      var parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (_) {
        return { success: false, error: 'Invalid JSON', count: 0 };
      }
      if (!Array.isArray(parsed)) {
        return { success: false, error: 'JSON content must be an array of snippets', count: 0 };
      }
      var importedCount = 0;
      var importedSnippets = [];
      parsed.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var cmd = normalizeCommand(item.command);
        if (!cmd || cmd === '!') return;
        var content = String(item.content !== undefined ? item.content : '');
        if (content.length > 200) return;
        var title = item.title ? String(item.title).trim() : cmd;
        var id = item.id || ('snip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));

        var existing = snippets.find(function (s) {
          return s.id === id || s.command.toLowerCase() === cmd.toLowerCase();
        });
        if (existing) {
          existing.command = cmd;
          existing.title = title;
          existing.content = content;
          importedSnippets.push(existing);
        } else {
          var newSnip = { id: id, command: cmd, title: title, content: content };
          snippets.push(newSnip);
          importedSnippets.push(newSnip);
        }
        importedCount++;
      });
      save();
      return { success: true, count: importedCount, snippets: importedSnippets };
    }

    return {
      list: list,
      add: add,
      remove: remove,
      update: update,
      findByCommand: findByCommand,
      exportJson: exportJson,
      importJson: importJson
    };
  }

  /**
   * チャット履歴バッファのファクトリ関数
   * @param {number} [maxSize=50] 最大履歴件数
   * @param {Object} [sessionStore] sessionStorage 互換オブジェクト
   */
  function createHistoryBuffer(maxSize, sessionStore) {
    var max = typeof maxSize === 'number' && maxSize > 0 ? maxSize : 50;
    var items = [];
    var cursor = 0;
    var savedDraft = null;

    function save() {
      if (sessionStore && typeof sessionStore.setItem === 'function') {
        try {
          sessionStore.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
        } catch (_) {}
      }
    }

    function reset() {
      cursor = items.length;
      savedDraft = null;
    }

    function load() {
      if (sessionStore && typeof sessionStore.getItem === 'function') {
        try {
          var raw = sessionStore.getItem(HISTORY_STORAGE_KEY);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              items = parsed.filter(function (x) {
                return typeof x === 'string' && x.trim().length > 0;
              });
              if (items.length > max) {
                items = items.slice(items.length - max);
              }
            }
          }
        } catch (_) {}
      }
      reset();
    }

    load();

    function push(text) {
      if (typeof text !== 'string') return;
      var trimmed = text.trim();
      if (!trimmed) return;

      // 同一内容の連続重複は除外
      if (items.length > 0 && items[items.length - 1] === text) {
        reset();
        return;
      }
      items.push(text);
      if (items.length > max) {
        items.splice(0, items.length - max);
      }
      reset();
      save();
    }

    function prev(currentDraft) {
      if (items.length === 0) {
        return currentDraft !== undefined ? currentDraft : '';
      }
      if (cursor === items.length) {
        savedDraft = currentDraft !== undefined ? currentDraft : '';
      }
      if (cursor > 0) {
        cursor--;
      }
      return items[cursor];
    }

    function next(currentDraft) {
      if (items.length === 0) {
        return currentDraft !== undefined ? currentDraft : '';
      }
      if (cursor < items.length) {
        cursor++;
      }
      if (cursor === items.length) {
        return savedDraft !== null ? savedDraft : (currentDraft !== undefined ? currentDraft : '');
      }
      return items[cursor];
    }

    return {
      push: push,
      prev: prev,
      next: next,
      reset: reset,
      getItems: function () { return items.slice(); }
    };
  }

  return {
    createSnippetManager: createSnippetManager,
    createHistoryBuffer: createHistoryBuffer
  };
});
