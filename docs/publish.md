# Marketplace への公開手順

---

## 目次

- [公開前の確認](#公開前の確認)
- [通常の更新フロー（2回目以降）](#通常の更新フロー2回目以降)
  - [いちばん手軽（推奨）](#いちばん手軽推奨)
  - [大きめの変更のとき](#大きめの変更のとき)
  - [バージョンの目安（semver）](#バージョンの目安semver)
- [package.json のスクリプト](#packagejson-のスクリプト)
- [公開後の確認](#公開後の確認)
- [認証（トークン）について](#認証トークンについて)
  - [トークンの作り方](#トークンの作り方)
  - [トークンの使い方](#トークンの使い方)
- [トークンが切れたとき（90日ごと）](#トークンが切れたとき90日ごと)
  - [手順（Regenerate で延長）](#手順regenerate-で延長)
  - [一覧に `vsce-publish` が残っていない / 全部切れている場合](#一覧に-vsce-publish-が残っていない--全部切れている場合)
  - [メモ](#メモ)
- [ハマりどころ（今回の記録）](#ハマりどころ今回の記録)

---


VS Code Marketplace への公開・更新に関するメモ。

---

## 公開前の確認

- `package.json` の `version` を上げたか（Marketplace は同じ番号を拒否する）
- `npm run package` で VSIX を作り、`unzip -l jpstlviewer-<版>.vsix` で中身を見る。入るのは `package.json`・`readme.md`・`LICENSE.txt`・`ThirdPartyNotices.txt`・`images/icon.png`・`out/extension.js`・`media/webview.js`・`media/webview.css` だけ（スクリーンショットは `.vscodeignore` で外してある。README の画像は GitHub から読まれる）
- README の画像は相対パスで書き、`repository` の GitHub から表示される。**push してから公開する**（先に公開すると Marketplace の README の画像が切れる）
- 手元に `npm run install-local` で入れた版が公開版より新しいと、VSCode は公開版に切り替わらない。切り替えるときは手元の版をアンインストールしてから Marketplace から入れる

## 通常の更新フロー（2回目以降）

Marketplace は **同じバージョン番号での再公開を拒否する**ため、公開のたびにバージョンを上げる必要がある。

### いちばん手軽（推奨）

```sh
npm run publish:patch
```

- `package.json` の version を patch で自動更新（例: `0.2.0` → `0.2.1`）してから公開する
- バージョンを手で書き換える必要がない

### 大きめの変更のとき

`package.json` の `version` を手動で上げてから:

```sh
npm run publish
```

- minor / major を上げたいときはこちら
- `vsce publish minor` / `vsce publish major` 相当を使いたい場合は、その都度 `npx vsce publish minor` を直接実行してもよい

### バージョンの目安（semver）

| 種別 | 例 | 使いどころ |
|---|---|---|
| patch | 0.2.0 → 0.2.1 | バグ修正・軽微な変更 |
| minor | 0.2.0 → 0.3.0 | 機能追加（後方互換あり） |
| major | 0.2.0 → 1.0.0 | 破壊的変更 |

## package.json のスクリプト

```json
"publish": "vsce publish",
"publish:patch": "vsce publish patch"
```

- JPStartupPage と違い `activationEvents: ["*"]` を使っていないので `--allow-star-activation` は不要

## 公開後の確認

`vsce publish` が `DONE` を返してから、Marketplace 側の反映（検索・API・ページ表示）まで **数分〜十数分**のタイムラグがある。直後は 404 や `not found` になるが異常ではない。

- 公開ページ: https://marketplace.visualstudio.com/items?itemName=junpeiwada.jpstlviewer
- 管理画面: https://marketplace.visualstudio.com/manage/publishers/junpeiwada
- コマンドで確認: `npx vsce show junpeiwada.jpstlviewer`

## 認証（トークン）について

公開には Azure DevOps の Personal Access Token (PAT) が必要。

### トークンの作り方

1. https://aex.dev.azure.com/me を開く（`dev.azure.com` に直接行くと有料の Azure Portal 契約 `signup.azure.com` に誘導されるので注意。**カード登録を求められたら間違った経路**）
2. organization（`junpeiwada.visualstudio.com`）を選び、`https://dev.azure.com/junpeiwada/_usersSettings/tokens` を開く
3. **New Token** で以下を設定:
   - **Scopes**: 「Show all scopes」をクリック → **Marketplace** → **Manage** にチェック（これが必須。付け忘れると `Access Denied ... View user permissions` エラー）
   - **Organization**: `All accessible organizations`（※ 2026年12月1日以降は非対応予定。個別 org スコープ + Marketplace Manage でも可）
   - **Expiration**: 90日〜1年
4. 生成されたトークンをコピー（この画面を閉じると二度と表示されない）

### トークンの使い方

トークンは **ファイルに保存しない**。`vsce login` の対話プロンプト、または環境変数で渡す。

```sh
# 方法A: ログイン（以降キャッシュされる）
npx vsce login junpeiwada

# 方法B: その場だけ環境変数で渡す
export VSCE_PAT='<トークン>'
npm run publish:patch
```

- コピペ時に改行・空白が混入すると `Access Denied` になる。正常なトークンは 84 文字
- トークンが切れたら Azure DevOps のトークン画面で **Regenerate**（再生成）

## トークンが切れたとき（90日ごと）

PAT は有効期限（90日〜最長1年）が切れると公開時に `401` や `Access Denied` になる。その場合は再発行する。既存トークンの **Regenerate（再生成）** が一番早い。

### 手順（Regenerate で延長）

1. https://dev.azure.com/junpeiwada/_usersSettings/tokens を開く
   - もし `signup.azure.com`（カード登録画面）に飛ばされたら、先に https://aex.dev.azure.com/me → `junpeiwada.visualstudio.com` から入り直す
2. 一覧から `vsce-publish` トークンにチェックを入れる
3. 上部の **Regenerate** をクリック → 新しい有効期限を設定（90日など）
4. 表示された新しいトークン文字列をコピー（画面を閉じると二度と見えない）
5. 新トークンで再ログイン:
   ```sh
   npx vsce login junpeiwada
   ```
   プロンプトにトークンを貼り付ける（改行・空白が混入しないよう注意。正常なら 84 文字）
6. 通ったら通常どおり `npm run publish:patch` で公開

### 一覧に `vsce-publish` が残っていない / 全部切れている場合

新規に作り直す（このドキュメント上部「トークンの作り方」と同じ）:

- Scopes: **Marketplace → Manage** に必ずチェック
- Expiration: 90日〜1年
- 作成後 `npx vsce login junpeiwada`

### メモ

- 有効期限を最長の **1年** にしておくと再発行の頻度を減らせる（Regenerate 時に設定可能）
- トークンはファイルに保存しないこと（誤コミット・流出防止）
- 期限が近いと Azure DevOps から通知メールが届く

## ハマりどころ（今回の記録）

- `dev.azure.com` へのアクセスが `signup.azure.com`（有料の Azure インフラ契約・カード登録）に飛ばされる → `https://aex.dev.azure.com/me` から入ると回避できる
- PAT に **Marketplace: Manage** スコープが無いと認証は通っても公開できない
- `vsce show` は拡張が見つからなくても終了コード 0 を返すので、スクリプトで反映確認する場合は出力文字列で判定する
