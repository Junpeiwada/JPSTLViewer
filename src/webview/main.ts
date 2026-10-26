// STL プレビューの webview 本体。
// リアルタイム PBR（環境光 IBL・ソフトシャドウ・GTAO・MSAA）で描く。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { BACKGROUNDS, DEFAULT_LOOK, LIGHTS, Look, MATERIALS, applyMaterial } from './looks';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

interface Config {
  creaseAngle: number;
  floatRatio: number; // 床から浮かせる量（モデル半径に対する割合）
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
</div>
<div id="colorPanel" class="popover" hidden>
  <div class="row"><input id="color" type="color"><input id="colorHex" type="text" maxlength="7" spellcheck="false"></div>
  <label id="stlColorWrap" hidden title="STL に埋め込まれた色で塗る"><input id="stlColor" type="checkbox"> STL の色を使う</label>
  <div id="stlColors" hidden></div>
  <button id="copyColor" title="ファイル名と色をクリップボードにコピー（AI に「このパーツをこの色に」と頼む用）">色をコピー</button>
</div>
<div id="lights" class="popover" hidden>
  ${LIGHTS.map((l) => `<label title="${l.title}"><span>${l.label}</span><input id="${l.key}" type="range" min="0" max="${l.max}" step="0.05"><output id="${l.key}Val"></output></label>`).join('')}
  <button id="lightsReset">既定に戻す</button>
</div>
<div id="info"><span id="name"></span><span id="dims"></span></div>
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
  copyColor: document.getElementById('copyColor') as HTMLButtonElement,
  lightsBtn: document.getElementById('lightsBtn') as HTMLButtonElement,
  lights: document.getElementById('lights') as HTMLElement,
  lightsReset: document.getElementById('lightsReset') as HTMLButtonElement,
  name: document.getElementById('name') as HTMLElement,
  dims: document.getElementById('dims') as HTMLElement,
  message: document.getElementById('message') as HTMLElement,
};

// 例外で黙って真っ白にならないよう、捕まえ損ねたエラーは画面に出す
const showError = (err: unknown) => {
  ui.message.textContent = `エラー: ${err instanceof Error ? err.message : String(err)}`;
};
window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

const DEFAULT_CONFIG: Config = { creaseAngle: 30, floatRatio: 0.05 };
let config: Config = { ...DEFAULT_CONFIG };
let look: Look = { ...DEFAULT_LOOK };
let lastData: Uint8Array | null = null;
let hasModel = false;
let stlHasColors = false; // 読み込んだ STL に色が埋め込まれているか（ヘッダの COLOR=）
let palette: StlPalette | null = null; // 読み込んだ STL の色の一覧と、三角形ごとの色の番号

/** STL に埋め込まれた色の一覧（多い順）と、三角形ごとの色の番号 */
interface StlPalette {
  colors: string[];   // 元の色（"#rrggbb"。5 ビットの値を 8 ビットに広げたもの）
  shares: number[];   // 表面積に対する割合
  faceColor: Uint16Array;
}

/**
 * バイナリ STL の色（STLLoader と同じ解釈）を読み、色の一覧を作る。色が無ければ null。
 * ヘッダの COLOR= ＋ RGBA が既定色、三角形ごとの予備 2 バイトの最上位ビットが 0 なら r | g<<5 | b<<10（各 5 ビット）の固有色
 */
function readStlPalette(data: Uint8Array): StlPalette | null {
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
  const counts: number[] = [];   // 色ごとの表面積
  const raw = new Uint16Array(faces);
  let total = 0;
  for (let f = 0; f < faces; f++) {
    const o = 84 + f * 50 + 12;
    const p = Array.from({ length: 9 }, (_, i) => view.getFloat32(o + i * 4, true));
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    total += area;
    const packed = view.getUint16(84 + f * 50 + 48, true);
    const hex = (packed & 0x8000) === 0
      ? hex8(...([0, 5, 10].map((s) => Math.round((((packed >> s) & 0x1f) * 255) / 31)) as [number, number, number]))
      : defaultHex;
    let k = index.get(hex);
    if (k === undefined) {
      k = counts.length;
      index.set(hex, k);
      counts.push(0);
    }
    counts[k] += area;
    raw[f] = k;
  }
  // 多い順に並べ直す（パネルの上ほど面積の大きい色）
  const order = counts.map((_, k) => k).sort((a, b) => counts[b] - counts[a]);
  const rank = new Uint16Array(counts.length);
  order.forEach((k, r) => (rank[k] = r));
  const keys = [...index.keys()];
  return {
    colors: order.map((k) => keys[k]),
    shares: order.map((k) => counts[k] / Math.max(total, 1e-12)),
    faceColor: raw.map((k) => rank[k]),
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
  const arr = new Float32Array(palette.faceColor.length * 9);
  palette.faceColor.forEach((k, f) => {
    const [r, g, b] = linear[k];
    for (let v = 0; v < 3; v++) {
      arr.set([r, g, b], f * 9 + v * 3);
    }
  });
  geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  requestRaster();
}

/** 色パネルに、STL の色ごとの行（ピッカー・16 進・元の色と割合・元に戻す）を作る。読み込むたびに作り直す */
function buildStlColorRows() {
  ui.stlColors.replaceChildren();
  if (!palette) {
    return;
  }
  palette.colors.forEach((orig, k) => {
    const row = document.createElement('div');
    row.className = 'stlColorRow';
    row.innerHTML = `<input type="color"><input type="text" maxlength="7" spellcheck="false">
<span class="orig" title="STL の元の色と、表面積に対する割合"><i></i>${orig} ${Math.max(palette!.shares[k] * 100, 0.1).toFixed(1)}%</span>
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(window.devicePixelRatio);
// PBR Neutral はフィラメントの色を崩さずにハイライトだけ丸める（ACES ほど彩度が落ちない）
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;

// ---- 環境光：RoomEnvironment（スタジオ風の部屋）を PMREM に焼いて IBL にする ----
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

// 背景は単色。床は霧で背景色に溶かし、床の縁（地平線）を見せない
const backgroundColor = new THREE.Color();
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

// ---- STL の読み込みと配置 ----
const loader = new STLLoader();
let radius = 1;
let lightDist = 1; // ライトからモデル中心までの距離（layoutScene で決める）

function loadStl(data: Uint8Array, fit: boolean) {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  let geom = loader.parse(buffer);
  // build123d などの CAD は Z 上向き、three は Y 上向き
  geom.rotateX(-Math.PI / 2);
  if (config.creaseAngle > 0) {
    // 曲面は法線を平均して滑らかに、折れ目は STL の面法線のまま残す
    geom = toCreasedNormals(geom, THREE.MathUtils.degToRad(config.creaseAngle));
  }
  geom.computeBoundingBox();
  const box = geom.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // 床（Y=0）に接地させ、XZ は原点中心に
  geom.translate(-center.x, -box.min.y, -center.z);
  geom.computeBoundingSphere();

  model.geometry.dispose();
  model.geometry = geom;
  radius = Math.max(geom.boundingSphere!.radius, 1e-3);
  hasModel = true;
  palette = readStlPalette(data);
  stlHasColors = palette !== null;
  applyStlColors();
  buildStlColorRows();
  applyLook();

  layoutScene();
  if (fit) {
    fitView();
  }

  // 表示は CAD の軸で（STL の X × Y × Z）
  const tris = geom.attributes.position.count / 3;
  ui.dims.textContent = `${size.x.toFixed(2)} × ${size.z.toFixed(2)} × ${size.y.toFixed(2)} mm ・ ${tris.toLocaleString()} 三角形`;
  ui.message.textContent = '';
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
}

// ---- 見た目（材質・色・背景・ライト）----
function applyLook() {
  applyLights();
  const useStlColor = stlHasColors && look.useStlColor;
  applyMaterial(modelMat, look.material, look.color, useStlColor);
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
  // STL の色で塗っているときは、ボタンの見本も「STL の色」と分かる斜線にする
  ui.swatch.style.background = useStlColor
    ? 'repeating-linear-gradient(45deg, #999 0 3px, #ddd 3px 6px)'
    : look.color;
  ui.stlColor.checked = look.useStlColor;
  ui.stlColorWrap.hidden = !stlHasColors;
  // STL の色で塗っているときは、1 色のピッカーの代わりに STL の色ごとの行を出す
  ui.colorRow.hidden = useStlColor;
  ui.stlColors.hidden = !useStlColor;
  syncStlColorRows();
  ui.background.value = look.background;
  for (const l of LIGHTS) {
    (document.getElementById(l.key) as HTMLInputElement).value = String(look[l.key]);
    (document.getElementById(`${l.key}Val`) as HTMLOutputElement).value = look[l.key].toFixed(2);
  }
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
ui.lightsReset.addEventListener('click', () =>
  setLook({ keyLight: DEFAULT_LOOK.keyLight, fillLight: DEFAULT_LOOK.fillLight, envLight: DEFAULT_LOOK.envLight }),
);
window.addEventListener('keydown', (e) => {
  if ((e.key === 'f' || e.key === 'F') && !(e.target instanceof HTMLInputElement)) {
    fitView();
  }
});

// ---- 描画ループ（変化があったフレームだけ描く）----
let rasterDirty = true;

function requestRaster() {
  rasterDirty = true;
}

function onCameraChange() {
  // 霧は注視点からの距離で掛ける（ズームしてもモデルが霞まないように）
  const d = camera.position.distanceTo(controls.target);
  fog.near = d + radius * FOG_NEAR;
  fog.far = d + radius * FOG_FAR;
  requestRaster();
}
controls.addEventListener('change', onCameraChange);

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
  onCameraChange();
}
new ResizeObserver(resize).observe(canvas);

function frame() {
  requestAnimationFrame(frame);
  controls.update();
  if (!hasModel) {
    return;
  }
  if (rasterDirty) {
    composer.render();
    rasterDirty = false;
  }
}

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
  throw new Error('STL のデータを受け取れませんでした');
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      config = { ...DEFAULT_CONFIG, ...msg.config };
      look = { ...DEFAULT_LOOK, ...(msg.look ?? {}) };
      look.colorMap = { ...(look.colorMap ?? {}) };
      if (!MATERIALS[look.material]) {
        look.material = DEFAULT_LOOK.material;
      }
      applyLook();
      break;
    case 'config': {
      const creaseChanged = msg.config.creaseAngle !== config.creaseAngle;
      config = { ...DEFAULT_CONFIG, ...msg.config };
      if (creaseChanged && lastData) {
        loadStl(lastData, false);
      } else if (hasModel) {
        layoutScene();
        onCameraChange();
      }
      break;
    }
    case 'load':
    case 'reload':
      ui.name.textContent = msg.name;
      lastData = toBytes(msg.data);
      try {
        // 再読込では視点を保つ（形を直しながら同じ角度で見比べられるように）
        loadStl(lastData, msg.type === 'load' || !hasModel);
      } catch (err) {
        ui.message.textContent = `STL を解釈できませんでした: ${err}`;
      }
      break;
    case 'error':
      ui.message.textContent = msg.message;
      break;
  }
});

resize();
frame();
vscode.postMessage({ type: 'ready' });
