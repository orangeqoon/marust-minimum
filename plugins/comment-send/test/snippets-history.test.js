'use strict';

const assert = require('assert');
const path = require('path');

// 相対パスでモジュールをロード
const { createSnippetManager, createHistoryBuffer } = require(path.join(__dirname, '../ui/snippets-history.js'));

// モックストレージ作成ヘルパー
function createMockStorage(initialData = {}) {
  const store = Object.assign({}, initialData);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
    clear() {
      Object.keys(store).forEach(k => delete store[k]);
    },
    _dump() {
      return Object.assign({}, store);
    }
  };
}

console.log('--- Running SnippetManager & HistoryBuffer Tests ---');

// ==========================================
// 1. SnippetManager Tests
// ==========================================

// 1.1 初期状態（空ストレージ）でデフォルトのスニペット（!discord, !rules, !stream の3つ）がロードされること
{
  const storage = createMockStorage();
  const manager = createSnippetManager(storage);
  const list = manager.list();

  assert.strictEqual(list.length, 3, 'デフォルトで3件のスニペットが存在すること');

  const discord = list.find(s => s.command === '!discord');
  assert.ok(discord, '!discord が存在すること');
  assert.strictEqual(discord.content, 'Discordサーバーはこちら: https://discord.gg/example');

  const rules = list.find(s => s.command === '!rules');
  assert.ok(rules, '!rules が存在すること');
  assert.strictEqual(rules.content, '【配信ルール】誹謗中傷や連投はお控えください。みんなで楽しく交流しましょう！');

  const stream = list.find(s => s.command === '!stream');
  assert.ok(stream, '!stream が存在すること');
  assert.strictEqual(stream.content, '高評価・チャンネル登録・フォローよろしくお願いします！');

  // storage に永続化されていること
  assert.ok(storage.getItem('marust:comment-snippets'), 'ストレージに初期保存されていること');
  console.log('✓ 1.1 初期状態デフォルトスニペットロード PASS');
}

// 1.2 list() でスニペット配列を取得（参照汚染防止）
{
  const manager = createSnippetManager();
  const list1 = manager.list();
  list1.push({ id: 'dummy' });
  const list2 = manager.list();
  assert.strictEqual(list2.length, 3, 'list() の戻り値配列への直接操作が内部状態に影響しないこと');
  console.log('✓ 1.2 list() コピー返却 PASS');
}

// 1.3 add({ command, title, content }) で追加できること（commandの!正規化、200文字制限チェック）
{
  const storage = createMockStorage();
  const manager = createSnippetManager(storage);

  // ! なしの command が ! 付きに正規化されること
  const added = manager.add({
    command: 'hello',
    title: '挨拶',
    content: 'こんにちは！配信へようこそ！'
  });
  assert.strictEqual(added.command, '!hello', 'commandの先頭に!が付与されること');
  assert.strictEqual(added.title, '挨拶');
  assert.strictEqual(added.content, 'こんにちは！配信へようこそ！');
  assert.ok(added.id, 'id が自動生成されること');

  // ! 付き・空白ありの command もトリム＆正規化されること
  const added2 = manager.add({
    command: '  !bye  ',
    title: 'お別れ',
    content: 'おつかれさまでした！'
  });
  assert.strictEqual(added2.command, '!bye', '空白がトリムされること');

  // 200文字境界値テスト (200文字ちょうどはOK)
  const maxContent = 'a'.repeat(200);
  const addedMax = manager.add({
    command: '!max',
    title: '最大長',
    content: maxContent
  });
  assert.strictEqual(addedMax.content.length, 200);

  // 201文字以上はエラーがスローされること
  const overContent = 'a'.repeat(201);
  assert.throws(() => {
    manager.add({
      command: '!over',
      title: '制限オーバー',
      content: overContent
    });
  }, /200/, '200文字超えで例外がスローされること');

  // 不正な command（空文字など）で例外
  assert.throws(() => {
    manager.add({ command: '   ', title: '空', content: 'test' });
  }, /command/i, '空コマンドで例外がスローされること');

  console.log('✓ 1.3 add() 正規化＆文字数チェック PASS');
}

// 1.4 remove(id) で削除できること
{
  const manager = createSnippetManager();
  const list = manager.list();
  const targetId = list[0].id;

  const result = manager.remove(targetId);
  assert.strictEqual(result, true, '削除成功時に true を返すこと');
  assert.strictEqual(manager.list().length, 2, '要素数が1減っていること');
  assert.ok(!manager.list().some(s => s.id === targetId), '対象が一覧から消えていること');

  // 存在しない id の削除
  const notFoundResult = manager.remove('non-existent-id');
  assert.strictEqual(notFoundResult, false, '存在しないidの場合は false を返すこと');
  console.log('✓ 1.4 remove() 削除 PASS');
}

// 1.5 update(id, fields) で更新できること
{
  const manager = createSnippetManager();
  const target = manager.list()[0];

  const updated = manager.update(target.id, {
    command: 'rules-updated',
    content: '新ルールです'
  });
  assert.strictEqual(updated.command, '!rules-updated', '更新時も!が正規化されること');
  assert.strictEqual(updated.content, '新ルールです');

  // 200文字制限
  assert.throws(() => {
    manager.update(target.id, { content: 'x'.repeat(201) });
  }, /200/, '更新時も200文字制限が効くこと');

  // 存在しない id
  const notFound = manager.update('not-found', { title: 'hoge' });
  assert.strictEqual(notFound, null, '存在しないidの更新は null を返すこと');
  console.log('✓ 1.5 update() 更新 PASS');
}

// 1.6 findByCommand(input): 入力文字列から対応するスニペットを検索できること
{
  const manager = createSnippetManager();

  // 完全一致
  const match1 = manager.findByCommand('!discord');
  assert.ok(match1, '!discord にマッチすること');
  assert.strictEqual(match1.command, '!discord');

  // 末尾スペース
  const match2 = manager.findByCommand('!discord ');
  assert.ok(match2, '!discord [スペース] にマッチすること');
  assert.strictEqual(match2.command, '!discord');

  // コマンド＋引数/本文
  const match3 = manager.findByCommand('!rules 今日のルール');
  assert.ok(match3, '!rules [本文] にマッチすること');
  assert.strictEqual(match3.command, '!rules');

  // 先頭の!なし入力でもマッチ
  const match4 = manager.findByCommand('stream');
  assert.ok(match4, '!なし入力でもマッチすること');
  assert.strictEqual(match4.command, '!stream');

  // 大文字小文字の違いを許容
  const match5 = manager.findByCommand('!DISCORD');
  assert.ok(match5, '大文字でもマッチすること');

  // 不一致
  const matchNone = manager.findByCommand('!unknown');
  assert.strictEqual(matchNone, null, '未登録コマンドは null を返すこと');

  console.log('✓ 1.6 findByCommand() 検索 PASS');
}

// 1.7 exportJson() / importJson(jsonStr)
{
  const storage1 = createMockStorage();
  const manager1 = createSnippetManager(storage1);
  manager1.add({ command: '!custom', title: 'カスタム', content: 'オリジナル内容' });

  const jsonStr = manager1.exportJson();
  assert.strictEqual(typeof jsonStr, 'string', 'JSON文字列を返すこと');

  // 別マネージャーへのインポート
  const storage2 = createMockStorage();
  const manager2 = createSnippetManager(storage2);
  const importResult = manager2.importJson(jsonStr);
  assert.ok(importResult.success, 'インポートが成功すること');
  assert.ok(manager2.findByCommand('!custom'), 'インポートされたスニペットが存在すること');

  // 不正なJSONのインポート
  const badJsonResult = manager2.importJson('invalid-json{{{');
  assert.strictEqual(badJsonResult.success, false, '構文不正JSONは失敗すること');

  // 不正な形式（配列でない）
  const objJsonResult = manager2.importJson('{"command": "!single"}');
  assert.strictEqual(objJsonResult.success, false, '配列でないJSONは失敗すること');

  // 不正な要素（200文字超えやcommand無し）を含む配列のインポート
  const mixedJson = JSON.stringify([
    { command: '!valid1', content: 'OKスニペット' },
    { command: '', content: 'コマンドなし' },
    { command: '!toolong', content: 'z'.repeat(201) },
    { command: 'valid2', content: 'OKスニペット2' }
  ]);
  const mixedResult = manager2.importJson(mixedJson);
  assert.ok(mixedResult.success, '一部不正があっても全体としては処理継続すること');
  assert.strictEqual(mixedResult.count, 2, '有効な2件のみインポートされること');
  assert.ok(manager2.findByCommand('!valid1'), 'valid1がインポートされていること');
  assert.ok(manager2.findByCommand('!valid2'), 'valid2がインポートされていること');

  console.log('✓ 1.7 exportJson() & importJson() PASS');
}


// ==========================================
// 2. HistoryBuffer Tests
// ==========================================

// 2.1 push(text) で履歴を追加（同一内容の連続重複は除外、最大件数で切り詰め）
{
  const history = createHistoryBuffer(3);

  history.push('msg1');
  history.push('msg2');
  // 連続重複
  history.push('msg2');
  // 空文字・空白のみ
  history.push('');
  history.push('   ');

  // prev で確認
  assert.strictEqual(history.prev(''), 'msg2');
  assert.strictEqual(history.prev('msg2'), 'msg1');

  // 最大件数（3件）の切り詰め確認
  history.reset();
  history.push('msg3');
  history.push('msg4'); // この時点で ['msg2', 'msg3', 'msg4'] になるべき (msg1が溢れる)

  assert.strictEqual(history.prev(''), 'msg4');
  assert.strictEqual(history.prev('msg4'), 'msg3');
  assert.strictEqual(history.prev('msg3'), 'msg2');
  // これ以上前には戻らない
  assert.strictEqual(history.prev('msg2'), 'msg2');

  console.log('✓ 2.1 push() 重複除外＆最大件数切り詰め PASS');
}

// 2.2 prev(currentDraft) / next(currentDraft) でドラフト保持と前後の移動
{
  const history = createHistoryBuffer(10);
  history.push('first');
  history.push('second');
  history.push('third');

  // 現在入力中のドラフト "my unfinished comment"
  const draft = 'my unfinished comment';

  // 1回目 prev: 最新履歴 'third' が返り、draft が退避される
  assert.strictEqual(history.prev(draft), 'third');

  // 2回目 prev: 'second'
  assert.strictEqual(history.prev('third'), 'second');

  // 3回目 prev: 'first' (最古)
  assert.strictEqual(history.prev('second'), 'first');

  // 4回目 prev: 最古を超えない
  assert.strictEqual(history.prev('first'), 'first');

  // 1回目 next: 1つ進んで 'second'
  assert.strictEqual(history.next('first'), 'second');

  // 2回目 next: 1つ進んで 'third'
  assert.strictEqual(history.next('second'), 'third');

  // 3回目 next: 最新を超えて、退避されていた draft に戻る
  assert.strictEqual(history.next('third'), draft);

  // 4回目 next: ドラフト位置を超えない
  assert.strictEqual(history.next(draft), draft);

  console.log('✓ 2.2 prev() / next() ドラフト保持とナビゲーション PASS');
}

// 2.3 reset(): 探索ポインタを末尾にリセット
{
  const history = createHistoryBuffer(10);
  history.push('cmd1');
  history.push('cmd2');

  // 探索中に途中で抜ける
  assert.strictEqual(history.prev('editing'), 'cmd2');
  assert.strictEqual(history.prev('cmd2'), 'cmd1');

  // reset() 呼び出し
  history.reset();

  // 再度 prev を呼ぶと最新の cmd2 が返り、新しいドラフトが保持される
  assert.strictEqual(history.prev('new-draft'), 'cmd2');
  assert.strictEqual(history.next('cmd2'), 'new-draft');

  console.log('✓ 2.3 reset() リセット PASS');
}

// 2.4 sessionStore との永続化
{
  const sessionStore = createMockStorage();
  const history1 = createHistoryBuffer(10, sessionStore);
  history1.push('saved1');
  history1.push('saved2');

  assert.ok(sessionStore.getItem('marust:comment-history'), 'sessionStore に保存されていること');

  // 別インスタンスで復元確認
  const history2 = createHistoryBuffer(10, sessionStore);
  assert.strictEqual(history2.prev(''), 'saved2');
  assert.strictEqual(history2.prev('saved2'), 'saved1');

  console.log('✓ 2.4 sessionStore 連携 PASS');
}

// ==========================================
// 3. Browser / UMD Environment Tests
// ==========================================
{
  const vm = require('vm');
  const fs = require('fs');
  const code = fs.readFileSync(path.join(__dirname, '../ui/snippets-history.js'), 'utf8');

  // ブラウザの window グローバルを模したコンテキスト
  const browserCtx = { window: {} };
  vm.createContext(browserCtx);
  vm.runInContext(code, browserCtx);

  assert.ok(browserCtx.window.marustSnippetHistory, 'window.marustSnippetHistory が定義されること');
  assert.strictEqual(typeof browserCtx.window.marustSnippetHistory.createSnippetManager, 'function');
  assert.strictEqual(typeof browserCtx.window.marustSnippetHistory.createHistoryBuffer, 'function');
  console.log('✓ 3.1 Browser / window.marustSnippetHistory UMDエクスポート PASS');
}

console.log('\nAll SnippetManager & HistoryBuffer tests PASSED successfully!');
