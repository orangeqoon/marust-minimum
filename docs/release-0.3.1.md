# Minimum 0.3.1（試験公開）

- 最小版の23プラグイン構成を維持しました。作者用プラグイン・認証情報・利用履歴は含みません。
- YouTube枠の実開始時刻と切替期限を保存し、丸ストの再起動で期限を最初から数え直さないよう改善しました。既定は11時間50分です。
- YouTubeを送るOBS出力を明示選択し、対象の実送信先を照合して操作します。専用サブ出力はメインサイトに依存せず切替可能です。共有出力・不明な状態・他出力が連動する設定では保留します。
- 中断した枠切替の復旧記録と確認操作を追加しました。作成結果が不明なときの重複作成を避けます。
- 接続済みなのに画面上部へ未接続と出る、画面の読み込み順序の問題を修正しました。
- コメント画面は開発元で更新済みの定型文・送信履歴機能を含みます。

## 利用時の注意

新規環境の自動送信やlive設定を勝手に有効にしません。利用者自身のログインと、対象OBS出力の選択が必要です。既存の保存先・設定は引き継ぎます。

隔離した実OBSとPC内RTMP受信先では、メイン出力を継続しながら対象サブ出力だけを停止・再開することを確認しました。公開ZIPで実YouTubeへ12時間配信する通し試験、別PCでの確認は未実施です。未署名の試験公開版として配布します。

## 検証範囲

関連する集中試験95件、セキュリティ7群、構文・型検査は通過しました。全体試験は139/158で、次の19ファイルに失敗が残っています。最小版に入らない機能を前提にする試験やソース構成の検査を含み、全件成功として扱っていません。

```text
test/c2-build.test.js
test/c4-ui-standard.test.js
test/k5-packs.test.js
test/l6b-session-out-of-core.test.js
test/l7-layers.test.js
test/r15-ui-split.test.js
test/r9-overlap.test.js
test/stage1b.test.js
test/stage2.test.js
test/v05-api-reload.test.js
test/v1-plugin-api.test.js
test/v3-ui.test.js
test/v5-dist.test.js
test/v5-ui.test.js
test/w15-mcp.test.js
test/w27-sinks-oauth.test.js
test/w50-plugin-obs-read.test.js
test/x4-fixed-shapes.test.js
plugins/uplink-estimate/test/r7-uplink.test.js
```

セキュリティ試験の共通ヘルパーが使うセッション部品は、`test/fixtures/session/`へ試験専用として置いています。追加プラグインとしてはインストールされず、配布ZIPにも含まれません。
