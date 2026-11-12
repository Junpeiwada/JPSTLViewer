import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// 残す GLB の件数。1 枚 10MB 前後なので 20 件で 200MB ほど
const MAX_ENTRIES = 20;
// kicad.ts の書き出しの指定を変えたら上げる（前の指定で書き出したものを使わないように）
const FORMAT = 'glb-v1';

/**
 * kicad-cli が書き出した GLB のキャッシュ。基板ファイルの更新日時・大きさと、kicad-cli のパス・版が同じなら使い回す。
 * 部品の 3D モデルだけを差し替えた場合は気づけない（基板を保存し直せば日時が変わって書き出し直す）
 */
export class GlbCache {
  constructor(private readonly dir: string) {}

  /** 基板の今の状態に対応する鍵。基板が読めなければ undefined（キャッシュを使わない） */
  async key(pcb: string, cliPath: string, cliVersion: string): Promise<string | undefined> {
    try {
      const st = await fs.promises.stat(pcb);
      return createHash('sha1')
        .update([FORMAT, pcb, st.mtimeMs, st.size, cliPath, cliVersion].join('\n'))
        .digest('hex');
    } catch {
      return undefined;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const file = this.file(key);
    try {
      const data = new Uint8Array(await fs.promises.readFile(file));
      // 使った順に残すため、更新日時を今にする（失敗しても読めたものは使う）
      const now = new Date();
      await fs.promises.utimes(file, now, now).catch(() => {});
      return data;
    } catch {
      return undefined;
    }
  }

  /** 書き込みは一時ファイルから名前を変えて入れ、途中で落ちても壊れた GLB を残さない。失敗は無視する（キャッシュは無くても動く） */
  async put(key: string, data: Uint8Array): Promise<void> {
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file(key)}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, this.file(key));
      await this.prune();
    } catch {
      // 置けなくても表示には差し支えない
    }
  }

  /** 古いものから消して MAX_ENTRIES 件にする。書きかけの一時ファイルも 1 時間たったら消す */
  private async prune(): Promise<void> {
    const names = await fs.promises.readdir(this.dir);
    const entries: { file: string; mtime: number }[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const st = await fs.promises.stat(file).catch(() => undefined);
      if (!st) {
        continue;
      }
      if (name.endsWith('.tmp')) {
        if (Date.now() - st.mtimeMs > 60 * 60 * 1000) {
          await fs.promises.rm(file, { force: true }).catch(() => {});
        }
      } else if (name.endsWith('.glb')) {
        entries.push({ file, mtime: st.mtimeMs });
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(MAX_ENTRIES)) {
      await fs.promises.rm(e.file, { force: true }).catch(() => {});
    }
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.glb`);
  }
}
