import * as vscode from 'vscode';

const VIEW_TYPE = 'jpstlviewer.preview';
const STATE_KEY = 'jpstlviewer.look';
const FILES_KEY = 'jpstlviewer.files';
// ファイルごとの見た目を覚えておく件数の上限（古いものから捨てる）
const MAX_FILE_LOOKS = 500;

// ファイルの書き込み途中に読むと壊れたファイルを渡してしまうので、変更通知から少し待つ
const RELOAD_DEBOUNCE_MS = 250;
// 読んだ内容が不完全だったときに読み直すまでの間隔と回数
const RETRY_INTERVAL_MS = 400;
const RETRY_COUNT = 5;
// GPU の描画が戻らないときの webview の作り直しは、この間隔に 1 回まで（失い続ける環境で作り直しを繰り返さない）
const REINIT_MIN_INTERVAL_MS = 10000;

/**
 * 見た目の設定。背景は全ファイル共通、材質・色・STL の色を使うか・STL の色の置き換えはファイルごとに覚える。
 * 初めて開くファイルは、最後に使った見た目で始める（STL の色の置き換えは引き継がない）
 */
interface Look {
  material: string;
  color: string;
  background: string;
  useStlColor: boolean;
  colorMap?: Record<string, string>;
}

type FileLook = Pick<Look, 'material' | 'color' | 'useStlColor' | 'colorMap'>;

export function activate(context: vscode.ExtensionContext) {
  const provider = new StlPreviewProvider(context);
  context.subscriptions.push(
    // retainContextWhenHidden は使わない。裏のタブまで WebGL コンテキストと GPU メモリを持ち続けると、
    // webview 全体で共有するコンテキスト数の上限やメモリ不足で、表のタブの 3D が消えることがある。
    // 裏に回ると webview は破棄され、戻ると作り直される（視点と計測は webview の state から戻す）
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('jpstlviewer.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('開く STL / 3MF ファイルを選んでください');
        return;
      }
      vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

export function deactivate() {}

/**
 * バイナリ STL はヘッダの三角形数とファイル長が一致するかで「書き込み完了」を判定できる。
 * ASCII STL は末尾の endsolid の有無で判定する。3MF（ZIP）は ZIP の終端で判定する。
 */
function isCompleteFile(data: Uint8Array): boolean {
  if (isZip(data)) {
    return isCompleteZip(data);
  }
  if (data.byteLength < 84) {
    return false;
  }
  const head = new TextDecoder().decode(data.subarray(0, 5)).toLowerCase();
  const tail = new TextDecoder().decode(data.subarray(Math.max(0, data.byteLength - 256))).toLowerCase();
  if (head === 'solid' && tail.includes('endsolid')) {
    return true;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const triangles = view.getUint32(80, true);
  return 84 + triangles * 50 === data.byteLength;
}

/** 3MF（ZIP）の判定。webview 側（threemf.ts の isZip）にも同じ判定がある */
function isZip(data: Uint8Array): boolean {
  return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/**
 * 3MF は ZIP。ZIP は末尾に中央ディレクトリ終端（"PK\x05\x06"＋固定 18 バイト＋コメント）を書いて終わるので、
 * それが末尾にそろっていれば書き込み完了とみなす
 */
function isCompleteZip(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // コメントは最大 65535 バイト
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === data.byteLength) {
      return true;
    }
  }
  return false;
}

class StlPreviewProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.buildHtml(panel.webview, mediaRoot);

    const uri = document.uri;
    let disposed = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReinit = 0;
    // webview が作り直される（隠れる・reinit・ready）たびに進める。前の webview 向けに走っていた読み込みを、
    // 新しい webview に届けない（届くと、戻したばかりの視点と計測を消してしまう）
    let generation = 0;
    let changedWhileHidden = false;

    const send = async (kind: 'load' | 'reload') => {
      const gen = generation;
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        if (disposed || gen !== generation) {
          return;
        }
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          if (gen !== generation) {
            return;
          }
          if (isCompleteFile(data) || attempt === RETRY_COUNT) {
            // readFile は Node の Buffer を返す。Buffer は toJSON を持つので、そのまま送ると
            // {type:'Buffer', data:[…]} に化ける。素の Uint8Array に写してから送る
            panel.webview.postMessage({ type: kind, name: uri.path.split('/').pop(), data: new Uint8Array(data) });
            return;
          }
        } catch (err) {
          if (gen !== generation) {
            return;
          }
          if (attempt === RETRY_COUNT) {
            panel.webview.postMessage({ type: 'error', message: `読み込みに失敗しました: ${err}` });
            return;
          }
        }
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }
    };

    const scheduleReload = () => {
      if (!ready) {
        return;
      }
      if (!panel.visible) {
        // 隠れている間は読まず、表に戻ったときにまとめて読み直す
        changedWhileHidden = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => send('reload'), RELOAD_DEBOUNCE_MS);
    };

    // ワークスペース外のファイルも監視できるよう、親フォルダ＋ファイル名の相対パターンで張る
    const dir = vscode.Uri.joinPath(uri, '..');
    const name = uri.path.split('/').pop() ?? '';
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
    watcher.onDidChange(scheduleReload);
    watcher.onDidCreate(scheduleReload);

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jpstlviewer')) {
        panel.webview.postMessage({ type: 'config', config: this.readConfig() });
      }
    });

    panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ready':
          ready = true;
          generation++;
          changedWhileHidden = false;
          clearTimeout(timer);
          panel.webview.postMessage({
            type: 'init',
            config: this.readConfig(),
            look: { ...this.context.globalState.get<Look>(STATE_KEY), ...this.fileLooks()[uri.toString()] },
          });
          send('load');
          break;
        case 'look':
          this.saveLook(uri, msg.look as Look);
          break;
        case 'copyColor':
          this.copyColor(uri, msg.color as string);
          break;
        case 'copyStlColors':
          this.copyStlColors(uri, msg.colors as { from: string; to: string }[]);
          break;
        case 'reinit':
          // GPU の描画が戻らない。HTML を入れ直して webview を作り直す（作り直した側がまた ready を送ってくる）
          if (Date.now() - lastReinit < REINIT_MIN_INTERVAL_MS) {
            panel.webview.postMessage({ type: 'error', message: 'GPU の描画が戻りません。タブを閉じて開き直してください' });
            break;
          }
          lastReinit = Date.now();
          ready = false;
          generation++;
          clearTimeout(timer);
          // buildHtml は毎回ちがう nonce を入れるので HTML が変わり、webview が読み込み直される
          panel.webview.html = this.buildHtml(panel.webview, mediaRoot);
          break;
      }
    });

    // 裏に回ると webview はふつう破棄され、戻ると作り直されて ready → load で読み直す。
    // 破棄されなかった場合に備え、隠れている間の変更は表に戻ったときに読み直す
    panel.onDidChangeViewState(() => {
      if (!panel.visible) {
        clearTimeout(timer);
        generation++;
      } else if (changedWhileHidden) {
        changedWhileHidden = false;
        scheduleReload();
      }
    });

    panel.onDidDispose(() => {
      disposed = true;
      clearTimeout(timer);
      watcher.dispose();
      configListener.dispose();
    });
  }

  /** AI に「このパーツをこの色に」と頼めるよう、ファイルの場所と色を 1 行にしてコピーする */
  private async copyColor(uri: vscode.Uri, color: string) {
    const hex = color.toLowerCase();
    const n = parseInt(hex.slice(1), 16);
    const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    const path = vscode.workspace.asRelativePath(uri, false);
    await vscode.env.clipboard.writeText(`${path} の色: ${hex}（RGB ${rgb}）`);
    vscode.window.setStatusBarMessage(`色をコピーしました: ${hex}`, 3000);
  }

  /** STL の色ごとの置き換えをコピーする。変えた色があれば「元 → 新」、無ければ STL の色の一覧 */
  private async copyStlColors(uri: vscode.Uri, colors: { from: string; to: string }[]) {
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `RGB ${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
    };
    const path = vscode.workspace.asRelativePath(uri, false);
    const changed = colors.filter((c) => c.from !== c.to);
    const text = changed.length
      ? [`${path} の色の変更:`, ...changed.map((c) => `${c.from} → ${c.to}（${rgb(c.to)}）`)].join('\n')
      : [`${path} の色:`, ...colors.map((c) => `${c.from}（${rgb(c.from)}）`)].join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(changed.length ? `色の変更をコピーしました（${changed.length} 色）` : '色の一覧をコピーしました', 3000);
  }

  private fileLooks(): Record<string, FileLook> {
    return this.context.globalState.get<Record<string, FileLook>>(FILES_KEY) ?? {};
  }

  private saveLook(uri: vscode.Uri, look: Look) {
    // STL の色の置き換えはそのファイルだけのもの。ほかのファイルに引き継がないよう共通の見た目には入れない
    const { colorMap, ...shared } = look;
    this.context.globalState.update(STATE_KEY, shared);
    const files = this.fileLooks();
    const key = uri.toString();
    // 消してから入れ直して、挿入順＝最近使った順にする
    delete files[key];
    files[key] = { material: look.material, color: look.color, useStlColor: look.useStlColor, colorMap: colorMap ?? {} };
    const keys = Object.keys(files);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_FILE_LOOKS))) {
      delete files[old];
    }
    this.context.globalState.update(FILES_KEY, files);
  }

  private readConfig() {
    const c = vscode.workspace.getConfiguration('jpstlviewer');
    return {
      creaseAngle: c.get<number>('creaseAngle', 30),
      floatRatio: c.get<number>('floatRatio', 0.05),
    };
  }

  private buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<!-- 画面の部品は webview.js 側で組み立てる（HTML と JS の版ずれで壊れないように） -->
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
