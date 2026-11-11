'use strict';

const assert = require('assert');
const sinkModule = require('../sink');

function response(status, body) {
  return {
    status,
    text: async () => JSON.stringify(body == null ? {} : body)
  };
}

async function main() {
  const calls = [];
  const sink = sinkModule.createSinkYoutube({
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/liveBroadcasts')) {
        assert.strictEqual(parsed.searchParams.get('mine'), 'true', '配信枠検索は認証ユーザー自身に限定する');
        if (parsed.searchParams.get('broadcastStatus') === 'active') {
          return response(200, { items: [{ id: 'broadcast-1', snippet: { liveChatId: 'chat-1' } }] });
        }
        return response(200, { items: [] });
      }
      assert.strictEqual(parsed.pathname, '/youtube/v3/liveChat/messages');
      assert.strictEqual(parsed.searchParams.get('part'), 'snippet');
      const body = JSON.parse(init.body);
      assert.deepStrictEqual(body.snippet, {
        liveChatId: 'chat-1',
        type: 'textMessageEvent',
        textMessageDetails: { messageText: 'テスト送信' }
      });
      return response(200, {});
    }
  });
  sink.load({
    mode: () => 'live',
    secrets: {
      get: async () => ({ ok: true, value: JSON.stringify({
        client_id: 'client-id-123456',
        client_secret: 'client-secret-123456',
        refresh_token: 'refresh-token-123456',
        access_token: 'access-token-123456',
        expiry_date: Date.now() + 3600000
      })
      })
    },
    logger: () => {}
  });

  const result = await sink.sendComment({ text: 'テスト送信', site: 'youtube' }, {});
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(calls.length, 2, '配信枠検索とコメント送信を各1回');
  console.log('[marust] YouTube sink test passed');
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
