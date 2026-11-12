import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// kicad-cli の `pcb export glb` は KiCad 8 から使える
const MIN_MAJOR_VERSION = 8;

export type KicadCli = { path: string; version: string };
export type KicadMissing = { missing: 'notFound' | 'tooOld'; version?: string };

const MAC_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** PATH の各フォルダから kicad-cli を探す（which / where に頼らず自分で見る） */
async function findInPath(): Promise<string | undefined> {
  const names = process.platform === 'win32' ? ['kicad-cli.exe'] : ['kicad-cli'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      if (await isFile(p)) {
        return p;
      }
    }
  }
  return undefined;
}

/** Windows の標準の入れ場所。版の番号が大きいフォルダを先にする */
async function findInProgramFiles(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }
  const root = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'KiCad');
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(root);
  } catch {
    return [];
  }
  dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return dirs.map((d) => path.join(root, d, 'bin', 'kicad-cli.exe'));
}

// kicad-cli のパスごとに版を覚える（exportGlb のたびに起動しないため）。取れたものだけ覚える
const versionCache = new Map<string, string>();

async function getVersion(cli: string): Promise<string | undefined> {
  const cached = versionCache.get(cli);
  if (cached) {
    return cached;
  }
  const version = await new Promise<string | undefined>((resolve) => {
    execFile(cli, ['version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
  if (version) {
    versionCache.set(cli, version);
  }
  return version;
}

/**
 * kicad-cli を探す。順番は 設定のパス → PATH → macOS 標準 → Windows 標準。
 * 設定のパスが空でないのに無いときは、設定の誤りに気づけるよう他を探さず notFound にする
 */
export async function findKicadCli(configured: string): Promise<KicadCli | KicadMissing> {
  let candidates: string[];
  if (configured.trim()) {
    candidates = [configured.trim()];
  } else {
    candidates = [];
    const inPath = await findInPath();
    if (inPath) {
      candidates.push(inPath);
    }
    if (process.platform === 'darwin') {
      candidates.push(MAC_CLI);
    }
    candidates.push(...(await findInProgramFiles()));
  }

  // 古い版の候補は覚えて次を探す（PATH の先頭が古くても、後ろに合う版があるかもしれない）
  let oldVersion: string | undefined;
  for (const p of candidates) {
    if (!(await isFile(p))) {
      continue;
    }
    const version = await getVersion(p);
    if (!version) {
      continue;
    }
    const major = parseInt(version, 10);
    if (!Number.isFinite(major)) {
      // 版を読めない候補は kicad-cli とは限らないので飛ばす
      continue;
    }
    if (major < MIN_MAJOR_VERSION) {
      oldVersion ??= version;
      continue;
    }
    return { path: p, version };
  }
  return oldVersion ? { missing: 'tooOld', version: oldVersion } : { missing: 'notFound' };
}

function abortError(): Error {
  const e = new Error('書き出しを中断しました');
  e.name = 'AbortError';
  return e;
}

// 書き出しの時間切れ。大きな基板でも 5 分かかれば異常とみなす
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000;
// 失敗時に見せる出力は末尾だけ残す（上限なしに溜めない）
const LOG_TAIL_BYTES = 16 * 1024;

/**
 * .kicad_pcb を GLB に書き出して中身を返す。出力は一時フォルダに作り、読んだらフォルダごと消す。
 * macOS の kicad-cli は成功時にも stderr にエラーらしい行を出すので、成否は終了コードと出力ファイルで決める
 */
export async function exportGlb(cli: string, pcb: string, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) {
    throw abortError();
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jpstlviewer-'));
  try {
    // mkdtemp を待つ間に中断されていたら、起動せずに終える
    if (signal.aborted) {
      throw abortError();
    }
    const out = path.join(dir, 'board.glb');
    // --include-pads / silkscreen / soldermask / inner-copper は KiCad 9 から。8 に渡すと未知の引数で失敗する
    const major = parseInt((await getVersion(cli)) ?? '', 10);
    const args = ['pcb', 'export', 'glb', '-f', '--include-tracks', '--include-zones'];
    if (Number.isFinite(major) && major >= 9) {
      args.push('--include-pads', '--include-silkscreen', '--include-soldermask', '--include-inner-copper');
    }
    args.push('-o', out, pcb);
    if (signal.aborted) {
      throw abortError();
    }
    const log = await new Promise<string>((resolve, reject) => {
      const child = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // setEncoding で多バイト文字が chunk の境目で切れないようにし、末尾だけ残す
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (stdout = (stdout + d).slice(-LOG_TAIL_BYTES)));
      child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-LOG_TAIL_BYTES)));
      // kill だけして、reject は close を待つ。子が終わる前に reject すると一時フォルダの削除が先に走る
      const onAbort = () => {
        child.kill();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, EXPORT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      child.on('error', (e) => {
        cleanup();
        reject(e);
      });
      child.on('close', (code) => {
        cleanup();
        if (signal.aborted) {
          reject(abortError());
        } else if (timedOut) {
          reject(new Error('書き出しが時間切れになりました'));
        } else if (code !== 0) {
          reject(new Error((stderr.trim() || stdout.trim()) || `kicad-cli が終了コード ${code} で終わりました`));
        } else {
          resolve(stderr.trim() || stdout.trim());
        }
      });
    });
    try {
      return new Uint8Array(await fs.promises.readFile(out));
    } catch {
      throw new Error(log || 'kicad-cli が GLB を出力しませんでした');
    }
  } finally {
    // 削除の失敗で本来のエラー（AbortError など）を上書きしない
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** kicad-cli と同じ KiCad の pcbnew を探す。見つからなければ undefined */
async function findPcbnew(cli: string | undefined): Promise<string | undefined> {
  if (!cli) {
    return undefined;
  }
  const dir = path.dirname(cli);
  if (process.platform === 'darwin') {
    // .../KiCad.app/Contents/MacOS/kicad-cli → .../KiCad.app/Contents/Applications/pcbnew.app
    const app = path.join(dir, '..', 'Applications', 'pcbnew.app');
    return (await fs.promises.stat(app).then((s) => s.isDirectory(), () => false)) ? app : undefined;
  }
  if (process.platform === 'win32') {
    const exe = path.join(dir, 'pcbnew.exe');
    return (await isFile(exe)) ? exe : undefined;
  }
  return undefined;
}

/** KiCad の pcbnew で開く。pcbnew が無ければ OS の既定のアプリで開く */
export async function openInKicad(cli: string | undefined, pcb: string): Promise<void> {
  const pcbnew = await findPcbnew(cli);
  if (pcbnew) {
    if (process.platform === 'darwin') {
      return launch('open', ['-a', pcbnew, pcb]);
    }
    return launch(pcbnew, [pcb]);
  }
  if (process.platform === 'darwin') {
    return launch('open', [pcb]);
  }
  if (process.platform === 'win32') {
    // cmd 経由だとファイル名の & などが解釈されるので、explorer に直接渡す
    return launch('explorer.exe', [pcb]);
  }
  return launch('xdg-open', [pcb]);
}
