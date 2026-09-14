// ============================================================
// hud.js - 驾驶仪表与界面（DOM 覆盖层）
// 速度表 / 挡位 / 视角标签 / 帧率 / 启动画面
// ============================================================

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class HUD {
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div class="panel" id="speedometer">
        <div><span id="speed-value">0</span><span id="speed-unit">km/h</span></div>
        <div id="speed-meta">
          <span id="gear">N</span>
          <div id="speedbar"><div id="speedbar-fill"></div></div>
        </div>
      </div>
      <div class="panel" id="status-panel">
        <div id="game-title">DRIVESCAPE</div>
        <div id="game-slogan">驰骋虚拟疆域 · 驾驭物理真实</div>
        <div id="view-label">视角：<b id="view-name">第三人称</b></div>
        <div id="fps"></div>
      </div>
      <div class="panel" id="hint-bar">
        <span><span class="kbd">W</span><span class="kbd">S</span> 加速 / 刹车</span>
        <span><span class="kbd">A</span><span class="kbd">D</span> 转向</span>
        <span><span class="kbd">空格</span> 手刹漂移</span>
        <span><span class="kbd">C</span> 切换视角</span>
        <span><span class="kbd">R</span> 复位车辆</span>
      </div>
    `;

    this.splash = document.createElement('div');
    this.splash.id = 'splash';
    this.splash.innerHTML = `
      <div class="panel splash-card">
        <h1>DRIVESCAPE</h1>
        <div class="slogan">驰骋虚拟疆域 · 驾驭物理真实</div>
        <div class="divider"></div>
        <div class="controls">
          <div><span class="kbd">W</span> 油门</div>
          <div><span class="kbd">S</span> 刹车 / 倒车</div>
          <div><span class="kbd">A</span><span class="kbd">D</span> 转向</div>
          <div><span class="kbd">空格</span> 手刹漂移</div>
          <div><span class="kbd">C</span> 第三人称 / 驾驶舱</div>
          <div><span class="kbd">R</span> 复位车辆</div>
        </div>
        <div id="start-hint">点击任意位置 或 按任意键 开始驾驶</div>
      </div>
    `;

    document.body.appendChild(this.el);
    document.body.appendChild(this.splash);

    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._fpsTimer = 0;
  }

  /** 开始游戏：淡出启动画面，返回一个 promise（用户交互后 resolve） */
  waitForStart() {
    return new Promise((resolve) => {
      const start = () => {
        this.splash.classList.add('hidden');
        window.removeEventListener('keydown', start);
        window.removeEventListener('pointerdown', start);
        resolve();
      };
      window.addEventListener('keydown', start, { once: false });
      window.addEventListener('pointerdown', start, { once: false });
      // 2.5 秒后仍未操作也可自动进入
      setTimeout(start, 2500);
    });
  }

  /** 每帧刷新仪表 */
  update(speedKmh, gear, viewName, handbrake, dtSec) {
    const valueEl = document.getElementById('speed-value');
    const barEl = document.getElementById('speedbar-fill');
    const gearEl = document.getElementById('gear');

    valueEl.textContent = String(Math.round(Math.abs(speedKmh)));
    barEl.style.width = `${clamp01(Math.abs(speedKmh) / 180) * 100}%`;

    gearEl.textContent = gear;
    gearEl.classList.toggle('r', gear === 'R');

    const viewEl = document.getElementById('view-name');
    if (viewEl.textContent !== viewName) viewEl.textContent = viewName;

    // 帧率统计（每 0.5s 更新一次，避免频繁改 DOM）
    this._fpsFrames += 1;
    this._fpsAcc += dtSec;
    if (this._fpsAcc >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsAcc);
      document.getElementById('fps').textContent = `${fps} FPS`;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
  }
}
