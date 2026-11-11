'use strict';

/**
 * Electron safeStorage の暗号化コンテキストを配布版と揃える。
 *
 * Windows の safeStorage はアプリ名を暗号化コンテキストの一部として扱う
 * ため、開発起動時の既定名 "Electron" のままだと、配布版 "marust" が
 * 作った金庫を復号できない。app.whenReady() より前に呼ぶこと。
 */

const APP_NAME = 'marust';

function configureElectronIdentity(electronModule) {
  const electron = electronModule || {};
  const app = electron.app;
  if (!app || typeof app.setName !== 'function') return false;
  try {
    app.setName(APP_NAME);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { APP_NAME, configureElectronIdentity };
