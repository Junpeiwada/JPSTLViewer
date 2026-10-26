// 材質プリセットと背景プリセット。
// 値は 3D プリント品の見え方に寄せて目で合わせたもの（物理的な測定値ではない）。
import * as THREE from 'three';

export interface Look {
  material: string;
  color: string;
  background: string;
  useStlColor: boolean; // STL に色が埋め込まれていればそれで塗る
  keyLight: number;     // キーライト（影付きの点光源）のモデル中心での照度
  fillLight: number;    // 床下からの補助光のモデル中心での照度
  envLight: number;     // 環境光（IBL）の強さ
}

/** ライトのスライダー（パネルの並び順） */
export const LIGHTS: { key: 'keyLight' | 'fillLight' | 'envLight'; label: string; title: string; max: number }[] = [
  { key: 'keyLight', label: 'キー', title: '左前の上から当てる影付きの主光源', max: 4 },
  { key: 'fillLight', label: '補助', title: '床下から当てて底面・裏側を見やすくする光（影なし）', max: 3 },
  { key: 'envLight', label: '環境', title: '全方向からの柔らかい光（スタジオ風の部屋）', max: 3 },
];

interface MaterialPreset {
  label: string;
  params: THREE.MeshPhysicalMaterialParameters;
}

export const MATERIALS: Record<string, MaterialPreset> = {
  pla_matte: {
    label: 'PLA マット',
    // 細かい積層の凹凸で鏡面が散るので、粗さ高め＋わずかなシーンで布っぽい柔らかさを出す
    params: { roughness: 0.62, sheen: 0.25, sheenRoughness: 0.8 },
  },
  pla: {
    label: 'PLA',
    params: { roughness: 0.4, clearcoat: 0.15, clearcoatRoughness: 0.45 },
  },
  pla_silk: {
    label: 'PLA シルク',
    // シルクは金属光沢に近い。地の色がハイライトにも乗るよう金属度を半分入れる
    params: { roughness: 0.26, metalness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.2 },
  },
  petg: {
    label: 'PETG',
    params: { roughness: 0.14, clearcoat: 0.8, clearcoatRoughness: 0.06 },
  },
  petg_clear: {
    label: 'PETG クリア',
    // 透過は厚み（mm）を持たせないと板ガラスのように薄く見える
    params: { roughness: 0.1, transmission: 0.92, thickness: 4, ior: 1.57, attenuationDistance: 200 },
  },
  resin: {
    label: 'レジン',
    params: { roughness: 0.3, clearcoat: 0.45, clearcoatRoughness: 0.15 },
  },
  carbon: {
    label: 'カーボン入り',
    params: { roughness: 0.82 },
  },
  aluminum: {
    label: 'アルミ',
    params: { roughness: 0.32, metalness: 1 },
  },
};

interface BackgroundPreset {
  label: string;
  background: string;
  floor: string;
  dark: boolean;
}

export const BACKGROUNDS: Record<string, BackgroundPreset> = {
  studio_light: { label: 'スタジオ（明）', background: '#dfe2e7', floor: '#b3b7be', dark: false },
  studio_dark: { label: 'スタジオ（暗）', background: '#1f2226', floor: '#2a2d32', dark: true },
};

export const DEFAULT_LOOK: Look = {
  material: 'pla_matte',
  color: '#8f9aa8',
  background: 'studio_light',
  useStlColor: true,
  // 環境光を絞って点光源 2 灯で陰影を付けると形が読みやすい（実機で目で合わせた値・2026-10-26）
  keyLight: 1.6,
  fillLight: 1.0,
  envLight: 0.3,
};

// プリセットを切り替えたときに前の材質の値（透過など）が残らないよう、毎回ここから戻す
const BASE = new THREE.MeshPhysicalMaterial();

/** vertexColors が true なら STL の頂点色で塗る（本体色は白にして頂点色をそのまま出す） */
export function applyMaterial(mat: THREE.MeshPhysicalMaterial, key: string, color: string, vertexColors: boolean) {
  const preset = MATERIALS[key] ?? MATERIALS.pla_matte;
  const before = mat.transmission > 0;
  const beforeVertex = mat.vertexColors;
  mat.roughness = BASE.roughness;
  mat.metalness = BASE.metalness;
  mat.clearcoat = BASE.clearcoat;
  mat.clearcoatRoughness = BASE.clearcoatRoughness;
  mat.sheen = BASE.sheen;
  mat.sheenRoughness = BASE.sheenRoughness;
  mat.transmission = BASE.transmission;
  mat.thickness = BASE.thickness;
  mat.ior = BASE.ior;
  mat.attenuationDistance = BASE.attenuationDistance;
  mat.setValues(preset.params);
  const base = vertexColors ? '#ffffff' : color;
  mat.vertexColors = vertexColors;
  mat.color.set(base);
  mat.sheenColor.set(base);
  // 透過色は本体色と同じにして「色付きの透明樹脂」に見せる
  mat.attenuationColor.set(base);
  // 透過・頂点色の有無でシェーダが変わるので、そのときだけ作り直させる
  if (before !== mat.transmission > 0 || beforeVertex !== vertexColors) {
    mat.needsUpdate = true;
  }
}
