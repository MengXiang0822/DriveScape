// ============================================================
// textures.js - 程序化纹理（全部由 Canvas 生成，无外部资源）
//  天空背景 / 地形细节 / 沥青路面 / 中线虚线 / 起跑线棋盘 / 云 / 太阳光晕
// 说明：颜色类贴图按 sRGB 处理；粗糙度等数据类贴图保持线性。
// ============================================================

import * as THREE from 'three';

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function finish(cv, { srgb = true, repeat = null } = {}) {
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  tex.needsUpdate = true;
  return tex;
}

/**
 * 天空：等距柱状（equirect）垂直渐变。
 * 地平线附近取与雾相同的颜色，保证远景与天空无缝衔接。
 */
export function createSkyTexture() {
  const w = 1024;
  const h = 512;
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, '#3f74c0'); // 天顶
  g.addColorStop(0.3, '#6ba3de');
  g.addColorStop(0.47, '#9fd8ef'); // 地平线（= 雾色 SKY）
  g.addColorStop(0.53, '#cfe7f2');
  g.addColorStop(1.0, '#e2eef4'); // 地平线以下（多被地形遮挡）
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const tex = finish(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

/**
 * 地形细节：近白底 + 颗粒/草簇，平均亮度接近 1。
 * 与地形顶点色相乘，只做细节调制，不改变整体配色。
 */
export function createGroundDetailTexture() {
  const s = 256;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#f6f6f4';
  ctx.fillRect(0, 0, s, s);

  // 土壤/碎石颗粒
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 0.6 + Math.random() * 1.5;
    const light = Math.random() > 0.5;
    ctx.fillStyle = light
      ? `rgba(255,255,255,${(0.04 + Math.random() * 0.16).toFixed(3)})`
      : `rgba(70,80,50,${(0.02 + Math.random() * 0.1).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 草簇短线（增强“草地”质感）
  ctx.lineWidth = 1;
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const len = 2 + Math.random() * 5;
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.0;
    const g = 140 + Math.random() * 70;
    ctx.strokeStyle = `rgba(${(90 + Math.random() * 40) | 0},${g | 0},${(70 + Math.random() * 40) | 0},${(0.1 + Math.random() * 0.16).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  return finish(cv);
}

/** 沥青路面：颜色贴图 + 粗糙度贴图（水渍/补丁处略光滑，形成细微反光变化） */
export function createAsphaltTextures() {
  const s = 256;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#42474d';
  ctx.fillRect(0, 0, s, s);

  // 骨料颗粒
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 0.5 + Math.random() * 1.4;
    const light = Math.random() > 0.55;
    ctx.fillStyle = light
      ? `rgba(255,255,255,${(0.03 + Math.random() * 0.1).toFixed(3)})`
      : `rgba(0,0,0,${(0.04 + Math.random() * 0.15).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 修补/油渍色块
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 6 + Math.random() * 26;
    ctx.fillStyle = Math.random() > 0.5
      ? `rgba(30,32,36,${(0.05 + Math.random() * 0.12).toFixed(3)})`
      : `rgba(120,126,134,${(0.03 + Math.random() * 0.08).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 细裂纹
  ctx.strokeStyle = 'rgba(22,24,27,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    let x = Math.random() * s;
    let y = Math.random() * s;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 5; k++) {
      x += (Math.random() - 0.5) * 46;
      y += (Math.random() - 0.5) * 46;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const map = finish(cv);

  // 粗糙度：亮 = 更光滑（有水膜/被压实），暗 = 更粗糙
  const rv = makeCanvas(s, s);
  const rctx = rv.getContext('2d');
  rctx.fillStyle = '#b4b4b4';
  rctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2400; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 2 + Math.random() * 14;
    const a = 0.05 + Math.random() * 0.16;
    rctx.fillStyle = Math.random() > 0.5
      ? `rgba(255,255,255,${a.toFixed(3)})`
      : `rgba(70,70,70,${a.toFixed(3)})`;
    rctx.beginPath();
    rctx.arc(x, y, r, 0, Math.PI * 2);
    rctx.fill();
  }
  const roughnessMap = finish(rv, { srgb: false });

  return { map, roughnessMap };
}

/** 中线：黄色虚线（贴图左半实线、右半透明；沿路面弧长方向平铺） */
export function createDashedLineTexture() {
  const w = 64;
  const h = 16;
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(0, 3, w * 0.55, h - 6);
  const tex = finish(cv);
  return tex;
}

/** 起跑线棋盘（2×2 格；靠 repeat 拼出方格带） */
export function createCheckerTexture() {
  const s = 64;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  const c = s / 2;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      ctx.fillStyle = (i + j) % 2 === 0 ? '#f2f2f2' : '#1d1f22';
      ctx.fillRect(i * c, j * c, c, c);
    }
  }
  return finish(cv);
}

/** 云：多团柔和径向渐变叠加成蓬松云朵 */
export function createCloudTexture() {
  const s = 256;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  for (let i = 0; i < 15; i++) {
    const x = s * (0.18 + Math.random() * 0.64);
    const y = s * (0.34 + Math.random() * 0.32);
    const r = s * (0.12 + Math.random() * 0.18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.5, 'rgba(252,253,255,0.6)');
    g.addColorStop(1, 'rgba(250,252,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return finish(cv);
}

/** 太阳光晕：中心暖白 → 外缘透明（叠加混合） */
export function createSunGlowTexture() {
  const s = 256;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  const c = s / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,252,238,0.95)');
  g.addColorStop(0.16, 'rgba(255,240,200,0.55)');
  g.addColorStop(0.45, 'rgba(255,228,175,0.18)');
  g.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return finish(cv);
}

/**
 * 农田耕垄：浅色底 + 深色垄沟条纹。
 * 与材质 color 相乘即可得到不同作物色（麦黄/嫩绿/土褐）的田地。
 */
export function createFieldTexture() {
  const s = 128;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#eae7dd';
  ctx.fillRect(0, 0, s, s);
  const rows = 16;
  for (let i = 0; i < rows; i++) {
    const y = (i + 0.5) * (s / rows);
    const hh = (s / rows) * (0.3 + Math.random() * 0.34);
    ctx.fillStyle = `rgba(86,76,56,${(0.16 + Math.random() * 0.22).toFixed(3)})`;
    ctx.fillRect(0, y - hh / 2, s, hh);
  }
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(70,60,40,0.12)';
    ctx.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6);
  }
  // 田埂：四周一圈深色窄边，让相邻田块界限分明（拼布效果）
  const bw = s * 0.045;
  ctx.fillStyle = 'rgba(84,100,62,0.6)';
  ctx.fillRect(0, 0, s, bw);
  ctx.fillRect(0, s - bw, s, bw);
  ctx.fillRect(0, 0, bw, s);
  ctx.fillRect(s - bw, 0, bw, s);
  return finish(cv);
}

/**
 * 草地色斑：柔和羽化边缘的斑驳色块（近白底，靠实例色着色）。
 * 平铺到地面后形成野花田 / 枯草块 / 鲜草块等自然色斑，打破大片单色地面。
 * 四边做了径向遮罩，保证淡出，不会出现方块硬边。
 */
export function createGrassPatchTexture() {
  const s = 256;
  const cv = makeCanvas(s, s);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  const c = s / 2;

  // 多个柔和圆斑叠加，形成不规则轮廓
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.random() * s * 0.26;
    const x = c + Math.cos(a) * rr;
    const y = c + Math.sin(a) * rr;
    const r = s * (0.15 + Math.random() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 细节：细碎斑点（作物/花簇感）
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(120,140,80,0.22)';
    ctx.fillRect(x, y, 2, 2);
  }

  // 整体径向遮罩：四边淡出，避免硬边
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(c, c, 0, c, c, c);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.6, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, s, s);
  ctx.globalCompositeOperation = 'source-over';

  return finish(cv);
}
