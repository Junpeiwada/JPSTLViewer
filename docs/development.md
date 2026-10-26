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
  - [3MF の読み方](#3mf-の読み方)
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

キーライトはポイント光源で、光度はモデル中心での照度がスライダーの値になるよう距離² を掛けて決める。既定はキー 1.6・補助 1.0・環境 0.3・カメラ 0.3。
カメラの光はカメラの子に付けた影なしの点光源で、注視点での照度がスライダーの値になるよう、視点が動くたびにカメラから注視点までの距離² を掛け直す（見ている側の暗がりを少し持ち上げる）。
床下の補助光は影を落とさず、底面・裏側に届く。床は上向きの片面で、床下に回り込むと床は消えて底が見える。全体の露出は `src/webview/main.ts` の `toneMappingExposure`、ライトの既定値は `src/webview/looks.ts` の `DEFAULT_LOOK` で変える。

### 自動リロード

ファイルの更新を監視し、書き込み完了（バイナリ STL はヘッダの三角形数とファイル長の一致、ASCII STL は `endsolid`、3MF は ZIP の中央ディレクトリ終端がファイル末尾にそろうこと）を待ってから読み直す。

### 見た目の記憶

材質・色・「STL の色を使う」・STL の色の置き換えは STL のパスごとに globalState に覚える（最近の 500 件）。初めて開く STL は直前に使った見た目で始まる（STL の色の置き換えは引き継がない）。背景とライトは全ファイル共通。

### STL の色の読み方

Three.js の STLLoader と同じ解釈で読む。

- 80 バイトのヘッダのどこかに `COLOR=` ＋ R・G・B・A の 4 バイト → ファイル全体の既定色。**これが無いと色なしとして扱う**
- 三角形ごとの予備 2 バイト（リトルエンディアン）: 最上位ビットが 0 なら固有色で、`r | g<<5 | b<<10`（各 5 ビット）。最上位ビットが 1 ならヘッダの既定色

### 3MF の読み方

`src/webview/threemf.ts` の自前パーサで読む。Three.js の 3MFLoader は、`p:path` で別の .model を指す部品をオブジェクト番号だけで引くため番号が重なると崩れ、Bambu Studio のフィラメント色も取れないので使わない。

- ZIP は Three.js 同梱の fflate で展開する（`.model` / `.rels` / `.config` だけ。サムネイルや G-code は展開しない）
- .model は数 MB になるので DOM に組み立てず、正規表現で走査する。属性値の中の `>` や CDATA は扱えない
- build の item から components をたどって変換を掛け合わせ、全オブジェクトを 1 つの形にまとめる。鏡映の変換では三角形の頂点の順を入れ替えて表を保つ。展開後の三角形は 2,000 万を上限にする
- 色は Bambu の `Metadata/model_settings.config` のフィラメント番号を `Metadata/project_settings.config` の `filament_colour` で引いたものを優先し、無ければ `basematerials` / `colorgroup`。`<part>` は components と同じ順に並ぶ前提で対応付ける（`<part>` の id は component の objectid と別物）
- 色の一覧は STL と同じく三角形ごとの番号で持ち、色パネル（色ごとの置き換え）は STL と共通

### webview への STL の渡し方

拡張側で読んだ STL のバイト列を `postMessage` で webview に渡す。Three.js は esbuild で `media/webview.js` に同梱しており、オフラインで動く。
