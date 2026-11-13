// STL / 3MF / GLB（KiCad 基板）プレビューの webview 本体。
// リアルタイム PBR（環境光 IBL・ソフトシャドウ・GTAO・MSAA）で描く。
import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { BACKGROUNDS, DEFAULT_LOOK, LIGHTS, Look, MATERIALS, applyMaterial } from './looks';
import { isGlb, parseGlb, type GlbLayers, type GlbMesh } from './glb';
import { Measure } from './measure';
import { isZip, parse3mf } from './threemf';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();

/**
 * 裏に回ったタブは GPU を手放すため webview ごと破棄される（retainContextWhenHidden を使わない）。
 * 戻ったときに同じ視点・計測で再開できるよう、webview の state に覚えておく
 */
interface ViewState {
  camera: number[];
  target: number[];
  up: number[];
  segments: number[][];
  bytes: number; // 覚えたときのファイルの長さ。変わっていたら計測の線は捨てる（形が変わって宙に浮くので）
}
const VIEW_SAVE_DELAY_MS = 300;
// コンテキストを失ってからこの時間内に戻らなければ、webview を作り直してもらう
const CONTEXT_RESTORE_WAIT_MS = 3000;

interface Config {
  creaseAngle: number;
  floatRatio: number; // 床から浮かせる量（モデル半径に対する割合）
  periodicRedraw: boolean; // 一定間隔で描き直す（白くなる不具合の対策。切ると原因を調べやすい）
}

// ===== 見た目の定数 ===================================================
const FOV = 35;                                           // 画角（度）。狭めにしてパースの歪みを抑える
const VIEW_DIR = new THREE.Vector3(1, 0.75, 1.25).normalize(); // 初期視点の向き（右前の斜め上から見下ろす）
const KEY_DIR = new THREE.Vector3(-0.55, 1, 0.45).normalize(); // キーライトの方角（左前の上から）
const KEY_DIST = 4;                                       // キーライトまでの距離（モデル半径の倍数）。近いほど減衰のムラが強く出る
const FILL_DIR = new THREE.Vector3(0.5, -1, -0.35).normalize(); // 下からの補助光の方角（キーと反対寄りの床下から）
const FLOOR_RADIUS = 80;                                  // 床の半径（モデル半径の倍数）
const FOG_NEAR = 2;                                       // 霧の掛かり始め（注視点より奥へモデル半径の何倍か）
const FOG_FAR = 20;                                       // 床が背景色に溶けきる距離（同上）
// ======================================================================

// 画面の部品はここで組み立てる。HTML 側に置くと、拡張を入れ直してウィンドウを
// リロードしていないとき（古い HTML ＋新しい JS）に要素が足りず、何も描かれなくなる
document.body.insertAdjacentHTML(
  'beforeend',
  `<canvas id="view"></canvas>
<div id="panel">
  <label>材質 <select id="material"></select></label>
  <button id="colorBtn" title="色を選ぶ・コピーする">色 <span id="swatch"></span></button>
  <label>背景 <select id="background"></select></label>
  <button id="fit" title="全体が収まる視点に戻す（F）">全体表示</button>
  <button id="lightsBtn" title="ライトの強さを調整する">ライト</button>
  <button id="measureBtn" title="クリックした 2 点の間の長さを測る（M）。頂点の近くは頂点に吸着、Alt を押しながらで吸着しない">計測</button>
  <button id="measureClear" title="計測の線をすべて消す（Esc）" hidden>計測を消す</button>
  <button id="layersBtn" title="基板の層（部品・シルク・銅など）を表示・非表示にする" hidden>層</button>
  <button id="openKicad" title="この基板を KiCad の PCB エディタで開く" hidden>KiCad で開く</button>
  <button id="rebuild" title="3D が表示されないときに、表示部分（webview と canvas）を作り直す。タブを開き直すのと同じ。視点と計測は残る">作り直す</button>
</div>
<div id="colorPanel" class="popover" hidden>
  <div class="row"><input id="color" type="color"><input id="colorHex" type="text" maxlength="7" spellcheck="false"></div>
  <label id="stlColorWrap" hidden title="ファイルに埋め込まれた色（3MF はフィラメント・材質の色）で塗る"><input id="stlColor" type="checkbox"> ファイルの色を使う</label>
  <div id="stlColors" hidden></div>
  <button id="copyColor" title="ファイル名と色をクリップボードにコピーする">色をコピー</button>
</div>
<div id="lights" class="popover" hidden>
  ${LIGHTS.map((l) => `<label title="${l.title}"><span>${l.label}</span><input id="${l.key}" type="range" min="0" max="${l.max}" step="0.05"><output id="${l.key}Val"></output></label>`).join('')}
  <label id="maskRow" title="基板のレジスト（緑の半透明の層）の濃さ。下の銅の配線の見えやすさが変わる" hidden><span>レジストの濃さ</span><input id="maskOpacity" type="range" min="0" max="1" step="0.05"><output id="maskOpacityVal"></output></label>
  <button id="lightsReset">既定に戻す</button>
</div>
<div id="layers" class="popover" hidden>
  <div id="layerList"></div>
  <button id="layersAll" title="隠した層をすべて表示する">すべて表示</button>
</div>
<div id="info"><span id="name"></span><span id="dims"></span><span id="status"></span><span id="progress" hidden><i></i></span></div>
<div id="kicadNotice" hidden>
  <p id="kicadNoticeText"></p>
  <button id="kicadDownload">ダウンロードページ</button>
</div>
<div id="message"></div>`,
);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = {
  material: document.getElementById('material') as HTMLSelectElement,
  color: document.getElementById('color') as HTMLInputElement,
  colorHex: document.getElementById('colorHex') as HTMLInputElement,
  colorBtn: document.getElementById('colorBtn') as HTMLButtonElement,
  colorPanel: document.getElementById('colorPanel') as HTMLElement,
  colorRow: document.querySelector('#colorPanel .row') as HTMLElement,
  stlColors: document.getElementById('stlColors') as HTMLElement,
  swatch: document.getElementById('swatch') as HTMLElement,
  stlColor: document.getElementById('stlColor') as HTMLInputElement,
  stlColorWrap: document.getElementById('stlColorWrap') as HTMLElement,
  background: document.getElementById('background') as HTMLSelectElement,
  fit: document.getElementById('fit') as HTMLButtonElement,
  rebuild: document.getElementById('rebuild') as HTMLButtonElement,
  copyColor: document.getElementById('copyColor') as HTMLButtonElement,
  lightsBtn: document.getElementById('lightsBtn') as HTMLButtonElement,
  lights: document.getElementById('lights') as HTMLElement,
  maskRow: document.getElementById('maskRow') as HTMLElement,
  lightsReset: document.getElementById('lightsReset') as HTMLButtonElement,
  measureBtn: document.getElementById('measureBtn') as HTMLButtonElement,
  measureClear: document.getElementById('measureClear') as HTMLButtonElement,
  layersBtn: document.getElementById('layersBtn') as HTMLButtonElement,
  layers: document.getElementById('layers') as HTMLElement,
  layerList: document.getElementById('layerList') as HTMLElement,
  layersAll: document.getElementById('layersAll') as HTMLButtonElement,
  openKicad: document.getElementById('openKicad') as HTMLButtonElement,
  panel: document.getElementById('panel') as HTMLElement,
  status: document.getElementById('status') as HTMLElement,
  progress: document.getElementById('progress') as HTMLElement,
  progressBar: document.querySelector('#progress i') as HTMLElement,
  kicadNotice: document.getElementById('kicadNotice') as HTMLElement,
  kicadNoticeText: document.getElementById('kicadNoticeText') as HTMLElement,
  kicadDownload: document.getElementById('kicadDownload') as HTMLButtonElement,
  name: document.getElementById('name') as HTMLElement,
  dims: document.getElementById('dims') as HTMLElement,
  message: document.getElementById('message') as HTMLElement,
};

// 例外で黙って真っ白にならないよう、捕まえ損ねたエラーは画面に出す
const showError = (err: unknown) => {
  ui.message.textContent = `エラー: ${err instanceof Error ? err.message : String(err)}`;
  log(`エラー: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`);
};

/** 拡張の出力パネル「JP STL Viewer」に書く（webview の中のことは、外から見る手段がこれしかない）*/
function log(message: string) {
  vscode.postMessage({ type: 'log', message });
}
window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

const DEFAULT_CONFIG: Config = { creaseAngle: 30, floatRatio: 0.05, periodicRedraw: true };
let config: Config = { ...DEFAULT_CONFIG };
let look: Look = { ...DEFAULT_LOOK };
let lastData: Uint8Array | null = null;
let hasModel = false;
let stlHasColors = false; // 読み込んだファイルに色が埋め込まれているか（STL はヘッダの COLOR=、3MF はフィラメント・材質、GLB は材質の色）
let layers: GlbLayers | null = null; // 読み込んだ基板の層の分け方（STL / 3MF は null）
let palette: StlPalette | null = null; // 読み込んだファイルの色の一覧と、三角形ごとの色の番号
let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
let contextLost = false;
let receivedLoad = false; // この webview で最初の load を受け取ったか
const CONTEXT_LOST_MESSAGE = 'GPU の描画が途切れました。復帰を待っています…';
let contextRestoreTimer: ReturnType<typeof setTimeout> | undefined;

/** ファイルに埋め込まれた色の一覧（多い順）と、三角形ごとの色の番号 */
interface StlPalette {
  colors: string[];   // 元の色（"#rrggbb"。5 ビットの値を 8 ビットに広げたもの）
  shares: number[];   // 表面積に対する割合
  faceColor: Uint16Array;
  overlayFaceColor: Uint16Array | null; // 重ねる層（半透明のレジストなど）の三角形ごとの色の番号。同じ colors を指す
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

/** 色ごとの表面積を測り、多い順に並べた色の一覧にする。positions は三角形ごとに 3 頂点 */
function makePalette(
  colors: string[],
  raw: Uint16Array,
  positions: ArrayLike<number>,
  overlay: { faceColor: Uint16Array; positions: ArrayLike<number> } | null,
): StlPalette {
  const counts = new Array<number>(colors.length).fill(0); // 色ごとの表面積
  let total = 0;
  // 本体と重ねる層の両方の三角形を数える（レジストの色も色パネルに出す）
  const add = (face: Uint16Array, pos: ArrayLike<number>) => {
    for (let f = 0; f < face.length; f++) {
      const o = f * 9;
      const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
      const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
      const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      total += area;
      counts[face[f]] += area;
    }
  };
  add(raw, positions);
  if (overlay) add(overlay.faceColor, overlay.positions);
  // 多い順に並べ直す（パネルの上ほど面積の大きい色）
  const order = counts.map((_, k) => k).sort((a, b) => counts[b] - counts[a]);
  const rank = new Uint16Array(counts.length);
  order.forEach((k, r) => (rank[k] = r));
  return {
    colors: order.map((k) => colors[k]),
    shares: order.map((k) => counts[k] / Math.max(total, 1e-12)),
    faceColor: raw.map((k) => rank[k]),
    overlayFaceColor: overlay && overlay.faceColor.map((k) => rank[k]),
  };
}

function hex8(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 色の置き換え（look.colorMap）を反映して、頂点色を塗り直す */
function applyStlColors() {
  const geom = model.geometry;
  if (!palette || geom.attributes.position.count !== palette.faceColor.length * 3) {
    return;
  }
  const c = new THREE.Color();
  const linear = palette.colors.map((hex) => c.set(look.colorMap[hex] ?? hex).toArray() as number[]);
  const paint = (g: THREE.BufferGeometry, face: Uint16Array) => {
    const arr = new Float32Array(face.length * 9);
    face.forEach((k, f) => {
      const [r, gg, b] = linear[k];
      for (let v = 0; v < 3; v++) {
        arr.set([r, gg, b], f * 9 + v * 3);
      }
    });
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  };
  paint(geom, palette.faceColor);
  const of = palette.overlayFaceColor;
  if (of && overlay.geometry.attributes.position?.count === of.length * 3) {
    paint(overlay.geometry, of);
  }
  requestRaster();
}

/** 色パネルに、ファイルの色ごとの行（ピッカー・16 進・元の色と割合・元に戻す）を作る。読み込むたびに作り直す */
function buildStlColorRows() {
  ui.stlColors.replaceChildren();
  if (!palette) {
    return;
  }
  palette.colors.forEach((orig, k) => {
    const row = document.createElement('div');
    row.className = 'stlColorRow';
    row.innerHTML = `<input type="color"><input type="text" maxlength="7" spellcheck="false">
<span class="orig" title="ファイルの元の色と、表面積に対する割合"><i></i>${orig} ${Math.max(palette!.shares[k] * 100, 0.1).toFixed(1)}%</span>
<button title="元の色に戻す">↺</button>`;
    (row.querySelector('.orig i') as HTMLElement).style.background = orig;
    const [picker, text] = Array.from(row.querySelectorAll('input'));
    const set = (hex: string) => {
      const map = { ...look.colorMap };
      if (hex === orig) {
        delete map[orig];
      } else {
        map[orig] = hex;
      }
      setLook({ colorMap: map });
      applyStlColors();
    };
    picker.addEventListener('input', () => set(picker.value));
    text.addEventListener('input', () => {
      const v = text.value.trim();
      const hex = v.startsWith('#') ? v : `#${v}`;
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
        set(hex.toLowerCase());
      }
    });
    text.addEventListener('blur', () => (text.value = look.colorMap[orig] ?? orig));
    row.querySelector('button')!.addEventListener('click', () => set(orig));
    ui.stlColors.append(row);
  });
  syncStlColorRows();
}

/** 行の値を look.colorMap に合わせる（入力中の欄は触らない） */
function syncStlColorRows() {
  if (!palette) {
    return;
  }
  ui.stlColors.querySelectorAll<HTMLElement>('.stlColorRow').forEach((row, k) => {
    const orig = palette!.colors[k];
    const cur = look.colorMap[orig] ?? orig;
    const [picker, text] = Array.from(row.querySelectorAll('input'));
    picker.value = cur;
    if (document.activeElement !== text) {
      text.value = cur;
    }
    row.classList.toggle('changed', cur !== orig);
  });
}

// ---- レンダラ ----
// 「描けているのに画面に出ない（背景だけに見える）」対策:
// alpha: false で canvas を不透明にし、透けて後ろが見える余地をなくす（後ろの縞が見えたら合成の問題と言い切れる）。
// preserveDrawingBuffer: true で、合成側が絵を取り直しに来ても最後に描いた絵が残っているようにする
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
// PBR Neutral はフィラメントの色を崩さずにハイライトだけ丸める（ACES ほど彩度が落ちない）
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10000);
// クォータニオンで回転を積むので、裏返しでも極で止まらずどの向きにも同じように回せる
const controls = new TrackballControls(camera, canvas);
controls.rotateSpeed = 3; // 画面の端から端までのドラッグでほぼ 1 周（OrbitControls と同じ手応え）
// 慣性は付けない。Trackball の慣性は止める公開 API が無く、全体表示の後も視点が流れてしまう
controls.staticMoving = true;
controls.keys = ['', '', '']; // A/S/D でドラッグの操作を切り替える機能は使わない（入力欄への入力でも反応するため）

// ---- 環境光：RoomEnvironment（スタジオ風の部屋）を PMREM に焼いて IBL にする ----
// 焼いた結果は GPU 上にしか無いので、コンテキストを失ったら焼き直す
let envTarget: THREE.WebGLRenderTarget | null = null;
function bakeEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  envTarget?.dispose();
  envTarget = target;
  scene.environment = target.texture;
}
bakeEnvironment();

// 背景は単色。床は霧で背景色に溶かし、床の縁（地平線）を見せない
const backgroundColor = new THREE.Color(BACKGROUNDS[DEFAULT_LOOK.background].background); // 見た目が届く前に塗っても黒くならないように
scene.background = backgroundColor;
const fog = new THREE.Fog(backgroundColor, 1, 2);
scene.fog = fog;

// ---- ライト：影を落とすポイント光源（キー）＋床下からの補助光（残りの光は IBL）----
// 平行光より距離の減衰で面ごとの明るさに差が付き、形が読み取りやすい
const keyLight = new THREE.PointLight(0xffffff, 0, 0, 2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.radius = 5;
scene.add(keyLight);

// 補助光は影を落とさないので床に遮られず、モデルの底面・裏側に届く。
// 床は上向きの片面なので下からの光では明るくならず、床下に回り込めば床は見えない
const fillLight = new THREE.PointLight(0xffffff, 0, 0, 2);
scene.add(fillLight);

// カメラに付けた弱い点光源（影なし）。どこから見ても見ている側の暗がりを少し持ち上げる。
// 子の光源を描かせるため、カメラもシーンに入れる
const camLight = new THREE.PointLight(0xffffff, 0, 0, 2);
camera.add(camLight);
scene.add(camera);

// ---- 床とモデル ----
const floorMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 128).rotateX(-Math.PI / 2), floorMat);
floor.receiveShadow = true;
scene.add(floor);

// 両面にしておく（穴の空いた STL でも裏側が抜けて見えないように）
const modelMat = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
const model = new THREE.Mesh(new THREE.BufferGeometry(), modelMat);
model.castShadow = true;
model.receiveShadow = true;
scene.add(model);

// 重ねる層（半透明のレジストなど）。model の子にして、浮かせた位置がそのまま効くようにする。
// 影は落とさず（半透明の膜が本体に影を作らない）、深度も書かない（下の銅が透けて見えるように）
const overlayMat = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
const overlay = new THREE.Mesh(new THREE.BufferGeometry(), overlayMat);
overlay.castShadow = false;
overlay.receiveShadow = true;
overlay.visible = false;
model.add(overlay);

// ---- 長さの計測（画面に重ねる定規）----
const measure = new Measure(canvas, camera, model, () => {
  ui.measureBtn.classList.toggle('active', measure.active);
  ui.measureClear.hidden = !measure.hasSegments;
  requestMeasureDraw();
  scheduleViewSave();
});

// ---- ポストプロセス：MSAA ＋ GTAO（隅や接地部の陰り）----
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }),
);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 1, 1);
gtao.blendIntensity = 0.8;
composer.addPass(gtao);
composer.addPass(new OutputPass());

// ---- STL / 3MF の読み込みと配置 ----
const loader = new STLLoader();
let radius = 1;
let lightDist = 1; // ライトからモデル中心までの距離（layoutScene で決める）

/** 形と色を読む。GLB（先頭が glTF）と 3MF（ZIP）は先頭のバイトで見分ける（拡張子に頼らない） */
function parseModel(data: Uint8Array): {
  geom: THREE.BufferGeometry;
  colors: { colors: string[]; faceColor: Uint16Array } | null;
  overlay: { geom: THREE.BufferGeometry; faceColor: Uint16Array; opacity: number } | null;
  layers: GlbLayers | null;
} {
  // GLB は 3MF と同じ形（mm・Z 上向き・非インデックス・三角形ごとの色）で返るので、同じ組み立てでよい
  const glb = isGlb(data);
  if (glb || isZip(data)) {
    const mesh = glb ? parseGlb(data) : parse3mf(data);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geom.computeVertexNormals();
    // GLB のレジスト（BLEND の材質）は本体と別のジオメトリで重ねる
    const ov = glb ? (mesh as GlbMesh).overlay : null;
    let overlayGeom = null;
    if (ov && mesh.colors) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(ov.positions, 3));
      g.computeVertexNormals();
      overlayGeom = { geom: g, faceColor: ov.faceColor, opacity: ov.opacity };
    }
    return { geom, colors: mesh.colors ? { colors: mesh.colors, faceColor: mesh.faceColor } : null,
      overlay: overlayGeom,
      layers: glb ? (mesh as GlbMesh).layers : null,
    };
  }
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return { geom: loader.parse(buffer), colors: readStlColors(data), overlay: null, layers: null };
}

function loadModel(data: Uint8Array, fit: boolean) {
  const parsed = parseModel(data);
  let geom = parsed.geom;
  // build123d などの CAD や 3MF は Z 上向き、three は Y 上向き
  const orient = (g: THREE.BufferGeometry) => {
    g.rotateX(-Math.PI / 2);
    // 曲面は法線を平均して滑らかに、折れ目は面法線のまま残す
    return config.creaseAngle > 0 ? toCreasedNormals(g, THREE.MathUtils.degToRad(config.creaseAngle)) : g;
  };
  geom = orient(geom);
  const overGeom = parsed.overlay ? orient(parsed.overlay.geom) : null;
  geom.computeBoundingBox();
  const box = geom.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // 床（Y=0）に接地させ、XZ は原点中心に
  geom.translate(-center.x, -box.min.y, -center.z);
  geom.computeBoundingSphere();
  // 重ねる層は本体の bbox で動かす（本体と同じ位置に重なるように）
  overGeom?.translate(-center.x, -box.min.y, -center.z);

  model.geometry.dispose();
  model.geometry = geom;
  overlay.geometry.dispose();
  overlay.geometry = overGeom ?? new THREE.BufferGeometry();
  overlay.visible = overGeom !== null;
  radius = Math.max(geom.boundingSphere!.radius, 1e-3);
  hasModel = true;
  palette = parsed.colors && makePalette(
    parsed.colors.colors,
    parsed.colors.faceColor,
    geom.attributes.position.array,
    parsed.overlay && overGeom && { faceColor: parsed.overlay.faceColor, positions: overGeom.attributes.position.array },
  );
  stlHasColors = palette !== null;
  layers = parsed.layers;
  applyStlColors();
  buildStlColorRows();
  buildLayerRows();
  applyLayerVisibility();
  applyLook();

  layoutScene();
  if (fit) {
    fitView();
  }

  // 表示は CAD の軸で（ファイルの X × Y × Z）
  const tris = geom.attributes.position.count / 3;
  ui.dims.textContent = `${size.x.toFixed(2)} × ${size.z.toFixed(2)} × ${size.y.toFixed(2)} mm ・ ${tris.toLocaleString()} 三角形`;
  ui.message.textContent = '';
  ui.kicadNotice.hidden = true; // モデルが読めたので KiCad の案内は要らない
  requestRaster();
}

/** 隠してある層か（look.hiddenLayers は key で持つので、再読込で層の並びが変わっても効く） */
function isLayerHidden(key: string) {
  return !!look.hiddenLayers?.includes(key);
}

/** 層パネルのチェックボックスを作り直す。層が無い（STL / 3MF）ときはボタンごと隠す */
function buildLayerRows() {
  ui.layerList.replaceChildren();
  ui.layersBtn.hidden = !layers;
  if (!layers) {
    ui.layers.hidden = true;
    ui.layersBtn.classList.remove('active');
    return;
  }
  for (const l of layers.list) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.key = l.key;
    box.checked = !isLayerHidden(l.key);
    box.addEventListener('change', () => {
      const hidden = new Set(look.hiddenLayers ?? []);
      if (box.checked) {
        hidden.delete(l.key);
      } else {
        hidden.add(l.key);
      }
      setLook({ hiddenLayers: [...hidden] });
      applyLayerVisibility();
    });
    const label = document.createElement('label');
    label.append(box, ` ${l.label}`);
    ui.layerList.append(label);
  }
}

/** 隠した層の三角形を外すインデックスを本体と重ねる層に張る（ジオメトリは作り直さない）。何も隠さないときは外して元どおり */
function applyLayerVisibility() {
  const apply = (geom: THREE.BufferGeometry, faces: Uint8Array | null) => {
    const count = geom.attributes.position?.count ?? 0;
    // 三角形の数が合わない（想定外の並び）ときは、ずれた表示にならないよう全部見せる
    if (!layers || !faces || faces.length * 3 !== count) {
      geom.setIndex(null);
      return;
    }
    const hide = layers.list.map((l) => isLayerHidden(l.key));
    if (!hide.some(Boolean)) {
      geom.setIndex(null);
      return;
    }
    let shown = 0;
    for (let t = 0; t < faces.length; t++) {
      if (!hide[faces[t]]) shown++;
    }
    const index = new Uint32Array(shown * 3);
    let o = 0;
    for (let t = 0; t < faces.length; t++) {
      if (hide[faces[t]]) continue;
      index[o++] = t * 3;
      index[o++] = t * 3 + 1;
      index[o++] = t * 3 + 2;
    }
    geom.setIndex(new THREE.BufferAttribute(index, 1));
  };
  apply(model.geometry, layers?.face ?? null);
  apply(overlay.geometry, layers?.overlayFace ?? null);
  requestRaster();
}

/** モデルの大きさに合わせてライト・影・床・AO の半径を決め直す */
function layoutScene() {
  const r = radius;
  // 大きさに比例して浮かせる＝どの大きさでも画面上の浮き具合と影の離れ方がそろう
  const lift = r * config.floatRatio;
  model.position.y = lift;
  const target = new THREE.Vector3(0, lift + r * 0.5, 0);

  const d = r * KEY_DIST;
  lightDist = d;
  keyLight.position.copy(target).addScaledVector(KEY_DIR, d);
  const cam = keyLight.shadow.camera;
  cam.near = r * 0.2;
  cam.far = r * 40; // 床に長く伸びる影まで撮る
  cam.updateProjectionMatrix();
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = r * 0.003;

  fillLight.position.copy(target).addScaledVector(FILL_DIR, d);
  applyLights();

  floor.scale.setScalar(r * FLOOR_RADIUS);
  floor.position.y = -r * 0.0005; // モデル底面と同じ高さだと Z ファイティングする

  camera.near = r * 0.01;
  camera.far = r * 400;
  camera.updateProjectionMatrix();

  gtao.updateGtaoMaterial({ radius: r * 0.12, distanceExponent: 1.5, thickness: r * 0.05, scale: 1 });
}

function fitView() {
  const top = model.geometry.boundingBox ? model.geometry.boundingBox.max.y : 0;
  const target = new THREE.Vector3(0, model.position.y + top * 0.45, 0);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2))) * 1.35;
  camera.position.copy(target).addScaledVector(VIEW_DIR, dist);
  camera.up.set(0, 1, 0); // 自由回転で傾いた上方向を戻す
  controls.target.copy(target);
  controls.update();
  onCameraChange();
}

/** 点光源の照度 = 光度 / 距離² なので、モデル中心でスライダーの照度になるよう光度を決める */
function applyLights() {
  const d2 = lightDist * lightDist;
  keyLight.intensity = look.keyLight * d2;
  fillLight.intensity = look.fillLight * d2;
  scene.environmentIntensity = look.envLight;
  applyCamLight();
}

/** カメラの光は注視点での照度がスライダーの値になるよう、カメラから注視点までの距離で決める */
function applyCamLight() {
  const d = camera.position.distanceTo(controls.target);
  camLight.intensity = look.camLight * d * d;
}

// ---- 見た目（材質・色・背景・ライト）----
function applyLook() {
  applyLights();
  const useStlColor = stlHasColors && look.useStlColor;
  applyMaterial(modelMat, look.material, look.color, useStlColor);
  // 重ねる層も同じプリセット・同じ単色（半透明は材質の opacity で効く）
  applyMaterial(overlayMat, look.material, look.color, useStlColor);
  overlayMat.transparent = true;
  overlayMat.depthWrite = false;
  // 表の銅のベタとレジストは厚み方向に 15 µm しか違わず、全体表示の深度の分解能（12 µm 前後）では
  // 銅が手前と判定されてレジストが消える。カメラ側へ寄せて描く（applyMaterial では触られないのでここで毎回入れる）
  overlayMat.polygonOffset = true;
  overlayMat.polygonOffsetFactor = -1;
  overlayMat.polygonOffsetUnits = -4;
  overlayMat.opacity = look.maskOpacity;
  const bg = BACKGROUNDS[look.background] ?? BACKGROUNDS[DEFAULT_LOOK.background];
  backgroundColor.set(bg.background);
  fog.color.set(bg.background); // Fog は色を複製して持つので、背景色とは別に更新する
  floorMat.color.set(bg.floor);
  document.body.dataset.theme = bg.dark ? 'dark' : 'light';

  ui.material.value = look.material;
  ui.color.value = look.color;
  ui.color.disabled = useStlColor;
  if (document.activeElement !== ui.colorHex) {
    ui.colorHex.value = look.color;
  }
  ui.colorHex.disabled = useStlColor;
  // ファイルの色で塗っているときは、ボタンの見本も「ファイルの色」と分かる斜線にする
  ui.swatch.style.background = useStlColor
    ? 'repeating-linear-gradient(45deg, #999 0 3px, #ddd 3px 6px)'
    : look.color;
  ui.stlColor.checked = look.useStlColor;
  ui.stlColorWrap.hidden = !stlHasColors;
  // ファイルの色で塗っているときは、1 色のピッカーの代わりに色ごとの行を出す
  ui.colorRow.hidden = useStlColor;
  ui.stlColors.hidden = !useStlColor;
  syncStlColorRows();
  ui.background.value = look.background;
  for (const l of LIGHTS) {
    (document.getElementById(l.key) as HTMLInputElement).value = String(look[l.key]);
    (document.getElementById(`${l.key}Val`) as HTMLOutputElement).value = look[l.key].toFixed(2);
  }
  // 濃さのスライダーは重ねる層があるとき（KiCad 基板）だけ出す
  ui.maskRow.hidden = !overlay.visible;
  (document.getElementById('maskOpacity') as HTMLInputElement).value = String(look.maskOpacity);
  (document.getElementById('maskOpacityVal') as HTMLOutputElement).value = look.maskOpacity.toFixed(2);
  requestRaster();
}

function setLook(patch: Partial<Look>) {
  look = { ...look, ...patch };
  applyLook();
  vscode.postMessage({ type: 'look', look });
}

for (const [key, m] of Object.entries(MATERIALS)) {
  ui.material.add(new Option(m.label, key));
}
for (const [key, b] of Object.entries(BACKGROUNDS)) {
  ui.background.add(new Option(b.label, key));
}
ui.material.addEventListener('change', () => setLook({ material: ui.material.value }));
ui.color.addEventListener('input', () => setLook({ color: ui.color.value }));
ui.colorHex.addEventListener('input', () => {
  const v = ui.colorHex.value.trim();
  const hex = v.startsWith('#') ? v : `#${v}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    setLook({ color: hex.toLowerCase() });
  }
});
ui.colorHex.addEventListener('blur', () => (ui.colorHex.value = look.color));
ui.stlColor.addEventListener('change', () => setLook({ useStlColor: ui.stlColor.checked }));
ui.background.addEventListener('change', () => setLook({ background: ui.background.value }));
ui.fit.addEventListener('click', fitView);
ui.rebuild.addEventListener('click', () => {
  // 描けているのに画面に出ないときは、タブを開き直すと直る。それと同じく webview ごと作り直してもらう
  saveViewNow(); // 作り直した側が state から視点と計測を戻す
  log('手動で作り直しを頼んだ');
  vscode.postMessage({ type: 'reinit', manual: true });
});
ui.copyColor.addEventListener('click', () => {
  // webview からはクリップボードに書けないことがあるので、拡張側に書かせる
  if (stlHasColors && look.useStlColor && palette) {
    const colors = palette.colors.map((from) => ({ from, to: look.colorMap[from] ?? from }));
    vscode.postMessage({ type: 'copyStlColors', colors });
  } else {
    vscode.postMessage({ type: 'copyColor', color: look.color });
  }
  ui.copyColor.textContent = 'コピーしました';
  setTimeout(() => (ui.copyColor.textContent = '色をコピー'), 1200);
});

/** パネル（色・ライト）は同時に 1 つだけ開く */
const popovers: [HTMLButtonElement, HTMLElement][] = [
  [ui.colorBtn, ui.colorPanel],
  [ui.lightsBtn, ui.lights],
  [ui.layersBtn, ui.layers],
];
for (const [btn, pane] of popovers) {
  btn.addEventListener('click', () => {
    const open = pane.hidden;
    for (const [b, p] of popovers) {
      p.hidden = true;
      b.classList.remove('active');
    }
    pane.hidden = !open;
    btn.classList.toggle('active', open);
  });
}
for (const l of LIGHTS) {
  const input = document.getElementById(l.key) as HTMLInputElement;
  input.addEventListener('input', () => setLook({ [l.key]: Number(input.value) }));
}
(document.getElementById('maskOpacity') as HTMLInputElement).addEventListener('input', (e) =>
  setLook({ maskOpacity: Number((e.target as HTMLInputElement).value) }),
);
ui.layersAll.addEventListener('click', () => {
  setLook({ hiddenLayers: [] });
  for (const box of Array.from(ui.layerList.querySelectorAll<HTMLInputElement>('input'))) {
    box.checked = true;
  }
  applyLayerVisibility();
});
ui.lightsReset.addEventListener('click', () =>
  setLook({
    keyLight: DEFAULT_LOOK.keyLight,
    fillLight: DEFAULT_LOOK.fillLight,
    envLight: DEFAULT_LOOK.envLight,
    camLight: DEFAULT_LOOK.camLight,
  }),
);
ui.measureBtn.addEventListener('click', () => measure.setActive(!measure.active));
ui.measureClear.addEventListener('click', () => measure.clear());
ui.openKicad.addEventListener('click', () => vscode.postMessage({ type: 'openInKicad' }));
ui.kicadDownload.addEventListener('click', () => vscode.postMessage({ type: 'openKicadDownload' }));
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) {
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    fitView();
  } else if (e.key === 'm' || e.key === 'M') {
    measure.setActive(!measure.active);
  } else if (e.key === 'Escape') {
    measure.cancel();
  }
});

// ---- 描画ループ（変化があったフレームだけ描く）----
let rasterDirty = true;
let measureDirty = true;

function requestRaster() {
  rasterDirty = true;
  measureDirty = true;
}

/** 定規だけ描き直す（3D の描き直しは要らないとき）*/
function requestMeasureDraw() {
  measureDirty = true;
}

function onCameraChange() {
  // 霧は注視点からの距離で掛ける（ズームしてもモデルが霞まないように）
  const d = camera.position.distanceTo(controls.target);
  fog.near = d + radius * FOG_NEAR;
  fog.far = d + radius * FOG_FAR;
  applyCamLight();
  requestRaster();
  scheduleViewSave();
}
controls.addEventListener('change', onCameraChange);

/** 視点と計測を webview の state に覚える。ドラッグ中は毎フレーム呼ばれるので間引く */
function scheduleViewSave() {
  if (!hasModel) {
    return;
  }
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveViewNow, VIEW_SAVE_DELAY_MS);
}

function saveViewNow() {
  clearTimeout(viewSaveTimer);
  if (!hasModel) {
    return;
  }
  const state: ViewState = {
    camera: camera.position.toArray(),
    target: controls.target.toArray(),
    up: camera.up.toArray(),
    segments: measure.getSegments(),
    bytes: lastData?.byteLength ?? 0,
  };
  vscode.setState(state);
}
// ドラッグを離したらすぐ覚える（直後にタブを切り替えても最後の視点が残るように）
controls.addEventListener('end', saveViewNow);

/** 覚えておいた視点と計測に戻す。形が壊れていれば false（呼び出し側で全体表示にする）*/
function restoreView(s: Partial<ViewState> | undefined): boolean {
  const ok = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!s || !ok(s.camera) || !ok(s.target) || !ok(s.up)) {
    return false;
  }
  camera.position.fromArray(s.camera);
  camera.up.fromArray(s.up);
  controls.target.fromArray(s.target);
  controls.update();
  const sameFile = s.bytes === lastData?.byteLength;
  measure.setSegments(sameFile && Array.isArray(s.segments) ? s.segments : []);
  onCameraChange();
  return true;
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) {
    return;
  }
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  controls.handleResize();
  onCameraChange();
  keepDrawing();
}
new ResizeObserver(resize).observe(canvas);

// ---- WebGL コンテキストの喪失と復帰 ----
// GPU のリセットやメモリ不足、WebGL コンテキスト数の上限（webview 全体で共有）で、3D の絵だけが消えることがある。
// three は preventDefault して復帰を待ち、戻ればバッファ・テクスチャを積み直す。焼いた環境マップだけは自前で焼き直す
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  log('WebGL コンテキストを失った');
  contextLost = true;
  ui.message.textContent = CONTEXT_LOST_MESSAGE;
  clearTimeout(contextRestoreTimer);
  contextRestoreTimer = setTimeout(() => {
    if (contextLost) {
      // 戻らないときは webview ごと作り直してもらう（視点と計測は state から戻る）
      log(`${CONTEXT_RESTORE_WAIT_MS}ms 待っても戻らないので作り直しを頼む`);
      vscode.postMessage({ type: 'reinit' });
    }
  }, CONTEXT_RESTORE_WAIT_MS);
});
canvas.addEventListener('webglcontextrestored', () => {
  log('WebGL コンテキストが戻った');
  contextLost = false;
  clearTimeout(contextRestoreTimer);
  // 古い環境マップは失ったコンテキストのもの。dispose すると無効なオブジェクトを消そうとするので、捨てるだけにする
  envTarget = null;
  bakeEnvironment();
  if (ui.message.textContent === CONTEXT_LOST_MESSAGE) {
    ui.message.textContent = ''; // ほかのエラー表示は消さない
  }
  requestRaster();
});

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  if (now - lastFrameAt > RAF_GAP_LOG_MS && document.visibilityState === 'visible') {
    log(`描画ループが再開した（${Math.round(now - lastFrameAt)}ms 止まっていた）`);
  }
  lastFrameAt = now;
  controls.update();
  if (contextLost) {
    return; // 失っている間は描かない（汚れた印を残し、復帰後に描く）
  }
  if (!hasModel) {
    // canvas は不透明（alpha: false）なので、一度も描かないと黒く見える。読み込みを待つ間は背景色で塗っておく
    if (rasterDirty || now < keepDrawingUntil) {
      renderer.setRenderTarget(null);
      renderer.setClearColor(backgroundColor, 1);
      renderer.clear();
      rasterDirty = false;
    }
    return; // 汚れた印は読み込み後に loadModel が立て直す
  }
  measure.updateHover();
  if (rasterDirty || now < keepDrawingUntil) {
    const sinceLast = now - lastRasterAt;
    composer.render();
    lastRasterAt = now;
    rasterDirty = false;
    if (probeReason) {
      const reason = probeReason;
      probeReason = null;
      probe(reason, sinceLast);
    }
  }
  if (measureDirty) {
    measure.draw();
    measureDirty = false;
  }
}

// ---- 描画の見張り（3D が白くなる不具合を追うため）----
// 変化があったときだけ描くので、canvas の中身が何かの拍子に捨てられると、白いまま描き直されない。
// 一定間隔（設定 periodicRedraw）と、表に戻ったとき・フォーカスを得たとき・コマンドで描き直す。
// あわせて描いた直後の画素を読み、「描いた結果が白い」のか「描いた結果は正しいのに画面が白い」のかをログで見分ける
const HEALTH_INTERVAL_MS = 10000;
const RAF_GAP_LOG_MS = 2000; // 表示中に描画ループがこれ以上止まっていたら書く
type ProbeReason = '定期' | '表示' | 'フォーカス' | '読み込み' | '手動';
let probeReason: ProbeReason | null = null;
let lastProbe = '';
let lastFrameAt = performance.now();
let lastRasterAt = performance.now();

// 表示・読み込み・フォーカス・大きさの変化のあと、しばらく毎フレーム描く。
// webview が表に出た直後は、最初の 1 枚が画面に合成されずに捨てられることがあり、
// 変化があったときだけ描く作りだとそのまま背景だけの画面が残るため
const KEEP_DRAWING_MS = 2000;
let keepDrawingUntil = 0;
function keepDrawing() {
  keepDrawingUntil = performance.now() + KEEP_DRAWING_MS;
}

function requestProbe(reason: ProbeReason) {
  if (reason !== '定期') {
    keepDrawing();
  }
  if (!hasModel || contextLost) {
    if (reason === '手動') {
      log(`描画の確認: できない（${!hasModel ? 'モデルが無い' : 'コンテキスト喪失中'}）`);
    }
    return;
  }
  probeReason = reason;
  requestRaster();
}

/**
 * 描いた直後に画面（既定のフレームバッファ）の中央と左上の隅の色を読む。
 * 定期のときは結果が前回と変わったときだけ、それ以外（ユーザーが白い画面に気づいて触ったときなど）は必ず書く
 */
function probe(reason: ProbeReason, sinceLast: number) {
  const gl = renderer.getContext();
  renderer.setRenderTarget(null);
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const pixel = (x: number, y: number) => {
    const b = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return `${b[0]},${b[1]},${b[2]},${b[3]}`; // 4 つ目は alpha（255 でないと透けている）
  };
  const center = pixel(w >> 1, h >> 1);
  const corner = pixel(Math.min(4, w - 1), Math.max(0, h - 5)); // readPixels の y は下から
  const err = gl.getError();
  const cam = camera.position.toArray().map((v) => Number(v.toFixed(2))).join(',');
  const line = [
    `中央 ${center}`,
    `隅 ${corner}`,
    `バッファ ${w}x${h}`,
    `canvas ${canvas.clientWidth}x${canvas.clientHeight}`,
    `画素比 ${window.devicePixelRatio}`,
    `カメラ ${cam}`,
    `半径 ${Number(radius.toPrecision(4))}`,
    gl.isContextLost() ? 'コンテキスト喪失（イベントなし）' : '',
    err ? `glError ${err}` : '',
  ].filter(Boolean).join(' / ');
  if (reason !== '定期' || line !== lastProbe) {
    lastProbe = line;
    log(`描画の確認（${reason}・前回の描画から ${Math.round(sinceLast)}ms）: ${line}`);
  }
}

setInterval(() => {
  if (document.visibilityState !== 'visible') {
    return;
  }
  const gap = performance.now() - lastFrameAt;
  if (gap > RAF_GAP_LOG_MS) {
    log(`描画ループが ${Math.round(gap)}ms 止まっている`);
  }
  if (config.periodicRedraw) {
    requestProbe('定期');
  }
}, HEALTH_INTERVAL_MS);
document.addEventListener('visibilitychange', () => {
  log(`表示状態: ${document.visibilityState}`);
  if (document.visibilityState === 'visible') {
    requestProbe('表示');
  }
});
window.addEventListener('focus', () => requestProbe('フォーカス'));

// ディスプレイをまたいで画素比が変わったら、描画の解像度を合わせ直す
function watchPixelRatio() {
  const dpr = window.devicePixelRatio;
  matchMedia(`(resolution: ${dpr}dppx)`).addEventListener(
    'change',
    () => {
      log(`画素比が変わった: ${dpr} → ${window.devicePixelRatio}`);
      renderer.setPixelRatio(window.devicePixelRatio);
      resize();
      watchPixelRatio();
    },
    { once: true },
  );
}
watchPixelRatio();

// ---- 拡張ホストとのやり取り ----
/** postMessage の直列化で形が変わっても Uint8Array に戻す（Buffer の JSON 形・数値キーのオブジェクトにも対応）*/
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  const obj = data as { type?: string; data?: number[] } & Record<string, number>;
  if (obj && obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return Uint8Array.from(obj.data);
  }
  if (obj && typeof obj === 'object') {
    return Uint8Array.from(Object.values(obj));
  }
  throw new Error('ファイルのデータを受け取れませんでした');
}

/** 読めないファイルでも画面が止まらないよう、失敗は画面に出す */
function tryLoad(data: Uint8Array, fit: boolean) {
  try {
    loadModel(data, fit);
  } catch (err) {
    ui.kicadNotice.hidden = true; // 赤字と案内カードが重ならないようにする
    ui.message.textContent = `モデルを解釈できませんでした: ${err instanceof Error ? err.message : err}`;
    log(ui.message.textContent);
  }
}

// 下の帯の状態表示。expectedMs があれば経過秒数と、前回の時間を目安にした進み具合のバーを出す。
// kicad-cli は途中経過を出さないので、バーは見込み。前回の時間までに 9 割まで進め、超えたら 100% の手前でゆっくり近づける
let statusTimer: ReturnType<typeof setInterval> | undefined;
function setStatus(message: string, expectedMs?: number) {
  if (statusTimer !== undefined) {
    clearInterval(statusTimer);
    statusTimer = undefined;
  }
  ui.status.textContent = message;
  ui.progress.hidden = true;
  if (!message) {
    return;
  }
  const started = performance.now();
  const expected = expectedMs && expectedMs > 0 ? expectedMs : undefined;
  const tick = () => {
    const elapsed = performance.now() - started;
    const sec = Math.floor(elapsed / 1000);
    ui.status.textContent = expected ? `${message} ${sec} 秒 / 前回 ${Math.round(expected / 1000)} 秒` : `${message} ${sec} 秒`;
    if (expected) {
      const ratio = elapsed < expected ? 0.9 * (elapsed / expected) : 0.9 + 0.09 * (1 - Math.exp(-(elapsed - expected) / expected));
      ui.progressBar.style.width = `${(ratio * 100).toFixed(1)}%`;
      ui.progress.hidden = false;
    }
  };
  tick();
  statusTimer = setInterval(tick, 250);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      config = { ...DEFAULT_CONFIG, ...msg.config };
      look = { ...DEFAULT_LOOK, ...(msg.look ?? {}) };
      look.colorMap = { ...(look.colorMap ?? {}) };
      look.hiddenLayers = [...(look.hiddenLayers ?? [])];
      if (!MATERIALS[look.material]) {
        look.material = DEFAULT_LOOK.material;
      }
      // 「KiCad で開く」は基板のときだけ。ツールバーは右端まで伸ばしてボタンを右に寄せる
      ui.openKicad.hidden = !msg.isPcb;
      ui.panel.classList.toggle('pcb', !!msg.isPcb);
      applyLook();
      break;
    case 'config': {
      const creaseChanged = msg.config.creaseAngle !== config.creaseAngle;
      config = { ...DEFAULT_CONFIG, ...msg.config };
      if (creaseChanged && lastData) {
        tryLoad(lastData, false);
      } else if (hasModel) {
        layoutScene();
        onCameraChange();
      }
      break;
    }
    case 'load':
    case 'reload':
      ui.name.textContent = msg.name;
      if (msg.type === 'reload' && !receivedLoad) {
        log('最初の load より前の reload を捨てた');
        break; // 最初の load より前に届いた再読込は捨てる（すぐ後に load が来る）
      }
      lastData = toBytes(msg.data);
      log(`${msg.type} を受け取った: ${lastData.byteLength} バイト`);
      if (msg.type === 'load' && !receivedLoad) {
        receivedLoad = true;
        const saved = vscode.getState() as Partial<ViewState> | undefined;
        if (saved) {
          // 裏から戻って webview が作り直されたとき：前の視点と計測で再開する
          tryLoad(lastData, false);
          const restored = hasModel && restoreView(saved);
          log(restored ? `視点を戻した: カメラ ${saved.camera?.join(',')} 注視点 ${saved.target?.join(',')}` : '視点を戻せず全体表示にした');
          if (hasModel && !restored) {
            fitView();
          }
          requestProbe('読み込み');
          break;
        }
      }
      if (msg.type === 'load') {
        measure.clear(); // 別のファイルの計測は意味が無い（再読込では形を直しながら測り直せるよう残す）
      }
      // 再読込では視点を保つ（形を直しながら同じ角度で見比べられるように）
      tryLoad(lastData, msg.type === 'load' || !hasModel);
      requestProbe('読み込み');
      break;
    case 'probe':
      requestProbe('手動');
      break;
    case 'error':
      ui.kicadNotice.hidden = true; // 赤字と案内カードが重ならないようにする
      ui.message.textContent = msg.message;
      break;
    case 'status':
      setStatus(msg.message, msg.expectedMs);
      break;
    case 'kicadMissing':
      // 案内カードと赤字が同時に出ると混乱するので、赤字は消す
      ui.message.textContent = '';
      setStatus(''); // 帯の「書き出し中…」を残さない
      ui.kicadNoticeText.textContent = msg.reason === 'tooOld'
        ? `KiCad ${msg.version ? `${msg.version} ` : ''}は GLB を書き出せません。KiCad 8 以降に更新してください`
        : 'KiCad が見つかりません。KiCad をインストールしてください';
      ui.kicadNotice.hidden = false;
      break;
  }
});

{
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '不明';
  const attrs = gl.getContextAttributes();
  log(
    `webview 起動: three r${THREE.REVISION} / ${gl.getParameter(gl.VERSION)} / GPU ${gpu} / 画素比 ${window.devicePixelRatio}` +
      ` / canvas ${canvas.clientWidth}x${canvas.clientHeight} / 属性 ${JSON.stringify(attrs)}`,
  );
}
resize();
frame();
vscode.postMessage({ type: 'ready' });
