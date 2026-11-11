'use strict';

/**
 * コメント送信（V2）。API chat.send を出す。送り先は各サイトの sink-<site> で、ctx.peers 経由（モードの扱いは本体）。
 * 受け取りは今までどおりわんコメ（丸ストは受け取らない）。外へ書くのは sink 側。秘密には触れない。
 */

const { createChatSend } = require('./lib/chat-send');

let sender = null;
let openExternal = null;

module.exports = {
  load(ctx) {
    sender = createChatSend({ peers: ctx.peers, bus: ctx.bus, logger: ctx.logger });
    openExternal = ctx.external && typeof ctx.external.open === 'function' ? ctx.external : null;
    ctx.api.register('chat.sendStatus', () => sender.status(), { access: 'read', description: 'コメント送信側から見える送信先を確認する（投稿しない）', params: {} });
    ctx.api.register('chat.send', (params, info) => sender.send({ text: params.text, sites: params.sites }, { clientId: info && info.clientId }), {
      access: 'write',
      description: '選んだサイトへコメントを送る。本文は 1〜200 文字、サイトは 1〜10',
      params: {
        text: { type: 'string', required: true, max: 200, emptyError: 'bad-text' },
        sites: {
          type: 'array',
          required: true,
          min: 1,
          max: 10,
          typeError: 'bad-sites',
          item: { type: 'string', max: 27, error: 'bad-site' }
        }
      }
    });
  },
  // 画面（ui/panel.html）の iframe が呼べる書き込み。API chat.send と同じ中身（本文・サイトの検査は sender.send の中）
  actions: {
    send(params) {
      if (!sender) return { ok: false, error: 'unavailable' };
      const p = params || {};
      return sender.send({ text: p.text, sites: p.sites }, {});
    },
    openFc2() {
      if (!openExternal) return { ok: false, error: 'unavailable' };
      return Promise.resolve(openExternal.open('https://live.fc2.com/'))
        .then(() => ({ ok: true }), () => ({ ok: false, error: 'open-failed' }));
    }
  },
  // 購読は画面（iframe）に届ける分だけ。ここでは何もしない
  onEvent() {},
  start() {},
  stop() { sender = null; openExternal = null; },
  destroy() { sender = null; openExternal = null; },
  health() { return { ok: true }; }
};
