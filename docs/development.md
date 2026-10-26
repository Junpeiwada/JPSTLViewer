# 開発メモ

---

## 目次

- [開発](#開発)
- [手元へのインストール（VSIX）](#手元へのインストールvsix)
- [公開（Marketplace）](#公開marketplace)
- [設計メモ](#設計メモ)
  - [ライティング](#ライティング)
  - [自動リロード](#自動リロード)
  - [見た目の記憶](#見た目の記憶)
  - [STL の色の読み方](#stl-の色の読み方)
  - [webview への STL の渡し方](#webview-への-stl-の渡し方)

---

## 開発

```bash
npm install
npm run compile     # 型チェック（拡張・webview）→ webview を esbuild で束ねる
npm run watch       # webview の監視ビルド
```

VSCode でこのフォルダを開いて F5（拡張機能開発ホスト）で動作確認。

## 手元へのインストール（VSIX）

```bash
npm run install-local   # コンパイル → VSIX 生成 → この VSCode にインストール（一発）
```

VSCode から実行する場合は ⌘⇧P →「Tasks: Run Task」→「npm: install-local」。
インストール後はウィンドウをリロード（⌘⇧P →「Developer: Reload Window」）すると反映される。

## 公開（Marketplace）

公開・更新の手順とトークンの扱いは [publish.md](publish.md) を参照。

## 設計メモ

### ライティング

キーライトはポイント光源で、光度はモデル中心での照度がスライダーの値になるよう距離² を掛けて決める。既定はキー 1.6・補助 1.0・環境 0.3。
床下の補助光は影を落とさず、底面・裏側に届く。床は上向きの片面で、床下に回り込むと床は消えて底が見える。全体の露出は `src/webview/main.ts` の `toneMappingExposure`、ライトの既定値は `src/webview/looks.ts` の `DEFAULT_LOOK` で変える。

### 自動リロード

STL の更新を監視し、書き込み完了（バイナリはヘッダの三角形数とファイル長の一致、ASCII は `endsolid`）を待ってから読み直す。

### 見た目の記憶

材質・色・「STL の色を使う」・STL の色の置き換えは STL のパスごとに globalState に覚える（最近の 500 件）。初めて開く STL は直前に使った見た目で始まる（STL の色の置き換えは引き継がない）。背景とライトは全ファイル共通。

### STL の色の読み方

Three.js の STLLoader と同じ解釈で読む。

- 80 バイトのヘッダのどこかに `COLOR=` ＋ R・G・B・A の 4 バイト → ファイル全体の既定色。**これが無いと色なしとして扱う**
- 三角形ごとの予備 2 バイト（リトルエンディアン）: 最上位ビットが 0 なら固有色で、`r | g<<5 | b<<10`（各 5 ビット）。最上位ビットが 1 ならヘッダの既定色

### webview への STL の渡し方

拡張側で読んだ STL のバイト列を `postMessage` で webview に渡す。Three.js は esbuild で `media/webview.js` に同梱しており、オフラインで動く。
