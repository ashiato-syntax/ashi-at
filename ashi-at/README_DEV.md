# Ashi@ — development prototype

最初の縦切り実装。Vite + Vanilla JS + Leaflet。

## 実装済み
- 認証なしのMisskey公開API利用
- ハッシュタグ検索
- Ashiato Candidate抽出
- Ashiato Syntax v1.0の基本Parse / Semantic Validation
- Canonical Serializationの基本部分
- Geohashデコード
- 開発用の地図表示

## 未実装
- 最終版の白地図＋グリッドUI
- 現在地取得と開封距離判定
- GPS必須の投稿UI
- 安全喚起UI
- TZ Dictionary v1の同梱・完全検証

## 方針
Ashiato Syntax v1.0に従い、`g`以降の標準フィールドとExtension Fieldの入力順は制約しない。Extension Fieldを最後に限定するルールは入れていない。

## 起動

```bash
npm install
npm run dev
```
