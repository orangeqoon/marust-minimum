#!/usr/bin/env node
'use strict';

/**
 * 配布物に同梱する OBS プラグインを、fork のビルド結果（..\obs-multi-rtmp\dist\）から vendor-obs-plugin\ へ写す（L5b）。
 * dll と data\locale\*.ini だけ。.pdb と *.before-* は入れない。vendor-obs-plugin\ は git に入れない。
 * 写す物が無くても失敗にしない（fork 側がビルド中かもしれない）。electron-packager には --extra-resource=vendor-obs-plugin で渡す。
 */

const fs = require('fs');
const path = require('path');
const { planFiles } = require('../lib/obs-plugin-installer');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, '..', 'obs-multi-rtmp', 'dist');
const TO = path.join(ROOT, 'vendor-obs-plugin');

function bundle(from, to) {
  if (!fs.existsSync(path.join(from, 'obs-multi-rtmp.dll'))) return { ok: false, copied: 0 };
  fs.rmSync(to, { recursive: true, force: true });
  // 入れる場所と同じ並び（bin\64bit）ではなく、同梱の並び（dll は直下・data\locale）で写す
  const plan = planFiles(from, to).map((row) => ({ from: row.from, to: row.from.replace(from, to) }));
  plan.forEach((row) => {
    fs.mkdirSync(path.dirname(row.to), { recursive: true });
    fs.copyFileSync(row.from, row.to);
  });
  return { ok: true, copied: plan.length };
}

if (require.main === module) {
  const res = bundle(FROM, TO);
  if (!res.ok) console.log('bundle-obs-plugin: ' + FROM + ' に obs-multi-rtmp.dll が無いので写しません（fork のビルド後にやり直す）');
  else console.log('bundle-obs-plugin: ' + res.copied + ' ファイルを ' + TO + ' へ写しました');
}

module.exports = { bundle };
