// ============================================================
// effects.js - 粒子视觉特效（对象池，零运行时分配）
//  - 漂移烟尘：后轮侧滑/手刹时喷出的灰烟
//  - 速度线：高速时镜头前掠过的线性拖影
// ============================================================

import * as THREE from 'three';

function makeSmokeTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(205,205,205,0.9)');
  g.addColorStop(0.6, 'rgba(180,180,180,0.45)');
  g.addColorStop(1, 'rgba(160,160,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

export class Effects {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();

    // ---------- 烟尘池 ----------
    this.SMOKE_MAX = 90;
    this.smokes = [];
    const smokeTex = makeSmokeTexture();
    for (let i = 0; i < this.SMOKE_MAX; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.scale.set(0.1, 0.1, 0.1);
      scene.add(sp);
      this.smokes.push({
        sp, life: 0, maxLife: 1, vel: new THREE.Vector3(),
        grow: 3, base: 0.6, maxOp: 0.5,
      });
    }
    this._smokeIdx = 0;

    // ---------- 速度线：屏幕两侧的放射线叠层 ----------
    this._makeSpeedCanvas();
  }

  /**
   * 每帧更新
   * @param {object} s { dt, speedKmh, drifting, rearWorld:[Vector3,Vector3], carForward, worldUp }
   */
  update(s) {
    this._updateSmoke(s);
    this._updateStreaks(s);
  }

  // ------------------------------------------------------------
  _updateSmoke(s) {
    const dt = s.dt;
    for (let i = 0; i < this.smokes.length; i++) {
      const it = this.smokes[i];
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.sp.visible = false;
        continue;
      }
      const t = 1 - it.life / it.maxLife; // 0 → 1 生命周期进度
      it.sp.position.addScaledVector(it.vel, dt);
      it.vel.y += 0.6 * dt; // 轻微上浮
      const k = t * t * 3 - t * t * t * 2; // 先快后慢的膨胀
      const sc = (it.base + it.grow * k);
      it.sp.scale.set(sc, sc, 1);
      it.sp.material.opacity = it.maxOp * (1 - t);
    }

    // 是否喷烟（后轮打滑或手刹急转）
    if (s.drifting && s.rearWorld) {
      for (const rear of s.rearWorld) {
        if (Math.random() < 0.75) this._emitSmoke(rear, s.carForward, s.dt);
      }
    }
  }

  _emitSmoke(worldPos, carForward, dt) {
    const it = this.smokes[this._smokeIdx];
    this._smokeIdx = (this._smokeIdx + 1) % this.SMOKE_MAX;

    // 位置：后轮处 ± 随机偏移
    it.sp.position
      .copy(worldPos)
      .addScaledVector(carForward, 0.4 + Math.random() * 0.5)
      .add(this._tmpA.set((Math.random() - 0.5) * 0.4, 0.12 + Math.random() * 0.1, (Math.random() - 0.5) * 0.4));

    // 速度：向后飘散 + 少许随机
    it.vel
      .copy(carForward).multiplyScalar(-(1 + Math.random() * 1.5))
      .add(this._tmpB.set((Math.random() - 0.5) * 2.2, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 2.2));

    it.maxLife = 0.55 + Math.random() * 0.35;
    it.life = it.maxLife;
    it.base = 0.5 + Math.random() * 0.35;
    it.grow = 3.2 + Math.random() * 1.6;
    it.maxOp = 0.42;
    it.sp.visible = true;
  }

  // ------------------------------------------------------------
  // 速度线：全屏 Canvas 叠层上绘制“放射状”细线。
  // 放射中心 = 画面消失点（车辆前进方向），线条从中心向左右
  // 两侧边缘延伸 → 方向与运动方向一致，且只分布在两侧、中央留空。
  // ------------------------------------------------------------
  _makeSpeedCanvas() {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:6;';
    document.body.appendChild(cv);
    this._cv = cv;
    this._ctx = cv.getContext('2d');
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(2, Math.floor(window.innerWidth * dpr));
      cv.height = Math.max(2, Math.floor(window.innerHeight * dpr));
      this._dpr = dpr;
    };
    fit();
    window.addEventListener('resize', fit);

    // 左右各 13 条：角度落在两侧下半区（左下 / 右下），径向长度随机错落
    const lines = [];
    const mk = (aDeg, riFrac, lenFrac, wFrac, ph) => {
      lines.push({ a: (aDeg * Math.PI) / 180, ri: riFrac, len: lenFrac, w: wFrac, ph });
    };
    for (let k = 0; k < 13; k++) {
      const t = k / 12;
      const riFrac = 0.3 + t * 0.22 + Math.random() * 0.1;
      const lenFrac = 0.18 + Math.random() * 0.5;
      const wFrac = 1.4 + Math.random() * 1.6;
      const ph = Math.random() * Math.PI * 2;
      mk(95 + t * 75, riFrac, lenFrac, wFrac, ph);        // 左下侧
      mk(10 + (1 - t) * 75, riFrac, lenFrac, wFrac, ph);  // 右下侧（镜像）
    }
    this._lines = lines;
  }

  _updateStreaks(s) {
    const cv = this._cv;
    const ctx = this._ctx;
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);

    const speed = Math.abs(s.speedKmh);
    const factor = THREE.MathUtils.clamp((speed - 62) / 90, 0, 1);
    if (factor <= 0.01) return;

    const now = performance.now();
    const dpr = this._dpr || 1;
    const cx = w / 2;
    const cy = h * 0.46; // 消失点略高于屏幕中心
    const baseR = Math.min(w, h) * 0.5;
    const maxR = Math.hypot(w, h);
    ctx.lineCap = 'round';
    for (let i = 0; i < this._lines.length; i++) {
      const L = this._lines[i];
      const flick = 0.5 + 0.5 * Math.sin(now * 0.008 + L.ph);
      const alpha = (0.16 + 0.55 * factor) * flick;
      const r0 = baseR * L.ri;
      const len = baseR * L.len * (0.7 + 0.6 * factor);
      const r1 = Math.min(maxR, r0 + len);
      const ca = Math.cos(L.a);
      const sa = Math.sin(L.a);
      const x0 = cx + ca * r0;
      const y0 = cy + sa * r0;
      const x1 = cx + ca * r1;
      const y1 = cy + sa * r1;
      // 内侧（靠近消失点）略亮，向屏幕边缘淡出 → 向后延伸的拖尾
      const grad = ctx.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, `rgba(235,244,255,${(alpha * 0.9).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(235,244,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = L.w * dpr;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}
