'use strict';

// Picarto 題名更新のエラー分類: 403 / 本文 Unauthenticated → unauthorized、それ以外の非2xx → http
const assert = require('assert');
const { createSitePicarto } = require('../site');

function secretBox(token) {
  const value = JSON.stringify({ token: token, channel: 'orangeqoon' });
  return {
    mode: () => 'live',
    logger: () => {},
    redact: (m) => m,
    secrets: {
      get: async () => ({ ok: true, value }),
      set: async () => ({ ok: true })
    }
  };
}

function fakeFetch(status, text) {
  return async () => ({
    status,
    type: 'basic',
    text: async () => text
  });
}

(async () => {
  // 403 → unauthorized
  {
    const site = createSitePicarto({ fetch: fakeFetch(403, 'Unauthenticated') });
    site.load(secretBox('tok'));
    const res = await site.updateMetadata({ title: 'hello' });
    assert.deepStrictEqual(res, { ok: false, error: 'unauthorized' });
  }

  // 500 + Unauthenticated 本文 → unauthorized（ファンアウトが http になっていた本体の穴）
  {
    const site = createSitePicarto({ fetch: fakeFetch(500, '<html>Unauthenticated</html>') });
    site.load(secretBox('tok'));
    const res = await site.updateMetadata({ title: 'hello' });
    assert.deepStrictEqual(res, { ok: false, error: 'unauthorized' });
  }

  // 500 で別文言 → http
  {
    const site = createSitePicarto({ fetch: fakeFetch(500, 'Internal Server Error') });
    site.load(secretBox('tok'));
    const res = await site.updateMetadata({ title: 'hello' });
    assert.deepStrictEqual(res, { ok: false, error: 'http' });
  }

  // 200 → ok
  {
    const site = createSitePicarto({ fetch: fakeFetch(200, 'OK') });
    site.load(secretBox('tok'));
    const res = await site.updateMetadata({ title: 'hello' });
    assert.deepStrictEqual(res, { ok: true });
  }

  // authClass / tokenMeta
  {
    const site = createSitePicarto({});
    assert.strictEqual(site._authClass(403, ''), 'unauthenticated');
    assert.strictEqual(site._authClass(500, 'Unauthenticated'), 'unauthenticated');
    assert.strictEqual(site._authClass(500, 'nope'), 'other');
    assert.strictEqual(site._authClass(200, '{}'), 'ok');
    assert.deepStrictEqual(site._tokenMeta('x'.repeat(24)), { tokenLen: 24, tokenKind: 'short' });
    assert.deepStrictEqual(site._tokenMeta('a.b.c' + 'x'.repeat(40)), { tokenLen: 45, tokenKind: 'jwt' });
  }

  // checkAuth: missing / unauthenticated / ok（値は出ない）
  {
    const site = createSitePicarto({ fetch: fakeFetch(403, 'Unauthenticated') });
    const empty = { secrets: { get: async () => ({ ok: false }) } };
    assert.deepStrictEqual(await site.actions.checkAuth({}, empty), {
      ok: true, configured: false, auth: 'missing', status: 0, tokenLen: 0, tokenKind: 'none'
    });

    site.load(secretBox('short-token-24-chars!!'));
    const bad = await site.actions.checkAuth({}, secretBox('short-token-24-chars!!'));
    assert.strictEqual(bad.ok, true);
    assert.strictEqual(bad.configured, true);
    assert.strictEqual(bad.auth, 'unauthenticated');
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(bad.tokenKind, 'short');
    assert.ok(!JSON.stringify(bad).includes('short-token'));

    const siteOk = createSitePicarto({ fetch: fakeFetch(200, '{"name":"x"}') });
    const goodTok = 'a'.repeat(80);
    const good = await siteOk.actions.checkAuth({}, secretBox(goodTok));
    assert.deepStrictEqual({ auth: good.auth, status: good.status, tokenKind: good.tokenKind, tokenLen: good.tokenLen }, {
      auth: 'ok', status: 200, tokenKind: 'opaque', tokenLen: 80
    });
    assert.ok(!JSON.stringify(good).includes(goodTok));
  }

  const manifest = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.version, '0.1.1');
  assert.strictEqual(manifest.roles.site.actions.checkAuth, 'read');

  console.log('picarto update-auth: ok');
})().catch((e) => { console.error(e); process.exit(1); });
