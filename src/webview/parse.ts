// ファイルのバイト列を、画面に置く直前の形（向きを直し、法線を付けた頂点の配列）にする。
// DOM を使わない計算だけなので、Worker（parseWorker.ts）でもメインスレッドでも同じものを動かせる。
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { isGlb, parseGlb, type GlbLayers, type GlbMesh } from './glb';
import { isZip, parse3mf } from './threemf';

type Numbers = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int32Array | Int16Array | Int8Array;

/** BufferGeometry をスレッドの間で渡せる形にしたもの（属性の配列そのもの） */
export interface GeomData {
  attrs: { name: string; array: Numbers; itemSize: number; normalized: boolean }[];
  index: Uint32Array | Uint16Array | null;
}

export interface ParsedModel {
  geom: GeomData;
  colors: { colors: string[]; faceColor: Uint16Array } | null;
  overlay: { geom: GeomData; faceColor: Uint16Array; opacity: number } | null;
  layers: GlbLayers | null;
}

/**
 * 形と色を読み、CAD の Z 上向きを three の Y 上向きに直し、法線を付ける。
 * GLB（先頭が glTF）と 3MF（ZIP）は先頭のバイトで見分ける（拡張子に頼らない）
 */
export function parseModel(data: Uint8Array, creaseAngle: number): ParsedModel {
  const orient = (g: THREE.BufferGeometry) => {
    g.rotateX(-Math.PI / 2);
    // 曲面は法線を平均して滑らかに、折れ目は面法線のまま残す
    return toGeomData(creaseAngle > 0 ? toCreasedNormals(g, THREE.MathUtils.degToRad(creaseAngle)) : g);
  };
  // GLB は 3MF と同じ形（mm・Z 上向き・非インデックス・三角形ごとの色）で返るので、同じ組み立てでよい
  const glb = isGlb(data);
  if (glb || isZip(data)) {
    const mesh = glb ? parseGlb(data) : parse3mf(data);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geom.computeVertexNormals();
    // GLB のレジスト（BLEND の材質）は本体と別のジオメトリで重ねる
    const ov = glb ? (mesh as GlbMesh).overlay : null;
    let overlay: ParsedModel['overlay'] = null;
    if (ov && mesh.colors) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(ov.positions, 3));
      g.computeVertexNormals();
      overlay = { geom: orient(g), faceColor: ov.faceColor, opacity: ov.opacity };
    }
    return {
      geom: orient(geom),
      colors: mesh.colors ? { colors: mesh.colors, faceColor: mesh.faceColor } : null,
      overlay,
      layers: glb ? (mesh as GlbMesh).layers : null,
    };
  }
  // Worker では受け取ったバッファがまるごとこのデータなので、写さずに使う（大きな STL で写しを増やさない）
  const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  const buffer = (whole ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) as ArrayBuffer;
  return { geom: orient(new STLLoader().parse(buffer)), colors: readStlColors(data), overlay: null, layers: null };
}

function toGeomData(g: THREE.BufferGeometry): GeomData {
  return {
    attrs: Object.entries(g.attributes).map(([name, a]) => {
      const attr = a as THREE.BufferAttribute;
      return { name, array: attr.array as Numbers, itemSize: attr.itemSize, normalized: attr.normalized };
    }),
    index: (g.index?.array as Uint32Array | Uint16Array | undefined) ?? null,
  };
}

/** GeomData を BufferGeometry に戻す（メインスレッド側で使う） */
export function fromGeomData(d: GeomData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const a of d.attrs) {
    g.setAttribute(a.name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  }
  if (d.index) {
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
  }
  return g;
}

/** Worker から送り返すときに、写さずに手渡しできる配列の中身（同じバッファは 1 度だけ） */
export function transferables(p: ParsedModel): ArrayBuffer[] {
  const set = new Set<ArrayBuffer>();
  const add = (v: ArrayBufferView | null | undefined) => {
    if (v && v.buffer instanceof ArrayBuffer) {
      set.add(v.buffer);
    }
  };
  const addGeom = (d: GeomData) => {
    d.attrs.forEach((a) => add(a.array));
    add(d.index);
  };
  addGeom(p.geom);
  add(p.colors?.faceColor);
  if (p.overlay) {
    addGeom(p.overlay.geom);
    add(p.overlay.faceColor);
  }
  add(p.layers?.face);
  add(p.layers?.overlayFace);
  return [...set];
}

/**
 * バイナリ STL の色（STLLoader と同じ解釈）を読み、色の一覧と三角形ごとの番号を返す。色が無ければ null。
 * ヘッダの COLOR= ＋ RGBA が既定色、三角形ごとの予備 2 バイトの最上位ビットが 0 なら r | g<<5 | b<<10（各 5 ビット）の固有色
 */
function readStlColors(data: Uint8Array): { colors: string[]; faceColor: Uint16Array } | null {
  if (data.byteLength < 84) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const faces = view.getUint32(80, true);
  if (84 + faces * 50 !== data.byteLength) {
    return null; // ASCII STL には色が無い
  }
  let defaultHex: string | null = null;
  for (let i = 0; i < 80 - 10; i++) {
    if (view.getUint32(i, false) === 0x434f4c4f && view.getUint8(i + 4) === 0x52 && view.getUint8(i + 5) === 0x3d) {
      defaultHex = hex8(view.getUint8(i + 6), view.getUint8(i + 7), view.getUint8(i + 8));
    }
  }
  if (defaultHex === null) {
    return null;
  }
  const index = new Map<string, number>();
  const raw = new Uint16Array(faces);
  for (let f = 0; f < faces; f++) {
    const packed = view.getUint16(84 + f * 50 + 48, true);
    const hex = (packed & 0x8000) === 0
      ? hex8(...([0, 5, 10].map((s) => Math.round((((packed >> s) & 0x1f) * 255) / 31)) as [number, number, number]))
      : defaultHex;
    let k = index.get(hex);
    if (k === undefined) {
      k = index.size;
      index.set(hex, k);
    }
    raw[f] = k;
  }
  return { colors: [...index.keys()], faceColor: raw };
}

function hex8(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
