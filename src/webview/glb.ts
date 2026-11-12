// GLB（glTF 2.0 のバイナリ）の読み込み。KiCad の `kicad-cli pcb export glb` の出力を想定する。
// シーンのノードを親から順にたどって変換（TRS / matrix）を掛け合わせ、三角形のプリミティブを
// すべてワールド座標の非インデックス三角形にする。three には依存しない（Node でも動く）。
// 材質は baseColorFactor（リニア）だけを使い、sRGB の "#rrggbb" に直して三角形ごとに色の番号を付ける。
// alphaMode が "BLEND" の材質（KiCad ではレジスト）は本体に入れず、半透明で重ねる層として別に集める。
// 層（部品・シルク・レジスト・銅・基板・穴）は、ノード名と材質と高さから推定して三角形ごとに番号を付ける。
// テクスチャ・スキン・モーフ・Draco などの拡張は対象外（extensionsRequired があればエラー）。
import type { ThreeMfMesh } from './threemf';

const MAGIC_GLB = 0x46546c67;   // "glTF"（リトルエンディアン）
const CHUNK_JSON = 0x4e4f534a;  // "JSON"
const CHUNK_BIN = 0x004e4942;   // "BIN\0"
// 展開後の三角形数の上限（壊れたファイルやノードの使い回しで膨らんで固まらないように）
const MAX_TRIANGLES = 20_000_000;
const MAX_DEPTH = 64;
const DEFAULT_COLOR = '#ffffff'; // 材質なしのプリミティブ（glTF の既定 baseColor は白）

export interface GlbLayer { key: string; label: string; }
export interface GlbLayers {
  list: GlbLayer[];               // 表示する順（上から）。三角形が 1 つ以上ある層だけ
  face: Uint8Array;               // 本体の三角形ごとの層の番号（list の添字）
  overlayFace: Uint8Array | null; // 重ねる層の三角形ごとの層の番号（overlay が null なら null）
}

/** 本体（ThreeMfMesh）と、BLEND の材質だけを集めた重ねる層。重ねる層の faceColor も本体と同じ colors の番号を指す */
export type GlbMesh = ThreeMfMesh & {
  overlay: { positions: Float32Array; faceColor: Uint16Array; opacity: number } | null;
  layers: GlbLayers;
};

// 三角形の種別（層の番号を決める前の分類）
const K_PART = 0;
const K_MASK = 1;
const K_SILK = 2;
const K_HOLE = 3;
const K_COPPER = 4;
const K_BOARD = 5;
const COPPER_GAP = 0.05; // mm。銅の高さがこれ以上離れていれば別の層（銅箔の厚み 0.035 より大きく、層間の最小 0.1 より小さい。0.1 だと浮動小数の誤差で隣り合う層が繋がる）

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: unknown;
}
interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}
interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  materials?: { alphaMode?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number } }[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { byteLength: number; uri?: string }[];
}

/** 先頭 4 バイトが "glTF" なら GLB とみなす */
export function isGlb(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46;
}

// 4x4 行列は列優先（glTF と同じ）。out = a * b
function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function nodeMatrix(n: GltfNode): number[] {
  if (n.matrix && n.matrix.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  let [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  // T * R * S
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function linearToSrgbByte(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function toHex(factor: number[] | undefined): string {
  if (!factor || factor.length < 3) return DEFAULT_COLOR;
  const h = (c: number) => linearToSrgbByte(c).toString(16).padStart(2, '0');
  return `#${h(factor[0])}${h(factor[1])}${h(factor[2])}`;
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function parseGlb(data: Uint8Array): GlbMesh {
  if (!isGlb(data) || data.length < 20) throw new Error('GLB として読めません（ヘッダがありません）');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== MAGIC_GLB) throw new Error('GLB として読めません');
  if (view.getUint32(4, true) !== 2) throw new Error('対応していない GLB のバージョンです');
  const total = Math.min(view.getUint32(8, true), data.length);

  let json: Gltf | null = null;
  let bin: Uint8Array | null = null;
  for (let p = 12; p + 8 <= total;) {
    const len = view.getUint32(p, true);
    const type = view.getUint32(p + 4, true);
    const start = p + 8;
    if (start + len > data.length) throw new Error('GLB のチャンクが途中で切れています');
    if (type === CHUNK_JSON && !json) {
      try {
        json = JSON.parse(new TextDecoder().decode(data.subarray(start, start + len))) as Gltf;
      } catch {
        throw new Error('GLB の JSON が壊れています');
      }
    } else if (type === CHUNK_BIN && !bin) {
      bin = data.subarray(start, start + len);
    }
    p = start + ((len + 3) & ~3);
  }
  if (!json) throw new Error('GLB に JSON チャンクがありません');
  if (!bin) throw new Error('GLB に BIN チャンクがありません');
  if (json.extensionsRequired && json.extensionsRequired.length > 0) {
    throw new Error(`対応していない glTF 拡張です: ${json.extensionsRequired.join(', ')}`);
  }

  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];
  const binView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  // アクセサの範囲を検査して、要素 i の先頭バイト位置を返す関数にする
  const locate = (index: number, expectType: string) => {
    const acc = accessors[index];
    if (!acc || acc.bufferView === undefined) throw new Error('アクセサが読めません');
    const bv = bufferViews[acc.bufferView];
    const size = COMPONENT_SIZE[acc.componentType];
    const comps = TYPE_COUNT[acc.type];
    if (!bv || !size || !comps || acc.type !== expectType) throw new Error('対応していないアクセサです');
    if (acc.sparse !== undefined) throw new Error('sparse アクセサには対応していません');
    if (bv.buffer !== 0 || json!.buffers?.[0]?.uri !== undefined) {
      throw new Error('外部バッファを参照する glTF には対応していません');
    }
    const isNonNegInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    if (!isNonNegInt(acc.count)) throw new Error('アクセサの要素数が不正です');
    if (!isNonNegInt(bv.byteOffset ?? 0) || !isNonNegInt(acc.byteOffset ?? 0) || !isNonNegInt(bv.byteStride ?? 0)) {
      throw new Error('アクセサのオフセットまたはストライドが不正です');
    }
    const elem = size * comps;
    const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : elem;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    if (acc.count > 0 && base + stride * (acc.count - 1) + elem > bin!.byteLength) {
      throw new Error('アクセサが BIN の範囲を超えています');
    }
    return { acc, base, stride };
  };

  // 色（同じ hex は 1 つにまとめる）
  const colors: string[] = [];
  const colorIndex = new Map<string, number>();
  const materialColor = (m: number | undefined): number => {
    const hex = m === undefined ? DEFAULT_COLOR : toHex(json!.materials?.[m]?.pbrMetallicRoughness?.baseColorFactor);
    let i = colorIndex.get(hex);
    if (i === undefined) {
      if (colors.length >= 65536) throw new Error('材質の色が多すぎます');
      i = colors.length;
      colors.push(hex);
      colorIndex.set(hex, i);
    }
    return i;
  };

  // 出力は可変長なので、まず塊ごとに集めて最後に連結する
  // kinds は塊ごとの種別（K_*）
  interface Layer { chunks: Float32Array[]; faceChunks: number[]; kinds: number[]; triangles: number }
  const body: Layer = { chunks: [], faceChunks: [], kinds: [], triangles: 0 }; // faceChunks は塊ごとの [色番号, 三角形数] の並び
  const over: Layer = { chunks: [], faceChunks: [], kinds: [], triangles: 0 };
  const overAlpha = new Map<number, number>(); // BLEND 材質ごとの alpha（キーは材質番号）
  // BLEND 材質ごとの三角形数
  const overAlphaTris = new Map<number, number>();
  let triangles = 0; // 上限の判定用（両方の層の合計）

  // 材質から種別を決める（部品かどうかは呼び出し側で先に判定する）
  const materialKind = (mat: NonNullable<Gltf['materials']>[number] | undefined): number => {
    if (mat?.alphaMode === 'BLEND') return K_MASK;
    const f = mat?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1];
    const metal = (mat?.pbrMetallicRoughness?.metallicFactor ?? 1) >= 0.5;
    const [r, g, b] = [linearToSrgbByte(f[0]) / 255, linearToSrgbByte(f[1]) / 255, linearToSrgbByte(f[2]) / 255];
    if (!metal) return r >= 0.8 && g >= 0.8 && b >= 0.8 ? K_SILK : K_BOARD;
    return Math.max(r, g, b) - Math.min(r, g, b) < 0.1 ? K_HOLE : K_COPPER;
  };

  const emit = (prim: GltfPrimitive, m: number[], inPart: boolean) => {
    if ((prim.mode ?? 4) !== 4) return;
    const posIdx = prim.attributes?.POSITION;
    if (posIdx === undefined) return;
    const pos = locate(posIdx, 'VEC3');
    if (pos.acc.componentType !== 5126) throw new Error('POSITION が float ではありません');
    let idxRead: ((i: number) => number) | null = null;
    let count = pos.acc.count;
    if (prim.indices !== undefined) {
      const ix = locate(prim.indices, 'SCALAR');
      const ct = ix.acc.componentType;
      if (ct !== 5121 && ct !== 5123 && ct !== 5125) throw new Error('対応していないインデックス型です');
      count = ix.acc.count;
      idxRead = (i) => {
        const o = ix.base + ix.stride * i;
        return ct === 5121 ? binView.getUint8(o) : ct === 5123 ? binView.getUint16(o, true) : binView.getUint32(o, true);
      };
    }
    const tris = Math.floor(count / 3);
    if (tris === 0) return;
    triangles += tris;
    if (triangles > MAX_TRIANGLES) throw new Error(`三角形が多すぎます（${MAX_TRIANGLES.toLocaleString()} を超えます）`);
    const mat = prim.material === undefined ? undefined : json!.materials?.[prim.material];
    const blend = mat?.alphaMode === 'BLEND';
    const layer = blend ? over : body;
    const out = new Float32Array(tris * 9);
    for (let i = 0; i < tris * 3; i++) {
      const v = idxRead ? idxRead(i) : i;
      if (v >= pos.acc.count) throw new Error('インデックスが頂点数を超えています');
      const o = pos.base + pos.stride * v;
      const x = binView.getFloat32(o, true);
      const y = binView.getFloat32(o + 4, true);
      const z = binView.getFloat32(o + 8, true);
      // ワールド座標（メートル・Y 上向き）
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      // mm にして Z 上向きへ: (x, y, z) → (x, -z, y)
      out[i * 3] = wx * 1000;
      out[i * 3 + 1] = -wz * 1000;
      out[i * 3 + 2] = wy * 1000;
    }
    layer.chunks.push(out);
    layer.kinds.push(inPart ? K_PART : materialKind(mat));
    layer.faceChunks.push(materialColor(prim.material), tris);
    layer.triangles += tris;
    if (blend && prim.material !== undefined) {
      const a = mat?.pbrMetallicRoughness?.baseColorFactor?.[3];
      overAlpha.set(prim.material, typeof a === 'number' ? Math.min(1, Math.max(0, a)) : 1);
      overAlphaTris.set(prim.material, (overAlphaTris.get(prim.material) ?? 0) + tris);
    }
  };

  const visited = new Set<number>();
  const visit = (ni: number, parent: number[], depth: number, inPart: boolean) => {
    const node = nodes[ni];
    if (!node) throw new Error('存在しないノードを参照しています');
    if (depth > MAX_DEPTH) throw new Error('ノードの入れ子が深すぎます');
    // 同じノードを複数の親から参照すると展開が指数的に膨らむので禁止する（glTF の仕様でも木）
    if (visited.has(ni)) throw new Error('ノードが複数の親から参照されています');
    visited.add(ni);
    const m = mul(parent, nodeMatrix(node));
    // 名前が "=>" で始まらないノードの下は部品
    const part = inPart || (typeof node.name === 'string' && node.name !== '' && !node.name.startsWith('=>'));
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (!mesh) throw new Error('存在しないメッシュを参照しています');
      for (const prim of mesh.primitives ?? []) emit(prim, m, part);
    }
    for (const c of node.children ?? []) visit(c, m, depth + 1, part);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  // シーンの定義が無ければ、どこからも子にされていないノードを根とみなす
  let roots = scene?.nodes;
  if (!roots) {
    const child = new Set<number>();
    for (const n of nodes) for (const c of n.children ?? []) child.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  }
  for (const r of roots) visit(r, IDENTITY, 0, false);

  // 塊を連結して 1 つの配列にする
  const concat = (layer: Layer) => {
    const positions = new Float32Array(layer.triangles * 9);
    const faceColor = new Uint16Array(layer.triangles);
    let po = 0;
    let fo = 0;
    layer.chunks.forEach((c, k) => {
      positions.set(c, po);
      po += c.length;
      faceColor.fill(layer.faceChunks[k * 2], fo, fo + layer.faceChunks[k * 2 + 1]);
      fo += layer.faceChunks[k * 2 + 1];
    });
    return { positions, faceColor };
  };
  if (body.triangles === 0) throw new Error('GLB に三角形がありません');
  const { positions, faceColor } = concat(body);
  let overlay: GlbMesh['overlay'] = null;
  if (over.triangles > 0) {
    // 複数の BLEND 材質があれば、三角形数が最多の材質の alpha を使う
    let best = -1;
    let opacity = 1;
    for (const [m, n] of overAlphaTris) {
      if (n > best) {
        best = n;
        opacity = overAlpha.get(m) ?? 1;
      }
    }
    overlay = { ...concat(over), opacity };
  }
  const layers = assignLayers(body, over.triangles > 0 ? over : null);
  return { positions, colors, faceColor, overlay, layers };
}

// 三角形ごとに層の番号を付ける。表・裏は板の厚みの中央より上かどうか、銅は高さの固まりで分ける
function assignLayers(
  body: { chunks: Float32Array[]; kinds: number[] },
  over: { chunks: Float32Array[]; kinds: number[] } | null,
): GlbLayers {
  const sets = over ? [body, over] : [body];
  // 三角形の重心の高さ（Z）。chunk ごとに走査する
  // スルーホールのパッドの筒（板を貫く銅の壁）は三角形が厚み全体にまたがり、重心が厚みの途中に来て
  // 偽の銅の層になる。そこで 3 頂点の高さの範囲が TALL_COPPER 以上の銅は「穴・ビア」として扱い、
  // 固まり探しにも層の割り当てにも銅として使わない
  const TALL_COPPER = 0.1;
  const kindOf = (kind: number, c: Float32Array, o: number): number => {
    if (kind !== K_COPPER) return kind;
    const a = c[o + 2], b = c[o + 5], d = c[o + 8];
    return Math.max(a, b, d) - Math.min(a, b, d) >= TALL_COPPER ? K_HOLE : kind;
  };
  const eachTri = (fn: (kind: number, z: number) => void) => {
    for (const set of sets) {
      set.chunks.forEach((c, k) => {
        const kind = set.kinds[k];
        for (let o = 0; o < c.length; o += 9) fn(kindOf(kind, c, o), (c[o + 2] + c[o + 5] + c[o + 8]) / 3);
      });
    }
  };
  // 板の厚みの中央: 基板の三角形の最小と最大の中間。基板が無ければ部品以外全体
  let bMin = Infinity, bMax = -Infinity, aMin = Infinity, aMax = -Infinity;
  const copperZ: number[] = [];
  eachTri((kind, z) => {
    if (kind === K_PART) return;
    if (z < aMin) aMin = z;
    if (z > aMax) aMax = z;
    if (kind === K_BOARD) {
      if (z < bMin) bMin = z;
      if (z > bMax) bMax = z;
    }
    if (kind === K_COPPER) copperZ.push(z);
  });
  const mid = bMin <= bMax ? (bMin + bMax) / 2 : aMin <= aMax ? (aMin + aMax) / 2 : 0;

  // 銅の高さを並べ、COPPER_GAP 以上の隙間で区切る。cuts は固まりの境目の高さ（昇順）
  const sorted = Float64Array.from(copperZ).sort();
  const cuts: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] >= COPPER_GAP) cuts.push((sorted[i] + sorted[i - 1]) / 2);
  }
  const clusters = sorted.length === 0 ? 0 : cuts.length + 1;
  const nIn = Math.max(0, clusters - 2);
  // 順位（表示順）: 部品, シルク表, レジスト表, 銅表, 内層 1..nIn, 銅裏, レジスト裏, シルク裏, 基板, 穴
  const rParts = 0, rSilkF = 1, rMaskF = 2, rCuF = 3;
  const rCuB = 4 + nIn, rMaskB = 5 + nIn, rSilkB = 6 + nIn, rBoard = 7 + nIn, rHoles = 8 + nIn;
  const total = rHoles + 1;
  if (total > 255) throw new Error('層が多すぎます（255 を超えます）');
  const rankOf = (kind: number, z: number): number => {
    switch (kind) {
      case K_PART: return rParts;
      case K_SILK: return z > mid ? rSilkF : rSilkB;
      case K_MASK: return z > mid ? rMaskF : rMaskB;
      case K_HOLE: return rHoles;
      case K_BOARD: return rBoard;
      default: {
        if (clusters === 1) return z > mid ? rCuF : rCuB;
        // 下から数えた固まりの番号 → 上から数えた番号
        let lo = 0, hi = cuts.length;
        while (lo < hi) {
          const h = (lo + hi) >> 1;
          if (cuts[h] < z) lo = h + 1; else hi = h;
        }
        const fromTop = clusters - 1 - lo;
        return fromTop === 0 ? rCuF : fromTop === clusters - 1 ? rCuB : rCuF + fromTop;
      }
    }
  };
  const ranks = (set: { chunks: Float32Array[]; kinds: number[] }): Uint8Array => {
    let n = 0;
    for (const c of set.chunks) n += c.length / 9;
    const out = new Uint8Array(n);
    let i = 0;
    set.chunks.forEach((c, k) => {
      const kind = set.kinds[k];
      for (let o = 0; o < c.length; o += 9) out[i++] = rankOf(kindOf(kind, c, o), (c[o + 2] + c[o + 5] + c[o + 8]) / 3);
    });
    return out;
  };
  const faceRank = ranks(body);
  const overRank = over ? ranks(over) : null;

  // 三角形のある順位だけを list に入れ、順位を list の添字に直す
  const labels: GlbLayer[] = new Array<GlbLayer>(total);
  labels[rParts] = { key: 'parts', label: '部品' };
  labels[rSilkF] = { key: 'silkF', label: 'シルク（表）' };
  labels[rMaskF] = { key: 'maskF', label: 'レジスト（表）' };
  labels[rCuF] = { key: 'cuF', label: '銅（表）' };
  for (let k = 1; k <= nIn; k++) labels[rCuF + k] = { key: `cuIn${k}`, label: `銅（内層 ${k}）` };
  labels[rCuB] = { key: 'cuB', label: '銅（裏）' };
  labels[rMaskB] = { key: 'maskB', label: 'レジスト（裏）' };
  labels[rSilkB] = { key: 'silkB', label: 'シルク（裏）' };
  labels[rBoard] = { key: 'board', label: '基板' };
  labels[rHoles] = { key: 'holes', label: '穴・ビア' };
  const used = new Uint8Array(total);
  for (const r of faceRank) used[r] = 1;
  if (overRank) for (const r of overRank) used[r] = 1;
  const toIndex = new Uint8Array(total);
  const list: GlbLayer[] = [];
  for (let r = 0; r < total; r++) {
    if (!used[r]) continue;
    toIndex[r] = list.length;
    list.push(labels[r]);
  }
  for (let i = 0; i < faceRank.length; i++) faceRank[i] = toIndex[faceRank[i]];
  if (overRank) for (let i = 0; i < overRank.length; i++) overRank[i] = toIndex[overRank[i]];
  return { list, face: faceRank, overlayFace: overRank };
}
