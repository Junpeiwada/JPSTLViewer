// 長さの計測。モデル上を 2 回クリックした間の距離を、定規の目盛り付きの線で画面に重ねて描く。
// 目盛りは画面上の 2D（SVG）で描くので、どの角度・どの大きさで見ても同じ太さで読める。
import * as THREE from 'three';

// ===== 見た目の定数 ===================================================
const CLICK_PX = 4;          // 押してから離すまでにこれ以上動いたらドラッグ（回転・パン）とみなす
const SNAP_PX = 10;          // クリック位置から画面上でこの距離以内の頂点に吸着する
const MIN_TICK_PX = 5;       // 細かい目盛りの間隔がこれより詰まるなら、1 桁粗い目盛りにする
const TICK_STEPS = [1, 10, 100, 1000, 10000]; // 細かい目盛りの間隔の候補（mm）
const TICK_LEN = { minor: 5, mid: 8, major: 12 }; // 目盛りの長さ（px）。5 目盛りごとに中、10 目盛りごとに長く
const MIN_LABEL_PX = 36;     // 数字を添える目盛り（長い・中くらい）どうしがこれ以上離れていれば数字を添える
const END_CAP = 7;           // 端点の両側に出す止め線の長さ（px）
// ======================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Pick {
  point: THREE.Vector3; // モデルのローカル座標（mm）
  snapped: boolean;     // 頂点に吸着したか
}

export class Measure {
  active = false;
  private segments: [THREE.Vector3, THREE.Vector3][] = []; // 確定した計測（モデルのローカル座標）
  private pending: THREE.Vector3 | null = null;            // 1 点目だけ置いた状態
  private hover: Pick | null = null;                        // カーソルの下の点
  private pointer: { x: number; y: number; alt: boolean } | null = null;
  private pointerMoved = false;
  private down: { x: number; y: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly svg: SVGSVGElement;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly model: THREE.Mesh,
    private readonly onChange: () => void,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.id = 'measure';
    canvas.after(this.svg);

    canvas.addEventListener('pointerdown', (e) => {
      if (this.active && e.button === 0) {
        this.down = { x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (this.active && d && e.button === 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < CLICK_PX) {
        this.click(e.clientX, e.clientY, e.altKey);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY, alt: e.altKey };
      this.pointerMoved = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.pointerMoved = true;
    });
  }

  get hasSegments(): boolean {
    return this.segments.length > 0 || this.pending !== null;
  }

  setActive(on: boolean) {
    this.active = on;
    this.pending = null;
    this.hover = null;
    document.body.classList.toggle('measuring', on);
    this.onChange();
  }

  /** 置きかけの 1 点目があればそれだけ、無ければすべての計測を消す */
  cancel() {
    if (this.pending) {
      this.pending = null;
    } else {
      this.segments = [];
    }
    this.onChange();
  }

  clear() {
    this.segments = [];
    this.pending = null;
    this.onChange();
  }

  /** 描画ループから毎フレーム呼ぶ。カーソルが動いたときだけレイを飛ばす（重いメッシュでも 1 フレーム 1 回まで）*/
  updateHover() {
    if (!this.pointerMoved) {
      return;
    }
    this.pointerMoved = false;
    const hover = this.active && this.pointer ? this.pick(this.pointer.x, this.pointer.y, this.pointer.alt) : null;
    if (hover || this.hover) {
      this.hover = hover;
      this.onChange();
    }
  }

  private click(x: number, y: number, alt: boolean) {
    const hit = this.pick(x, y, alt);
    if (!hit) {
      return;
    }
    if (this.pending) {
      if (hit.point.distanceTo(this.pending) < 1e-6) {
        return; // 同じ点（ダブルクリックや同じ頂点への吸着）では長さ 0 の線を作らない
      }
      this.segments.push([this.pending, hit.point]);
      this.pending = null;
    } else {
      this.pending = hit.point;
    }
    this.onChange();
  }

  /** 画面上の点の下にあるモデル上の点。当たった三角形の頂点が近ければそこへ吸着する（Alt で吸着しない）*/
  private pick(x: number, y: number, noSnap: boolean): Pick | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.model, false)[0];
    if (!hit || !hit.face) {
      return null;
    }
    const local = this.model.worldToLocal(hit.point.clone());
    if (noSnap) {
      return { point: local, snapped: false };
    }
    const pos = this.model.geometry.attributes.position;
    let best: THREE.Vector3 | null = null;
    let bestPx = SNAP_PX;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      const s = this.toScreen(v);
      if (s) {
        const px = Math.hypot(s.x - (x - rect.left), s.y - (y - rect.top));
        if (px < bestPx) {
          bestPx = px;
          best = v;
        }
      }
    }
    return best ? { point: best, snapped: true } : { point: local, snapped: false };
  }

  /** モデルのローカル座標を canvas 上の px に。カメラの後ろなら null */
  private toScreen(local: THREE.Vector3): THREE.Vector2 | null {
    const p = local.clone().applyMatrix4(this.model.matrixWorld).project(this.camera);
    if (p.z < -1 || p.z > 1) {
      return null;
    }
    return new THREE.Vector2(((p.x + 1) / 2) * this.canvas.clientWidth, ((1 - p.y) / 2) * this.canvas.clientHeight);
  }

  /** 計測の線と目盛りを描き直す。カメラ・モデル・カーソルが変わるたびに呼ぶ */
  draw() {
    this.model.updateMatrixWorld();
    this.svg.replaceChildren();
    for (const [a, b] of this.segments) {
      this.drawRuler(a, b, false);
    }
    if (this.pending) {
      // 1 点目からカーソルまでを仮の定規で見せる
      if (this.hover) {
        this.drawRuler(this.pending, this.hover.point, true);
      }
      this.drawPoint(this.pending, false);
    }
    if (this.hover) {
      this.drawPoint(this.hover.point, this.hover.snapped);
    }
  }

  private drawPoint(local: THREE.Vector3, snapped: boolean) {
    const s = this.toScreen(local);
    if (s) {
      this.svg.append(el('circle', { cx: s.x, cy: s.y, r: snapped ? 5 : 3.5, class: snapped ? 'pt snapped' : 'pt' }));
    }
  }

  private drawRuler(a: THREE.Vector3, b: THREE.Vector3, preview: boolean) {
    const sa = this.toScreen(a);
    const sb = this.toScreen(b);
    if (!sa || !sb) {
      return;
    }
    const lengthMm = a.distanceTo(b);
    const px = sa.distanceTo(sb);
    const g = el('g', { class: preview ? 'ruler preview' : 'ruler' });
    this.svg.append(g);

    // 線の向きと、目盛りを出す側（画面の上寄りの側）
    const dir = px > 1e-6 ? sb.clone().sub(sa).divideScalar(px) : new THREE.Vector2(1, 0);
    const n = new THREE.Vector2(-dir.y, dir.x);
    if (n.y > 0) {
      n.negate();
    }
    const line = (p: THREE.Vector2, len0: number, len1: number, cls: string) =>
      g.append(el('line', {
        x1: p.x + n.x * len0, y1: p.y + n.y * len0, x2: p.x + n.x * len1, y2: p.y + n.y * len1, class: cls,
      }));

    g.append(el('line', { x1: sa.x, y1: sa.y, x2: sb.x, y2: sb.y, class: 'axis' }));
    line(sa, -END_CAP, END_CAP, 'cap');
    line(sb, -END_CAP, END_CAP, 'cap');

    // 細かい目盛りの間隔は、画面上で詰まりすぎない最小の桁（1 / 10 / 100 mm …）
    const pxPerMm = lengthMm > 0 ? px / lengthMm : 0;
    const step = TICK_STEPS.find((s) => s * pxPerMm >= MIN_TICK_PX);
    if (step !== undefined) {
      const labelMid = step * 5 * pxPerMm >= MIN_LABEL_PX;
      const labelMajor = step * 10 * pxPerMm >= MIN_LABEL_PX;
      for (let k = 1; k * step < lengthMm - 1e-9; k++) {
        const p = sa.clone().addScaledVector(dir, k * step * pxPerMm);
        const kind = k % 10 === 0 ? 'major' : k % 5 === 0 ? 'mid' : 'minor';
        line(p, 0, TICK_LEN[kind], `tick ${kind}`);
        if ((kind === 'major' && labelMajor) || (kind === 'mid' && labelMid)) {
          const t = p.clone().addScaledVector(n, TICK_LEN[kind] + 4);
          g.append(text(t, n, String(k * step), 'tickLabel'));
        }
      }
    }

    // 長さは目盛りと反対側の中ほどに。軸ごとの差は CAD の軸で（three の X, -Z, Y がファイルの X, Y, Z）
    const delta = b.clone().sub(a);
    const out = n.clone().negate();
    const mid = sa.clone().add(sb).multiplyScalar(0.5).addScaledVector(out, 10);
    const label = text(mid, out, `${lengthMm.toFixed(2)} mm`, 'length');
    const axes = document.createElementNS(SVG_NS, 'tspan');
    axes.setAttribute('class', 'axes');
    axes.setAttribute('x', String(mid.x));
    axes.setAttribute('dy', '1.3em');
    axes.textContent = `X ${Math.abs(delta.x).toFixed(2)}  Y ${Math.abs(delta.z).toFixed(2)}  Z ${Math.abs(delta.y).toFixed(2)}`;
    label.append(axes);
    g.append(label);
  }
}

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }
  return e;
}

/** at から out の向きへ伸びるように置く文字（線から離れる側に寄せて、線に重ならないようにする）*/
function text(at: THREE.Vector2, out: THREE.Vector2, s: string, cls: string): SVGElement {
  const anchor = out.x > 0.5 ? 'start' : out.x < -0.5 ? 'end' : 'middle';
  // 上へ伸ばすなら下端（複数行なら上へずらす）、下へ伸ばすなら上端、横なら縦の中央を at に合わせる
  const baseline = out.y < -0.5 ? 'auto' : out.y > 0.5 ? 'hanging' : 'central';
  const t = el('text', { x: at.x, y: at.y, 'text-anchor': anchor, 'dominant-baseline': baseline, class: cls });
  t.textContent = s;
  return t;
}
