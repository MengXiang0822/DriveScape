// ============================================================
// autopilot.js - 赛道巡航演示（仅 URL 带 auto=1 时启用）
// 替换 game.input 为自巡航输入：沿赛道中心线最近点反馈转向，
// 按前方弯度降速，爬坡/下坡自动给油或制动。可用来演示并验证
// 爬山赛道全环可驾驶性。手动操作恢复：刷新页面不带 auto 参数。
// ============================================================

export function startAutopilot(game) {
  const car = game.vehicle;
  const track = game.env.track;
  const N = track.length;

  const auto = {
    _frames: 0,
    _log: [],         // 遥测日志（[x,y,z,speed,up,thr,brk,steer,vMax,idx,err]）
    _idx: 0,          // 最近路径点索引（增量维护）
    _thr: 0,
    _brk: 0,
    _steer: 0,
    _found: false,
    cruise: 13,       // 山道巡航速度 (m/s)

    // --- 定位最近路径点（环形窗口：跨首尾相接处也能正确回绕） ---
    _nearest(x, z) {
      let best = this._idx;
      let bestD = Infinity;
      const W = 90;
      // 在上一帧索引附近的环形窗口（±W，含跨过 0/N 边界）内搜索
      for (let d = -W; d <= W; d++) {
        const k = ((best + d) % N + N) % N;
        const dx = x - track[k].x;
        const dz = z - track[k].z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; best = k; }
      }
      // 窗口内距离仍过大（冲出赛道较远）→ 全图扫描兜底
      if (bestD > 3600) {
        bestD = Infinity;
        for (let k = 0; k < N; k++) {
          const dx = x - track[k].x;
          const dz = z - track[k].z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) { bestD = d2; best = k; }
        }
      }
      return best;
    },

    // --- 沿赛道向前（弧长约 am 处）取目标点索引（闭合环，绕回开头） ---
    _ahead(i0, am) {
      let acc = 0;
      let i = i0;
      let guard = 0;
      while (guard++ < 90 && acc < am) {
        const n = (i + 1) % N;
        acc += Math.hypot(track[n].x - track[i].x, track[n].z - track[i].z);
        i = n;
      }
      return i;
    },

    // --- 每帧决策（在 game._tick 读取输入前调用，反馈用上一帧位姿） ---
    think() {
      this._frames++;
      const p = car.pos;
      const f = car.forward;
      if (!this._found) {
        this._idx = this._nearest(p.x, p.z);
        this._found = true;
      }
      const i = this._nearest(p.x, p.z);
      this._idx = i;

      // 目标点：按当前车速给前视距离
      const sp = car.speed;
      const ahead = Math.min(14, Math.max(4.5, sp * 0.9));
      const ti = this._ahead(i, ahead);
      const dx = track[ti].x - p.x;
      const dz = track[ti].z - p.z;
      const dl = Math.hypot(dx, dz) || 1e-6;

      // 有符号转向误差：>0 = 目标在车头右侧
      const dot2 = f.x * (dx / dl) + f.z * (dz / dl);
      const cross2 = f.x * (dz / dl) - f.z * (dx / dl);
      let err = Math.atan2(cross2, dot2);

      // 横向偏差向内侧拉（防止切弯外抛滑出肩坡）——贴内线过弯
      const ox = p.x - track[i].x;
      const oz = p.z - track[i].z;
      const latS = ox * car.right.x + oz * car.right.z; // >0 车偏中心线右侧
      if (Math.abs(latS) > 0.8) {
        const pull = (latS > 0 ? 1 : -1) * Math.min(0.5, (Math.abs(latS) - 0.8) * 0.2);
        err += pull;
      }

      // 前方弯度（向前约 16m 总偏角）→ 限制速度
      const iB = this._ahead(i, 20);
      const bx = track[iB].x - track[Math.min(i + 2, N - 1)].x;
      const bz = track[iB].z - track[Math.min(i + 2, N - 1)].z;
      const fl = Math.hypot(
        track[Math.min(i + 2, N - 1)].x - track[Math.max(i - 2, 0)].x,
        track[Math.min(i + 2, N - 1)].z - track[Math.max(i - 2, 0)].z
      ) || 1;
      const fx = track[Math.min(i + 2, N - 1)].x - track[Math.max(i - 2, 0)].x;
      const fz = track[Math.min(i + 2, N - 1)].z - track[Math.max(i - 2, 0)].z;
      const bend = Math.abs(Math.atan2(fx * bz - fz * bx, fx * bx + fz * bz));
      let vMax = this.cruise / (1 + Math.abs(err) * 1.6) / (1 + bend * 2.6);
      vMax = Math.max(2.4, Math.min(vMax, this.cruise)); // 下限 2.4m/s：发夹弯也保持蠕动前进，不停摆

      this._steer = Math.max(-1, Math.min(1, err / 0.5));
      this._thr = 0;
      this._brk = 0;
      if (sp < vMax * 0.95) this._thr = 1;
      else if (sp > vMax * 1.15) this._brk = 1;
      if (sp < 2.5 && car.up.y > 0.5) { this._thr = 1; this._brk = 0; } // 卡住补油
      if (sp > this.cruise * 1.6) { this._brk = 1; this._thr = 0; }    // 下坡限速

      // 遥测：每 12 帧记录一次（环形，供调试回读）
      if (this._frames % 12 === 0) {
        this._log.push([
          +p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1),
          +sp.toFixed(1), +car.up.y.toFixed(2),
          this._thr, this._brk, +this._steer.toFixed(2),
          +vMax.toFixed(1), i, +err.toFixed(3),
        ]);
        if (this._log.length > 240) this._log.shift();
      }
      return true;
    },

    get throttle() { this.think(); return this._thr; },
    get brake() { return this._brk; },
    get steer() { return this._steer; },
    get handbrake() { return false; },
    consumeViewToggle() { return false; },
    consumeReset() { return false; },
    consumeAny() { return true; },
    down() { return false; },
    dispose() {},
  };

  game.input = auto;
  window.__auto = auto; // 供控制台调试读取内部决策状态
  return auto;
}
