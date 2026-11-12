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
  - [KiCad 基板の読み方](#kicad-基板の読み方)
  - [webview への STL の渡し方](#webview-への-stl-の渡し方)
  - [裏のタブと GPU コンテキスト](#裏のタブと-gpu-コンテキスト)
  - [ログ（出力パネル「JP STL Viewer」）](#ログ出力パネルjp-stl-viewer)

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

### KiCad 基板の読み方

`.kicad_pcb` は自前で解釈せず、kicad-cli（KiCad 8 以降）で GLB に書き出して読む。

- 書き出し: `kicad-cli pcb export glb -f --include-tracks --include-pads --include-zones --include-silkscreen --include-soldermask -o <一時ファイル> <pcb>`。全部入りで 10 秒ほどかかり、14MB・32 万三角形ほどになることがある。`fs.mkdtemp` の一時フォルダに書き出して読み、フォルダごと消す。新しい保存が来たら書き出し中のものを中断する。KiCad 8 の `pcb export glb` には `--include-pads` / `--include-silkscreen` / `--include-soldermask` が無いので、KiCad 9 以降のときだけこの 3 つを付ける（8 ではパターンとベタだけで、パッド・シルク・レジストは入らない）
- 保存の完了は判定せず（`isCompleteFile` は使わない）、書き出しに失敗したら 1 回だけ間を置いて書き出し直す
- キャッシュ（`src/glbCache.ts`）: 書き出した GLB を `globalStorageUri/glb/<sha1>.glb` に残す。鍵は書式の版（`FORMAT`）・基板のパス・更新日時・大きさ・kicad-cli のパスと版。使った順に 20 件まで。`kicad.ts` の書き出しの指定を変えたら `FORMAT` を上げる。部品の 3D モデルだけの差し替えには気づかない
- 進み具合: kicad-cli は途中経過を出さない（測った限り、v2 基板で約 23 秒のうち起動と板で約 6 秒、残りは銅の形作り）。基板ごとの前回の書き出し時間を globalState（`jpstlviewer.exportMs`）に覚えて `status` に `expectedMs` として添え、webview が経過秒数と見込みのバーを出す
- kicad-cli の探し方: 設定 `jpstlviewer.kicadCliPath` → PATH → macOS の `/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli` → Windows の `C:\Program Files\KiCad\*\bin\kicad-cli.exe`。無ければ案内とダウンロードボタン、`kicad-cli version` が 8 未満なら更新の案内を出す
- GLB は `src/webview/glb.ts` の自前の同期パーサで読む。GLTFLoader は非同期で、今の同期の読み込みと再読込の順序制御を崩すので使わない
- GLB は単位がメートル・Y 上向き。読むときに mm（×1000）・Z 上向き（`(x, y, z) → (x, -z, y)`）へ直す
- ノードの TRS / `matrix` を親から掛け合わせ、三角形のプリミティブをすべて 1 つの非インデックスのメッシュにまとめる。材質の `baseColorFactor`（リニア）を sRGB の `#rrggbb` に直し、三角形ごとの色番号にする（3MF と同じ色の流れなので、色の置き換え・計測・材質プリセットはそのまま使える）
- レジスト（`alphaMode` が `BLEND` の材質。alpha は 0.83 ほど）だけは本体に入れず、`GlbMesh.overlay` として別に集め、半透明（`transparent`・`depthWrite: false`・影なし）のメッシュを本体の子として重ねる。不透明にすると下の銅の配線が全部隠れるため。色の一覧は本体と共有する。不透明度はファイルの alpha ではなく `Look.maskOpacity`（既定 0.6、ライトのパネルの「レジストの濃さ」、全ファイル共通。重ねる層があるときだけ表示。「既定に戻す」では戻さない）を使う。表の銅とレジストは 15 µm しか違わず深度の分解能（12 µm 前後）で銅が勝つため、`polygonOffset`（factor -1・units -4）でカメラ側へ寄せている。計測は `intersectObject(model, false)` で本体だけに当たる
- 層の判定: GLB には KiCad の層名が入らないので、`glb.ts` が三角形ごとに層を推定して `GlbMesh.layers`（`list` は表示する層、`face` / `overlayFace` は三角形ごとの層の番号）に入れる。部品はノード名、ほかは材質と高さで推定する。銅は高さの固まりで分け、内層（KiCad 9 以降）まで別の層にする
- 層の表示・非表示はインデックスの張り替えで行う（`main.ts` の `applyLayerVisibility`）。ジオメトリは作り直さず、見せる三角形の頂点番号だけの `Uint32Array` を本体と overlay に `setIndex` し、何も隠さないときは `setIndex(null)`。`toCreasedNormals` は三角形の順を保つので `face` の番号をそのまま使える。計測はインデックスに従うので見えている層にだけ当たる（`measure.ts` は変えていない）。隠した層は `Look.hiddenLayers`（層の key の一覧）でファイルごとに保存し、再読込で層の並びが変わっても key で引くので保たれる。STL / 3MF では「層」ボタンを出さず、インデックスも張らない
- `.kicad_pcb` 用のカスタムエディタ `jpstlviewer.pcbPreview` は priority `option`。ダブルクリックはテキストのままで、右クリックの「JP STL Viewer: STL / 3MF / KiCad 基板をプレビューで開く」か「Open With…」→「JP STL Viewer（KiCad 基板）」で開く

### webview への STL の渡し方

拡張側で読んだ STL のバイト列を `postMessage` で webview に渡す。Three.js は esbuild で `media/webview.js` に同梱しており、オフラインで動く。

### 裏のタブと GPU コンテキスト

`retainContextWhenHidden` は使わない。裏のタブも WebGL コンテキストと GPU メモリ（影・MSAA・GTAO・環境マップ）を持ち続けると、webview 全体で共有するコンテキスト数の上限やメモリ不足で、表のタブの 3D だけが消える（ツールは残る）ことがある。
裏に回ると webview は破棄され、戻ると作り直してファイルを読み直す。視点（カメラ・注視点・上方向）と計測の線は `vscode.setState` に覚えておき、作り直したときに戻す。

それでもコンテキストを失ったとき（GPU のリセットなど）は、three の自動復帰を待ち、戻ったら PMREM の環境マップを焼き直して描き直す。3 秒たっても戻らなければ webview が `reinit` を送り、拡張が HTML を入れ直して作り直す（作り直しは 10 秒に 1 回まで）。

### ログ（出力パネル「JP STL Viewer」）

3D が白くなる・消えるといった、後から再現しにくい不具合を追うために、出力パネルの「JP STL Viewer」にログを書く。行頭の `[ファイル名#番号]` でパネルを見分ける。

- 拡張側：開いた・閉じた・表に出た／裏に回った・ready（世代）・load / reload を送った（バイト数・何回目・世代）・世代が替わって中断／破棄した・reinit
- webview 側（`log` メッセージで拡張に送る）：起動（GPU 名・画素比）・受け取った読み込み・視点の復元・コンテキストの喪失／復帰・エラー
- 描画の確認：10 秒ごと（と表に戻ったとき・フォーカスを得たとき・読み込みのあと）に描き直し、描いた直後の画面の中央と左上の隅の色を `readPixels` で読んで、前回と変わったときだけ書く。白くなったとき、ここが白（255 近く）なら「描いた結果が白い」、白でなければ「描いた結果は正しいのに画面が白い（合成側の問題）」と見分けられる。値はトーンマップ後なので、正常な背景も `#dfe2e7` そのままではない
- 行には理由（定期・表示・フォーカス・読み込み・手動）と前回の描画からの経過時間を付ける。定期のときは前回と変わったときだけ、それ以外は必ず書く
- 表示中に描画ループ（requestAnimationFrame）が 2 秒以上止まっていたら書く。画素比の変化（ディスプレイをまたいだとき）も書く
- 白いときはコマンド「JP STL Viewer: 描画の状態をログに出す」で手動の確認を書かせる。定期の描き直しは設定 `jpstlviewer.periodicRedraw` で切れる（切ると白い状態が残り、原因を調べやすい）
