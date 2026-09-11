# 生活費レシート管理 PWA - 公開用 v1

この版は「本番PWAの土台」として、レシート撮影/OCRより先にデータ保存を実装したものです。

## 公開用データについて

このリポジトリに含まれる初期レシートは、動作確認用の完全なダミーデータです。実際の購入履歴・店舗名・レシート画像・決済情報・APIキー・パスワード等は含まれていません。

実際に登録した家計データはブラウザの IndexedDB に端末内保存され、GitHub へ自動送信されません。

## 実装済み

- IndexedDBに端末内保存
- レシート画像は保存しない
- 商品名の手修正
- 自動カテゴリ: 食費 / お菓子・嗜好品 / 果物 / 野菜 / 日用品
- 手動専用カテゴリ: 母向け / その他
- 要確認カードを薄いピンクで表示
- 税込・実支払額で保存
- 月次集計
- レシート単位の削除
- 月単位の削除
- 全購入データの削除
- 分類ルールは購入データ削除後も保持
- 分類ルールだけ個別にリセット可能
- PWA用manifest / Service Worker

## 未実装（次工程）

- Excel (.xlsx) エクスポート
- カメラ撮影
- OCR
- AI自動分類
- 値引き/税率の実レシート解析

## ローカル確認

PWA/Service Worker/IndexedDBを正しく確認するため、`file://` で直接開かずHTTPサーバーから開いてください。

```bash
cd receipt-pwa-v1
npx http-server -p 8080
```

PCなら `http://localhost:8080` を開きます。

iPhoneへ入れる本番運用ではHTTPSのホスティングが必要です。撮影/OCR実装後にデプロイ方法まで整えます。

## 保存仕様

- `receipts`: レシート単位
- `receipt_items`: 商品明細
- `classification_rules`: ユーザーが自動カテゴリを修正した学習ルール
- `settings`: 将来の設定保存用

「母向け」「その他」は例外カテゴリなので、学習ルールには保存しません。


## iPhone/GitHub upload edition
This package is flattened so every file can be selected at once from the iOS Files picker. Upload all files in this folder to the repository root.
