import * as vscode from 'vscode';
import { exportGlb, findKicadCli, openInKicad as launchKicad, KicadCli, KicadMissing } from './kicad';
import { GlbCache } from './glbCache';

const VIEW_TYPE = 'jpstlviewer.preview';
const PCB_VIEW_TYPE = 'jpstlviewer.pcbPreview';
const KICAD_DOWNLOAD_URL = 'https://www.kicad.org/download/';
const STATE_KEY = 'jpstlviewer.look';
const FILES_KEY = 'jpstlviewer.files';
// 基板ごとの前回の書き出し時間（ms）。書き出し中の進み具合の見込みに使う
const EXPORT_MS_KEY = 'jpstlviewer.exportMs';
const MAX_EXPORT_MS = 100;
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
 * 見た目の設定。背景は全ファイル共通、材質・色・STL の色を使うか・STL の色の置き換え・基板の隠した層はファイルごとに覚える。
 * 初めて開くファイルは、最後に使った見た目で始める（STL の色の置き換えは引き継がない）
 */
interface Look {
  material: string;
  color: string;
  background: string;
  useStlColor: boolean;
  colorMap?: Record<string, string>;
  hiddenLayers?: string[];
}

type FileLook = Pick<Look, 'material' | 'color' | 'useStlColor' | 'colorMap' | 'hiddenLayers'>;

export function activate(context: vscode.ExtensionContext) {
  // 出力パネルの「JP STL Viewer」。3D が白くなる・消えるといった、後から再現しにくい不具合を追うためのログ
  const log = vscode.window.createOutputChannel('JP STL Viewer', { log: true });
  const provider = new StlPreviewProvider(context, log);
  context.subscriptions.push(
    log,
    // retainContextWhenHidden は使わない。裏のタブまで WebGL コンテキストと GPU メモリを持ち続けると、
    // webview 全体で共有するコンテキスト数の上限やメモリ不足で、表のタブの 3D が消えることがある。
    // 裏に回ると webview は破棄され、戻ると作り直される（視点と計測は webview の state から戻す）
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    // .kicad_pcb 用。同じ provider で開き、resolveCustomEditor が拡張子で流れを分ける
    vscode.window.registerCustomEditorProvider(PCB_VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
    }),
    // kicad-cli のパスの設定が変わったら、前に見つけたものを捨てて探し直す
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jpstlviewer.kicadCliPath')) {
        provider.resetKicadCli();
      }
    }),
    vscode.commands.registerCommand('jpstlviewer.probe', () => provider.probeVisible()),
    vscode.commands.registerCommand('jpstlviewer.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('開く STL / 3MF / KiCad 基板のファイルを選んでください');
        return;
      }
      vscode.commands.executeCommand('vscode.openWith', target, isPcbUri(target) ? PCB_VIEW_TYPE : VIEW_TYPE);
    }),
    vscode.commands.registerCommand('jpstlviewer.openInKicad', (uri?: vscode.Uri) => {
      const target = uri ?? activePcbUri();
      if (!target) {
        vscode.window.showWarningMessage('開く .kicad_pcb ファイルを選んでください');
        return;
      }
      return provider.openInKicad(target);
    }),
  );
}

export function deactivate() {}

function isPcbUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.kicad_pcb');
}

/** アクティブなタブが KiCad 基板のプレビューか .kicad_pcb のテキストなら、その uri */
function activePcbUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === PCB_VIEW_TYPE) {
    return input.uri;
  }
  const doc = vscode.window.activeTextEditor?.document.uri;
  return doc && isPcbUri(doc) ? doc : undefined;
}

/** kicad-cli の stderr から、画面に出す要点（末尾の数行）を取る。全文は出力パネルに出す */
function summarizeStderr(message: string): string {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-3).join(' / ');
  return tail.length > 300 ? `${tail.slice(0, 300)}…` : tail;
}

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
  private panelCount = 0;
  // 開いているパネル（コマンド「描画の状態をログに出す」で、表に出ているものに確認を頼むため）
  private readonly panels = new Set<vscode.WebviewPanel>();
  // 見つかった kicad-cli。書き出しのたびに探さないための控え。
  // 見つからなかった結果は控えない（KiCad をあとから入れても、開き直さずに拾えるように）
  private kicadCli: KicadCli | undefined;

  // 探索中の Promise。複数のパネルが同時に書き出しを始めても、探索を 1 回にまとめて共有する
  private findingCli: Promise<KicadCli | KicadMissing> | undefined;
  // 設定の変更で進める。探索中に変わったら、古い設定で見つけた結果を控えに書き戻さない
  private kicadCliEpoch = 0;

  resetKicadCli() {
    this.kicadCli = undefined;
    this.findingCli = undefined;
    this.kicadCliEpoch++;
  }

  private findCli(): Promise<KicadCli | KicadMissing> {
    if (this.kicadCli) {
      return Promise.resolve(this.kicadCli);
    }
    if (this.findingCli) {
      return this.findingCli;
    }
    const epoch = this.kicadCliEpoch;
    const configured = vscode.workspace.getConfiguration('jpstlviewer').get<string>('kicadCliPath', '');
    const finding = (async () => {
      try {
        const found = await findKicadCli(configured);
        // 見つからなかった結果は控えない（KiCad をあとから入れた場合に備える）
        if (epoch === this.kicadCliEpoch && 'path' in found) {
          this.kicadCli = found;
        }
        return found;
      } finally {
        if (epoch === this.kicadCliEpoch) {
          this.findingCli = undefined;
        }
      }
    })();
    this.findingCli = finding;
    return finding;
  }

  /** KiCad で開く。kicad-cli が見つからなくても、OS の既定のアプリで開く */
  async openInKicad(uri: vscode.Uri) {
    if (uri.scheme !== 'file') {
      vscode.window.showWarningMessage('KiCad で開けるのはローカルのファイルだけです');
      return;
    }
    try {
      const cli = await this.findCli();
      await launchKicad('path' in cli ? cli.path : undefined, uri.fsPath);
    } catch (err) {
      this.log.error(`KiCad で開けなかった: ${err}`);
      vscode.window.showErrorMessage(`KiCad で開けませんでした: ${err}`);
    }
  }

  /** 表に出ているパネルに、描き直して画面の色をログに出すよう頼む */
  probeVisible() {
    const visible = [...this.panels].filter((p) => p.visible);
    if (visible.length === 0) {
      this.log.info('描画の確認: 表に出ている JP STL Viewer がない');
    }
    for (const p of visible) {
      p.webview.postMessage({ type: 'probe' });
    }
    this.log.show(true);
  }

  private readonly glbCache: GlbCache;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.glbCache = new GlbCache(vscode.Uri.joinPath(context.globalStorageUri, 'glb').fsPath);
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.buildHtml(panel.webview, mediaRoot);

    const uri = document.uri;
    const isPcb = isPcbUri(uri);
    // 実行中の KiCad 書き出し。新しい書き出しの開始・裏に回る・閉じるで中断する
    let exporting: AbortController | undefined;
    const abortExport = () => {
      exporting?.abort();
      exporting = undefined;
    };
    let disposed = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReinit = 0;
    // webview が作り直される（隠れる・reinit・ready）たびに進める。前の webview 向けに走っていた読み込みを、
    // 新しい webview に届けない（届くと、戻したばかりの視点と計測を消してしまう）
    let generation = 0;
    let changedWhileHidden = false;
    // webview の個体の番号。ready と reinit のときだけ進める（裏に回るたびに進む generation とは別）。
    // 裏に回っても破棄されずに戻った webview は同じ番号のままなので、表示済みかどうかの判定に使える
    let webviewId = 0;
    // 基板の最初の load を届けた webview の番号。webview は最初の load の前の reload を捨てるので、
    // まだ届けていない個体では reload を load に読み替える（書き出しの中断・失敗・kicad-cli 不在の後の保存に備える）。
    // 表示済みの個体に load を送ると視点と計測が消えるので、届けた個体には必ず reload で送る
    let loadedWebview = -1;
    // ログの行頭に付ける「ファイル名#パネル番号」（同じファイルを複数開いても見分けられるように）
    const tag = `${uri.path.split('/').pop()}#${++this.panelCount}`;
    const log = (message: string) => this.log.info(`[${tag}] ${message}`);
    log(`開いた: ${uri.fsPath}`);
    this.panels.add(panel);

    // .kicad_pcb は kicad-cli で GLB に書き出して送る。書き出しは 10 秒ほどかかることがある
    const sendPcb = async (kind: 'load' | 'reload') => {
      const gen = generation;
      const target = webviewId;
      if (uri.scheme !== 'file') {
        panel.webview.postMessage({ type: 'error', message: 'KiCad 基板のプレビューはローカルのファイルだけ対応しています' });
        return;
      }
      // 新しい保存が来たら、書き出し中の古いものは捨てる
      abortExport();
      const ac = new AbortController();
      exporting = ac;
      const stale = () => disposed || gen !== generation || ac.signal.aborted;
      const clearStatus = () => {
        if (!stale()) {
          panel.webview.postMessage({ type: 'status', message: '' });
        }
      };
      try {
        const cli = await this.findCli();
        if (stale()) {
          log(`${kind} を中断（KiCad を探している間に替わった）`);
          return;
        }
        if ('missing' in cli) {
          log(`kicad-cli が使えない: ${cli.missing}${cli.version ? `（${cli.version}）` : ''}`);
          // 書き出し中の表示が残らないよう、案内を出す前に消す
          clearStatus();
          panel.webview.postMessage({ type: 'kicadMissing', reason: cli.missing, version: cli.version });
          return;
        }
        // GLB を webview に届ける。note はログに添える由来（キャッシュ・書き出し）
        const deliver = async (data: Uint8Array, note: string) => {
          // 作り直し中の新しい webview には ready より先に送らない（新しい側は ready → load で読み直すので失われない）
          if (target !== webviewId || !ready) {
            log(`${kind} を送らず（webview が替わった・まだ ready でない: 個体 ${target} → ${webviewId}）`);
            return;
          }
          // 種類は送る直前に決める（最初の load の送信待ちの間に始まった reload も、届いた後なら reload にする）
          const sendKind = loadedWebview === target ? 'reload' : 'load';
          const delivered = await panel.webview
            .postMessage({ type: sendKind, name: uri.path.split('/').pop(), data })
            .then(
              (ok) => ok,
              (e) => {
                log(`${sendKind} の送信で例外: ${e}`);
                return false;
              },
            );
          if (delivered) {
            loadedWebview = target;
          }
          log(`${sendKind} を送った: ${note}・${data.byteLength} バイト・世代 ${gen}${delivered ? '' : '・届かず'}`);
          clearStatus();
        };
        // 基板が前回の書き出しから変わっていなければ、残しておいた GLB を使う（書き出しは数十秒かかる）
        const cacheKey = await this.glbCache.key(uri.fsPath, cli.path, cli.version);
        if (stale()) {
          return;
        }
        const cached = cacheKey ? await this.glbCache.get(cacheKey) : undefined;
        if (stale()) {
          log(`${kind} を中断（キャッシュを読んでいる間に替わった）`);
          return;
        }
        if (cached) {
          await deliver(cached, 'キャッシュ');
          return;
        }
        // 前回この基板にかかった時間を添えて、webview に進み具合の見込みを出させる（kicad-cli は途中経過を出さない）
        const expectedMs = this.context.globalState.get<Record<string, number>>(EXPORT_MS_KEY)?.[uri.fsPath];
        panel.webview.postMessage({ type: 'status', message: 'KiCad で書き出し中…', expectedMs });
        for (let attempt = 0; attempt < 2; attempt++) {
          const started = Date.now();
          try {
            const data = await exportGlb(cli.path, uri.fsPath, ac.signal);
            const elapsed = Date.now() - started;
            // 中断されずに書き出せたものは、表示に使わなくても残す（すぐ開き直したときに使える）
            this.saveExportMs(uri.fsPath, elapsed);
            if (cacheKey) {
              void this.glbCache.put(cacheKey, data);
            }
            if (stale()) {
              log(`${kind} を破棄（書き出している間に替わった: 世代 ${gen} → ${generation}）`);
              return;
            }
            await deliver(data, `書き出し ${elapsed} ms・${attempt + 1} 回目`);
            return;
          } catch (err) {
            if ((err as Error)?.name === 'AbortError' || stale()) {
              log(`${kind} の書き出しを中断`);
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            log(`書き出しに失敗（${attempt + 1} 回目・${Date.now() - started} ms）: ${message}`);
            if (attempt === 0) {
              // 保存の途中のファイルを読んだ可能性があるので、少し置いて 1 回だけやり直す
              await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
              if (stale()) {
                log(`${kind} を中断（やり直しを待っている間に替わった）`);
                return;
              }
              continue;
            }
            this.log.error(`[${tag}] KiCad での書き出しに失敗しました:\n${message}`);
            this.log.show(true);
            clearStatus();
            panel.webview.postMessage({ type: 'error', message: `KiCad での書き出しに失敗しました: ${summarizeStderr(message)}` });
          }
        }
      } catch (err) {
        // findCli などが投げた場合。握りつぶすと未処理の拒否になり、画面も「書き出し中」のまま残る
        if (!stale()) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.error(`[${tag}] ${kind} で想定外のエラー: ${message}`);
          clearStatus();
          panel.webview.postMessage({ type: 'error', message: `KiCad 基板を読み込めませんでした: ${message}` });
        }
      } finally {
        if (exporting === ac) {
          exporting = undefined;
        }
      }
    };

    const send = (kind: 'load' | 'reload') => (isPcb ? sendPcb(kind) : sendFile(kind));

    const sendFile = async (kind: 'load' | 'reload') => {
      const gen = generation;
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        if (disposed || gen !== generation) {
          log(`${kind} を中断（webview が替わった: 世代 ${gen} → ${generation}）`);
          return;
        }
        try {
          const data = await vscode.workspace.fs.readFile(uri);
          if (gen !== generation) {
            log(`${kind} を破棄（読んでいる間に webview が替わった: 世代 ${gen} → ${generation}）`);
            return;
          }
          const complete = isCompleteFile(data);
          if (complete || attempt === RETRY_COUNT) {
            // readFile は Node の Buffer を返す。Buffer は toJSON を持つので、そのまま送ると
            // {type:'Buffer', data:[…]} に化ける。素の Uint8Array に写してから送る
            // 送信の失敗は読み直しで取り戻さない（catch に落ちると同じものを二度送ってしまう）
            const delivered = await panel.webview
              .postMessage({ type: kind, name: uri.path.split('/').pop(), data: new Uint8Array(data) })
              .then(
                (ok) => ok,
                (e) => {
                  log(`${kind} の送信で例外: ${e}`);
                  return false;
                },
              );
            log(`${kind} を送った: ${data.byteLength} バイト・${attempt + 1} 回目${complete ? '' : '（不完全なまま）'}・世代 ${gen}${delivered ? '' : '・届かず'}`);
            return;
          }
        } catch (err) {
          if (gen !== generation) {
            return;
          }
          if (attempt === RETRY_COUNT) {
            log(`読み込みに失敗: ${err}`);
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
      timer = setTimeout(() => {
        timer = undefined;
        send('reload');
      }, RELOAD_DEBOUNCE_MS);
    };

    // ワークスペース外のファイルも監視できるよう、親フォルダ＋ファイル名の相対パターンで張る
    const dir = vscode.Uri.joinPath(uri, '..');
    const name = uri.path.split('/').pop() ?? '';
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
    watcher.onDidChange(scheduleReload);
    watcher.onDidCreate(scheduleReload);

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (isPcb && e.affectsConfiguration('jpstlviewer.kicadCliPath')) {
        // 探し直しの捨ては activate 側の listener がする（先に登録されており、こちらの再読込は 250ms 後なので必ず後になる）。
        // 案内を出していた画面は書き出し直す。STL / 3MF のパネルは読み直さない
        scheduleReload();
      }
      if (e.affectsConfiguration('jpstlviewer')) {
        panel.webview.postMessage({ type: 'config', config: this.readConfig() });
      }
    });

    panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'log':
          log(`webview: ${msg.message}`);
          break;
        case 'ready':
          ready = true;
          generation++;
          webviewId++;
          log(`ready（世代 ${generation}・個体 ${webviewId}）`);
          changedWhileHidden = false;
          clearTimeout(timer);
          timer = undefined;
          panel.webview.postMessage({
            type: 'init',
            config: this.readConfig(),
            isPcb,
            look: { ...this.context.globalState.get<Look>(STATE_KEY), ...this.fileLooks()[uri.toString()] },
          });
          send('load');
          break;
        case 'openKicadDownload':
          vscode.env.openExternal(vscode.Uri.parse(KICAD_DOWNLOAD_URL));
          break;
        case 'openInKicad':
          this.openInKicad(uri);
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
          // 間隔の制限は自動の作り直しが繰り返すのを止めるためのもの。ボタンから頼まれたときは制限しない
          if (!msg.manual && Date.now() - lastReinit < REINIT_MIN_INTERVAL_MS) {
            log('reinit を断った（前回から間がない）');
            panel.webview.postMessage({ type: 'error', message: 'GPU の描画が戻りません。タブを閉じて開き直してください' });
            break;
          }
          log(`reinit: webview を作り直す${msg.manual ? '（ボタンから）' : ''}`);
          lastReinit = Date.now();
          ready = false;
          generation++;
          webviewId++;
          abortExport();
          clearTimeout(timer);
          timer = undefined;
          // buildHtml は毎回ちがう nonce を入れるので HTML が変わり、webview が読み込み直される
          panel.webview.html = this.buildHtml(panel.webview, mediaRoot);
          break;
      }
    });

    // 裏に回ると webview はふつう破棄され、戻ると作り直されて ready → load で読み直す。
    // 破棄されなかった場合に備え、隠れている間の変更は表に戻ったときに読み直す
    let wasVisible = panel.visible;
    panel.onDidChangeViewState(() => {
      if (panel.visible !== wasVisible) {
        wasVisible = panel.visible;
        log(panel.visible ? '表に出た' : '裏に回った');
      }
      if (!panel.visible) {
        // 保存の debounce 待ちや書き出し中だったなら、表に戻ったときにやり直す
        if (exporting || timer) {
          changedWhileHidden = true;
        }
        clearTimeout(timer);
        timer = undefined;
        generation++;
        abortExport();
      } else if (changedWhileHidden) {
        changedWhileHidden = false;
        scheduleReload();
      }
    });

    panel.onDidDispose(() => {
      log('閉じた');
      this.panels.delete(panel);
      disposed = true;
      abortExport();
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

  private saveExportMs(pcb: string, ms: number) {
    const all = { ...this.context.globalState.get<Record<string, number>>(EXPORT_MS_KEY) };
    // 消してから入れ直して、挿入順＝最近使った順にする
    delete all[pcb];
    all[pcb] = ms;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_EXPORT_MS))) {
      delete all[old];
    }
    this.context.globalState.update(EXPORT_MS_KEY, all);
  }

  private fileLooks(): Record<string, FileLook> {
    return this.context.globalState.get<Record<string, FileLook>>(FILES_KEY) ?? {};
  }

  private saveLook(uri: vscode.Uri, look: Look) {
    // STL の色の置き換えと基板の隠した層はそのファイルだけのもの。ほかのファイルに引き継がないよう共通の見た目には入れない
    const { colorMap, hiddenLayers, ...shared } = look;
    this.context.globalState.update(STATE_KEY, shared);
    const files = this.fileLooks();
    const key = uri.toString();
    // 消してから入れ直して、挿入順＝最近使った順にする
    delete files[key];
    files[key] = { material: look.material, color: look.color, useStlColor: look.useStlColor, colorMap: colorMap ?? {}, hiddenLayers: hiddenLayers ?? [] };
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
      periodicRedraw: c.get<boolean>('periodicRedraw', true),
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
