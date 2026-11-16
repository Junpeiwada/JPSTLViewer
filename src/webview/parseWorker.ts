// 解析を画面の裏（Worker）で走らせる。重いファイルでも画面が固まらず、読み込み中の表示が動き続けるように。
// esbuild.mjs がこれを 1 本の JS に束ね、文字列として main.ts に埋め込む（main.ts が blob から起動する）
import { parseModel, transferables } from './parse';

export interface ParseRequest {
  id: number;
  data: Uint8Array;
  creaseAngle: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, data, creaseAngle } = e.data;
  try {
    const model = parseModel(data, creaseAngle);
    ctx.postMessage({ id, model }, transferables(model));
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
