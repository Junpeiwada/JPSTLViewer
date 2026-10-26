// 3MF の読み込み。three の 3MFLoader は別ファイルの部品（Production 拡張の p:path）を
// オブジェクト番号だけで引くので番号が重なると崩れ、Bambu Studio の色（フィラメント）も取れない。
// 必要な分だけ自前で読み、三角形を並べた座標と三角形ごとの色の番号を返す。
// .model は数 MB・数十万要素になるので DOM に組み立てず、文字列を正規表現で走査する。
// そのため属性値の中の「>」や CDATA は扱えない（3MF を書き出すツールはまず使わない）。
// 対応する Production 拡張は、ルートのモデルから p:path で別の .model を引くところまで（単位はルートのものを使う）。
import { unzipSync } from 'three/addons/libs/fflate.module.js';

export interface ThreeMfMesh {
  positions: Float32Array;          // 三角形ごとに 3 頂点（mm、3MF の座標のまま Z 上向き）
  colors: string[] | null;          // 色の一覧（"#rrggbb"）。色が無ければ null
  faceColor: Uint16Array;           // 三角形ごとの colors の番号
}

const ROOT_MODEL = '3D/3dmodel.model';
const NO_COLOR = '#9a9a9a'; // 色の付いていない面（一部の面にだけ色があるとき）
// 展開後の三角形数の上限。部品を何重にも使い回すファイルで、展開が膨らんで固まらないように
const MAX_TRIANGLES = 20_000_000;

// 3MF の単位を mm に直す倍率
const UNIT_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** ZIP の先頭（ローカルファイルヘッダ "PK\x03\x04"）なら 3MF とみなす。拡張側（extension.ts）にも同じ判定がある */
export function isZip(data: Uint8Array): boolean {
  return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** アフィン変換。列ベクトルに掛ける 3×4 を行優先で 12 要素 */
type Mat = number[];
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** 3MF の transform（"m00 m01 m02 m10 … m32"、行ベクトルに右から掛ける 4×3）を Mat に直す */
function parseTransform(s: string | undefined): Mat {
  if (!s) {
    return IDENTITY;
  }
  const m = s.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || m.some((v) => !Number.isFinite(v))) {
    return IDENTITY;
  }
  return [m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11]];
}

/** a の後に b を掛ける（親 a の中に子 b を置く） */
function mul(a: Mat, b: Mat): Mat {
  const r = new Array<number>(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + (j === 3 ? a[i * 4 + 3] : 0);
    }
  }
  return r;
}

type Attrs = Record<string, string>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** タグの中の属性を読む（接頭辞つきの名前もそのまま。p:path など） */
function attrs(s: string): Attrs {
  const out: Attrs = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = (m[2] ?? m[3]).replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]);
  }
  return out;
}

/** XML のコメントを取り除く（コメントアウトされた要素を拾わないように） */
function stripComments(s: string): string {
  return s.includes('<!--') ? s.replace(/<!--[\s\S]*?-->/g, '') : s;
}

/** 開始タグ（自己終了も）を名前で集める。名前空間の接頭辞は問わない */
function tags(s: string, name: string): Attrs[] {
  return Array.from(s.matchAll(new RegExp(`<(?:\\w+:)?${name}\\b([^>]*)>`, 'g')), (m) => attrs(m[1]));
}

/** 中身のある要素を名前で集める（入れ子にならない要素だけに使う） */
function blocks(s: string, name: string): { attrs: Attrs; body: string }[] {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, 'g');
  return Array.from(s.matchAll(re), (m) => ({ attrs: attrs(m[1]), body: m[2] ?? '' }));
}

/** オブジェクトの形（ローカル座標）。インスタンスごとに読み直さないよう覚えておく */
interface MeshData {
  vertices: Float32Array;
  triangles: Uint32Array;
  faceColor: (string | null)[] | null; // 三角形ごとに材質が指定されていればその色
}

interface ObjectData {
  attrs: Attrs;
  body: string;
  mesh?: MeshData;
}

/** 1 つの .model ファイルの中のオブジェクトと材質 */
interface ModelPart {
  objects: Map<string, ObjectData>;
  materials: Map<string, string[]>; // pid → 番号ごとの色（basematerials / colorgroup）
}

/** 色付きで並べる三角形の受け皿 */
class Collector {
  positions: number[] = [];
  faceColor: number[] = [];
  colors: string[] = []; // '' は色の付いていない面
  private index = new Map<string, number>();

  colorIndex(hex: string | null): number {
    const key = hex ?? '';
    let k = this.index.get(key);
    if (k === undefined) {
      k = this.colors.length;
      this.index.set(key, k);
      this.colors.push(key);
    }
    return k;
  }
}

export function parse3mf(data: Uint8Array): ThreeMfMesh {
  // サムネイルやスライス済みの G-code（数十 MB になる）は展開しない
  const zip = unzipSync(data, { filter: (f) => /\.(model|rels|config)$/i.test(f.name) });
  const decoder = new TextDecoder();
  const text = (path: string): string | null => {
    const bytes = zip[path.replace(/^\//, '')];
    return bytes ? decoder.decode(bytes) : null;
  };
  const xml = (path: string): string | null => {
    const t = text(path);
    return t === null ? null : stripComments(t);
  };

  const rootPath = zip[ROOT_MODEL] ? ROOT_MODEL : findRootModel(xml);
  const rootText = rootPath ? xml(rootPath) : null;
  if (!rootPath || !rootText) {
    throw new Error('3MF の中にモデル（3D/3dmodel.model）が見つかりません');
  }

  const parts = new Map<string, ModelPart>();
  const loadPart = (path: string): ModelPart | null => {
    const key = path.replace(/^\//, '');
    if (!parts.has(key)) {
      const src = xml(key);
      if (!src) {
        return null;
      }
      parts.set(key, parseModel(src));
    }
    return parts.get(key)!;
  };

  const root = loadPart(rootPath)!;
  const model = tags(rootText, 'model')[0] ?? {};
  const unit = UNIT_MM[model.unit ?? 'millimeter'] ?? 1;
  const bambu = readBambuColors(text, xml);
  const out = new Collector();

  /**
   * オブジェクトを座標変換 m で展開する。color は親から引き継ぐ色。
   * fixed は color が Bambu のフィラメント色で決まっていること（3MF の材質より優先する）。
   * bambuParts は Bambu の部品ごとの色と種類
   */
  const emit = (part: ModelPart, id: string, m: Mat, color: string | null, fixed: boolean, bambuParts: BambuPart[] | null, depth: number) => {
    const obj = part.objects.get(id);
    // support / solidsupport / other は形ではない（type が無ければ model）
    if (!obj || depth > 16 || (obj.attrs.type ?? 'model') !== 'model') {
      return;
    }
    const objColor = fixed ? color : materialColor(part, obj.attrs.pid, obj.attrs.pindex) ?? color;
    if (/<(?:\w+:)?mesh\b/.test(obj.body)) {
      obj.mesh ??= parseMesh(part, obj);
      emitMesh(obj.mesh, m, objColor, fixed, out);
      return;
    }
    tags(obj.body, 'component').forEach((c, i) => {
      // model_settings.config の <part> は components と同じ順に書かれる。part の id はオブジェクト内の
      // 連番で component の objectid とは別物（同じ番号でも別の部品を指す）なので、番号ではなく順で引く
      const bp = bambuParts?.[i];
      // モディファイア・負の体積・サポートの指定などは形ではないので描かない
      if (bp && bp.subtype !== 'normal_part') {
        return;
      }
      const target = c['p:path'] ? loadPart(c['p:path']) : part;
      if (target) {
        emit(target, c.objectid ?? '', mul(m, parseTransform(c.transform)), bp?.color ?? objColor, fixed || !!bp?.color, null, depth + 1);
      }
    });
  };

  const build = blocks(rootText, 'build')[0];
  for (const item of build ? tags(build.body, 'item') : []) {
    // printable="0" はスライサーで「印刷しない」にした物（補助の形など）。印刷物の見え方に合わせて描かない
    if (item.printable === '0') {
      continue;
    }
    const id = item.objectid ?? '';
    const target = item['p:path'] ? loadPart(item['p:path']) : root;
    // Bambu の設定はルートのオブジェクトの番号で引く
    const b = target === root ? bambu?.get(id) : undefined;
    if (target) {
      emit(target, id, parseTransform(item.transform), b?.object ?? null, !!b?.object, b?.parts ?? null, 0);
    }
  }

  if (out.positions.length === 0) {
    throw new Error('3MF に三角形がありません');
  }
  const positions = new Float32Array(out.positions);
  if (unit !== 1) {
    for (let i = 0; i < positions.length; i++) {
      positions[i] *= unit;
    }
  }
  // 色が 1 つも付いていなければ色なし。一部だけ付いていれば、付いていない面は灰色で見せる
  if (!out.colors.some((c) => c !== '')) {
    return { positions, colors: null, faceColor: Uint16Array.from(out.faceColor) };
  }
  // 灰色にした面と、もともと同じ灰色の面を 1 つの色にまとめる（色パネルに同じ色が 2 行並ばないように）
  const colors: string[] = [];
  const remap = out.colors.map((c) => {
    const hex = c || NO_COLOR;
    const k = colors.indexOf(hex);
    return k >= 0 ? k : colors.push(hex) - 1;
  });
  return { positions, colors, faceColor: Uint16Array.from(out.faceColor, (k) => remap[k]) };
}

/** _rels/.rels からルートのモデルを探す（既定の場所に無いとき用） */
function findRootModel(xml: (path: string) => string | null): string | null {
  const rels = xml('_rels/.rels');
  const target = rels ? tags(rels, 'Relationship').find((r) => /\.model$/i.test(r.Target ?? ''))?.Target : undefined;
  return target ? target.replace(/^\//, '') : null;
}

function parseModel(src: string): ModelPart {
  const objects = new Map<string, ObjectData>();
  for (const o of blocks(src, 'object')) {
    objects.set(o.attrs.id ?? '', { attrs: o.attrs, body: o.body });
  }
  const materials = new Map<string, string[]>();
  for (const g of blocks(src, 'basematerials')) {
    materials.set(g.attrs.id ?? '', tags(g.body, 'base').map((b) => toHex(b.displaycolor)));
  }
  for (const g of blocks(src, 'colorgroup')) {
    materials.set(g.attrs.id ?? '', tags(g.body, 'color').map((c) => toHex(c.color)));
  }
  return { objects, materials };
}

function parseMesh(part: ModelPart, obj: ObjectData): MeshData {
  // 属性の並びは x y z / v1 v2 v3 が普通だが、決め打ちせず名前で拾う
  // 数として読めない頂点は NaN のまま残す（番号をずらさないため）。その頂点を使う三角形は emitMesh で捨てる
  const vs: number[] = [];
  for (const m of obj.body.matchAll(/<(?:\w+:)?vertex\b([^>]*)>/g)) {
    const a = m[1];
    vs.push(num(a, 'x'), num(a, 'y'), num(a, 'z'));
  }
  const n = vs.length / 3;
  const ts: number[] = [];
  let faceColor: (string | null)[] | null = null;
  for (const m of obj.body.matchAll(/<(?:\w+:)?triangle\b([^>]*)>/g)) {
    const a = m[1];
    const v = [num(a, 'v1'), num(a, 'v2'), num(a, 'v3')];
    if (!v.every((k) => Number.isInteger(k) && k >= 0 && k < n && Number.isFinite(vs[k * 3] + vs[k * 3 + 1] + vs[k * 3 + 2]))) {
      continue;
    }
    ts.push(v[0], v[1], v[2]);
    // 三角形ごとの材質（pid / p1）は無いことが多いので、あったときだけ持つ
    if (a.includes('p1=') || a.includes('pid=')) {
      faceColor ??= new Array<string | null>(ts.length / 3 - 1).fill(null);
      const t = attrs(a);
      faceColor.push(materialColor(part, t.pid ?? obj.attrs.pid, t.p1));
    } else if (faceColor) {
      faceColor.push(null);
    }
  }
  return { vertices: new Float32Array(vs), triangles: new Uint32Array(ts), faceColor };
}

/** 属性を数で読む。無い・空・数でないときは NaN */
function num(a: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(a);
  const s = m ? (m[1] ?? m[2]).trim() : '';
  return s === '' ? NaN : Number(s);
}

/** fixed なら三角形ごとの材質より color を優先する（Bambu のフィラメント色） */
function emitMesh(mesh: MeshData, m: Mat, color: string | null, fixed: boolean, out: Collector) {
  if ((out.positions.length + mesh.triangles.length * 3) / 9 > MAX_TRIANGLES) {
    throw new Error(`三角形が多すぎます（${MAX_TRIANGLES.toLocaleString()} を超えます）`);
  }
  const src = mesh.vertices;
  const v = new Float32Array(src.length);
  for (let i = 0; i < src.length / 3; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    v[i * 3] = m[0] * x + m[1] * y + m[2] * z + m[3];
    v[i * 3 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    v[i * 3 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  // 鏡映（行列式が負）の変換では面の向きが裏返るので、頂点の順を入れ替えて表を保つ
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  const flip = det < 0;
  let meshColor = -1; // 使う面が出てから一覧に入れる（使われない色を並べない）
  const t = mesh.triangles;
  for (let f = 0; f < t.length / 3; f++) {
    const a = t[f * 3];
    const b = t[f * 3 + (flip ? 2 : 1)];
    const c = t[f * 3 + (flip ? 1 : 2)];
    out.positions.push(v[a * 3], v[a * 3 + 1], v[a * 3 + 2], v[b * 3], v[b * 3 + 1], v[b * 3 + 2], v[c * 3], v[c * 3 + 1], v[c * 3 + 2]);
    const own = fixed ? null : mesh.faceColor?.[f] ?? null;
    if (!own && meshColor < 0) {
      meshColor = out.colorIndex(color);
    }
    out.faceColor.push(own ? out.colorIndex(own) : meshColor);
  }
}

function materialColor(part: ModelPart, pid: string | undefined, pindex: string | undefined): string | null {
  if (pid === undefined) {
    return null;
  }
  return part.materials.get(pid)?.[Number(pindex ?? 0)] ?? null;
}

/** "#RRGGBB" / "#RRGGBBAA" を "#rrggbb" に（不透明度は使わない） */
function toHex(s: string | undefined): string {
  const m = /^#?([0-9a-fA-F]{6})/.exec(s ?? '');
  return m ? `#${m[1].toLowerCase()}` : NO_COLOR;
}

interface BambuPart {
  color: string | null;
  subtype: string;
}

/**
 * Bambu Studio / OrcaSlicer の色。オブジェクトと部品に割り当てたフィラメントの番号（model_settings.config）を
 * フィラメントの色の一覧（project_settings.config の filament_colour）で引く。Bambu の 3MF でなければ null
 */
function readBambuColors(
  text: (path: string) => string | null,
  xml: (path: string) => string | null,
): Map<string, { object: string | null; parts: BambuPart[] }> | null {
  const settings = xml('Metadata/model_settings.config');
  const project = text('Metadata/project_settings.config');
  if (!settings || !project) {
    return null;
  }
  let filaments: string[];
  try {
    filaments = (JSON.parse(project).filament_colour ?? []).map((c: string) => toHex(c));
  } catch {
    return null;
  }
  if (filaments.length === 0) {
    return null;
  }
  const colorOf = (body: string): string | null => {
    const n = Number(tags(body, 'metadata').find((m) => m.key === 'extruder')?.value);
    // 範囲外の番号は無いものとして親（オブジェクト）の色に任せる
    return Number.isInteger(n) && n >= 1 && n <= filaments.length ? filaments[n - 1] : null;
  };
  const map = new Map<string, { object: string | null; parts: BambuPart[] }>();
  for (const o of blocks(settings, 'object')) {
    // 部品の中の metadata を拾わないよう、オブジェクト自身の分は部品より前だけを見る
    const own = o.body.split(/<part\b/)[0];
    // 番号の無いオブジェクトは 1 番のフィラメント
    const object = colorOf(own) ?? filaments[0];
    const parts = blocks(o.body, 'part').map((p) => ({ color: colorOf(p.body) ?? object, subtype: p.attrs.subtype ?? 'normal_part' }));
    map.set(o.attrs.id ?? '', { object, parts });
  }
  return map;
}
