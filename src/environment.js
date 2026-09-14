// ============================================================
// environment.js - 山地赛道世界（v2）
//
// 设计：闭合“爬山赛道”
//   [起点平原直道] -> [东侧折返盘山上坡(~18m)] -> [山顶大道]
//   -> [西侧折返盘山下坡] -> [平原直道回起点]
//
// 地形 = 单一 Heightfield（物理与视觉同源的高度网格）：
//   世界 ±150m，网格分辨率 2m。赛道走廊上的地形被抬升为盘山
//   坡道，路两侧形成自然的山坡肩带；平原区保持平整。
// ============================================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  createSkyTexture,
  createGroundDetailTexture,
  createAsphaltTextures,
  createDashedLineTexture,
  createCheckerTexture,
  createCloudTexture,
  createSunGlowTexture,
  createFieldTexture,
  createGrassPatchTexture,
} from './textures.js';

// ---------------- 世界常量 ----------------
const WORLD_HALF = 260;   // 地图范围 ±260（含边界山脉；可玩区仍到 RIM）
const CELL = 1;           // 高度网格分辨率（米）→ 1m：地表曲面更细腻、坡脚更顺
const N = WORLD_HALF * 2 / CELL + 1; // 521
const RIM = 198;          // 可玩区边界 = 边界山脉的山脚起始位置
const EARTH_Y = -1.3;     // 大地基座高度（略低于赛道地形最低点，被内部地形覆盖）

const ROAD_HALF = 7;      // 路面半宽
const SHOULDER = 18;      // 路肩（坡面）宽度：让山顶“平顶”过渡圆润、发夹外侧有缓坡缓冲

// 低地池塘（水体）：置于环线内部的平原，用于打破大片草地的单调
const PONDS = [
  { x: -46, z: -58, r: 38, depth: 1.0 },
  { x: 56, z: 52, r: 32, depth: 0.8 },
  { x: -48, z: 92, r: 28, depth: 0.7 },
];
/** 是否落在（含 margin 缓冲的）池塘范围内 */
const inPond = (x, z, margin = 0) => {
  for (const p of PONDS) {
    if (Math.hypot(x - p.x, z - p.z) < p.r + margin) return true;
  }
  return false;
};

// ---------------- 赛道几何参数 ----------------
// 环线沿地图四边铺开：南侧平原直道 → 东侧折返爬坡 → 北侧山顶大道
// → 西侧折返下坡 → 回到南侧直道。让赛道覆盖整张地图，而不是只占一侧。
const START = { x: 0, z: -138 };    // 南侧平原直道中点（起点/终点线）
const CLIMB = {
  x0: 118,                          // 南北直道半长（直道 x ∈ [-x0, x0]）
  z0: -138,                         // 南直道 z（平原，起点高度）
  topZ: 168,                        // 北直道 z（山顶大道）
  summitY: 14,                      // 山顶高度（温和坡度，易爬好控）
  legs: 6,                          // 折返腿数（偶数：起止都落在 x0 上）
  dx: 58,                           // 折返横移：走廊宽 58m、腿长 ≈77m → 大半径发夹
  minStraight: 8,                   // 相邻两个圆弧之间保留的最小直道（米）
};

// ============================================================
// 一、工具：随机数（确定性）与平滑噪声
// ============================================================
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// 二、赛道中心线生成（闭合折返盘山环线）
//    单一控制点环 + 逐顶点圆弧圆角，保证全环无硬折点、无重复点：
//      - 折返发夹（~141°）：大半径圆弧 R ≈ 12m（放大走廊后的几何上限）
//      - 直道/山顶大道与山道的 ~19° 顺接角：长缓圆弧 R ≈ 55m
//    高度按区域分段平缓分配：直道 0.2 → 上坡 smoothstep → 山顶大道 10
//    → 下坡 smoothstep → 回到直道 0.2（接缝处坡度 0，无突变）。
// ============================================================

// 发夹弯半径统计（供环境导出/测试）
let _hairpinRadii = [];

/** 东侧爬坡控制多边形（偶数腿往返，供环线拼接使用） */
function buildClimbPoly() {
  const { x0, z0, topZ, legs, dx } = CLIMB;
  const dz = (topZ - z0) / legs;
  const poly = [{ x: x0, z: z0 }];
  for (let k = 1; k <= legs; k++) {
    poly.push({ x: k % 2 === 1 ? x0 + dx : x0, z: z0 + k * dz });
  }
  return poly;
}

/** 由“折返多边形 + 环线拼接”生成整条闭合中心线（带高度） */
function buildTrackCenterline() {
  const { x0, z0, topZ, legs, minStraight } = CLIMB;
  const cp = buildClimbPoly();

  // ---- 1) 控制点环（沿行驶方向，闭环） ----
  //  ring[0] = 直道西端/下山口 (-x0,z0) → 直道东行到 ring[1]=cp0=(x0,z0) 上山口
  //  → cp1..cp(legs) 东侧折返上坡 → ring[1+legs]=cp(legs)=(x0,topZ) 山顶东端
  //  → 山顶大道西行到 ring[2+legs]=(-x0,topZ) 山顶西端
  //  → 镜像折返下坡 → 回到 ring[0]。
  const ring = [{ x: -x0, z: z0 }];
  for (let k = 0; k <= legs; k++) ring.push(cp[k]);
  ring.push({ x: -x0, z: topZ });
  for (let k = legs - 1; k >= 1; k--) ring.push({ x: -cp[k].x, z: cp[k].z });
  const m = ring.length;

  // ---- 2) 各顶点转向角与边长 ----
  const turn = [];
  for (let v = 0; v < m; v++) {
    const a = ring[(v + m - 1) % m];
    const b = ring[v];
    const c = ring[(v + 1) % m];
    const inA = Math.atan2(b.z - a.z, b.x - a.x);
    const outA = Math.atan2(c.z - b.z, c.x - b.x);
    let d = outA - inA;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn.push(d);
  }
  const L = [];
  for (let v = 0; v < m; v++) {
    const a = ring[v];
    const b = ring[(v + 1) % m];
    L.push(Math.hypot(b.x - a.x, b.z - a.z));
  }

  // ---- 3) 切点距 T 与圆弧半径 R ----
  const isHairpin = (v) => Math.abs(turn[v]) > 1.0; // >57°：真发夹；~19°：顺接角
  const T = new Array(m).fill(0);
  for (let v = 0; v < m; v++) { // 发夹尽量占满相邻折返腿，各留 minStraight
    if (!isHairpin(v)) continue;
    T[v] = Math.max(4, Math.min((L[(v + m - 1) % m] - minStraight) / 2, (L[v] - minStraight) / 2));
  }
  for (let v = 0; v < m; v++) { // 19° 顺接角：长缓弧，各让出 ~10m
    if (isHairpin(v) || Math.abs(turn[v]) < 0.03) continue;
    T[v] = Math.min(10, Math.min(L[(v + m - 1) % m] - 12, L[v] - 12));
    T[v] = Math.max(4, T[v]);
  }
  const R = new Array(m).fill(0);
  for (let v = 0; v < m; v++) {
    const mag = Math.abs(turn[v]);
    R[v] = mag > 0.03 ? T[v] / Math.tan(mag / 2) : 0;
  }

  // 记录发夹半径（东侧 3 + 西侧镜像 3）
  _hairpinRadii.length = 0;
  for (let v = 0; v < m; v++) {
    if (isHairpin(v)) _hairpinRadii.push(Number(R[v].toFixed(2)));
  }

  // ---- 4) 圆弧几何：入口/出口切点 + 圆心 ----
  const geo = [];
  for (let v = 0; v < m; v++) {
    if (R[v] <= 0) { geo.push(null); continue; }
    const a = ring[(v + m - 1) % m];
    const b = ring[v];
    const c = ring[(v + 1) % m];
    const ul = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const vl = Math.hypot(c.x - b.x, c.z - b.z) || 1;
    const u = { x: (b.x - a.x) / ul, z: (b.z - a.z) / ul };
    const vv = { x: (c.x - b.x) / vl, z: (c.z - b.z) / vl };
    const Tin = { x: b.x - u.x * T[v], z: b.z - u.z * T[v] };
    const Tout = { x: b.x + vv.x * T[v], z: b.z + vv.z * T[v] };
    const mx = (Tin.x + Tout.x) / 2;
    const mz = (Tin.z + Tout.z) / 2;
    const cdx = Tout.x - Tin.x;
    const cdz = Tout.z - Tin.z;
    const cl = Math.hypot(cdx, cdz) || 1;
    const px = -cdz / cl;
    const pz = cdx / cl;
    const off = Math.sqrt(Math.max(0, R[v] * R[v] - (cl / 2) * (cl / 2)));
    const cands = [
      { x: mx + px * off, z: mz + pz * off },
      { x: mx - px * off, z: mz - pz * off },
    ];
    let best = cands[0];
    let bd = Infinity;
    for (const cc of cands) {
      const e1 = Math.abs((cc.x - Tin.x) * u.x + (cc.z - Tin.z) * u.z);
      const e2 = Math.abs((cc.x - Tout.x) * vv.x + (cc.z - Tout.z) * vv.z);
      const e = e1 + e2;
      if (e < bd) { bd = e; best = cc; }
    }
    geo.push({ c: best, Tin, Tout });
  }

  // ---- 5) 沿环顺序采样（直线 + 圆弧，~0.9m 间距，去重相邻重复点） ----
  const STEP = 0.9;
  const planar = [];
  const ci = new Array(m).fill(-1); // 各顶点圆弧中点的采样索引（高度分段用）
  const addP = (x, z) => {
    const last = planar[planar.length - 1];
    if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.z - z) < 1e-6) return;
    planar.push({ x, z });
  };
  const line = (ax, az, bx, bz) => {
    const l = Math.hypot(bx - ax, bz - az);
    const cnt = Math.max(1, Math.round(l / STEP));
    for (let i = 0; i <= cnt; i++) {
      const t = i / cnt;
      addP(ax + (bx - ax) * t, az + (bz - az) * t);
    }
  };
  const arc = (v) => {
    const g = geo[v];
    const s = turn[v] > 0 ? 1 : -1;
    const a0 = Math.atan2(g.Tin.z - g.c.z, g.Tin.x - g.c.x);
    const a1 = Math.atan2(g.Tout.z - g.c.z, g.Tout.x - g.c.x);
    let da = a1 - a0;
    while (da * s < 0) da += s * 2 * Math.PI;
    const cnt = Math.max(2, Math.round(R[v] * Math.abs(da) / STEP));
    const before = planar.length;
    for (let i = 1; i < cnt; i++) {
      const a = a0 + da * (i / cnt);
      addP(g.c.x + Math.cos(a) * R[v], g.c.z + Math.sin(a) * R[v]);
    }
    addP(g.Tout.x, g.Tout.z);
    ci[v] = Math.round((before + planar.length) / 2);
  };

  // 起点 = 顶点0 圆弧出口（位于直道西端以东 T0 处），绕一圈回到该点闭合
  const s0 = geo[0].Tout;
  addP(s0.x, s0.z);
  for (let e = 0; e < m; e++) {
    const w = (e + 1) % m;
    if (geo[w]) {
      line(planar[planar.length - 1].x, planar[planar.length - 1].z, geo[w].Tin.x, geo[w].Tin.z);
      arc(w);
    } else {
      line(planar[planar.length - 1].x, planar[planar.length - 1].z, ring[w].x, ring[w].z);
    }
  }

  // ---- 6) 高度分配（分段 + smoothstep 缓坡） ----
  // 环顶点顺序：1 → 1+legs 东侧折返上坡；1+legs → 2+legs 山顶大道；
  // 2+legs → 0 西侧折返下坡；0 之后回到南侧平原直道。
  const climbEnd = 1 + legs;   // 东侧折返终点（山顶大道东端）
  const summitEnd = 2 + legs;  // 山顶大道西端
  const b1 = Math.max(0, ci[1]);
  const b5 = Math.max(b1 + 1, ci[climbEnd]);
  const b6 = Math.max(b5 + 1, ci[summitEnd]);
  const b0 = Math.max(b6 + 1, ci[0]); // 下坡结束处（圆弧0中点，靠近终点）
  const Np = planar.length;
  const sm = (u) => u * u * (3 - 2 * u);
  const out = [];
  for (let i = 0; i < Np; i++) {
    const p = planar[i];
    let y;
    if (i <= b1) {
      y = 0.2;                                            // 直道
    } else if (i <= b5) {
      const u = (i - b1) / (b5 - b1);                     // 东侧上坡
      y = 0.2 + (CLIMB.summitY - 0.2) * sm(u);
    } else if (i <= b6) {
      y = CLIMB.summitY;                                  // 山顶大道
    } else if (i <= b0) {
      const u = (i - b6) / (b0 - b6);                     // 西侧下坡
      y = CLIMB.summitY - (CLIMB.summitY - 0.2) * sm(u);
    } else {
      y = 0.2;                                            // 回到直道
    }
    out.push({ x: p.x, y, z: p.z });
  }
  return out;
}

// ============================================================
// 三、地形高度网格
// ============================================================

function buildHeightGrid(track) {
  const grid = [];
  // 赛道影响区标记：显式记录“该格已按赛道高度决定”，
  // 避免高度恰为 0 的路肩外缘被后续起伏逻辑误判为空地（会产生坑洼/陡坎）
  const underTrack = [];
  for (let i = 0; i < N; i++) {
    grid.push(new Array(N).fill(0));
    underTrack.push(new Array(N).fill(false));
  }

  const wx = (i) => -WORLD_HALF + i * CELL;
  const wz = (j) => WORLD_HALF - j * CELL; // z 索引自北向南

  // 预取路径点（x, z, y）
  const pts = track.map((p) => ({ x: p.x, z: p.z, y: p.y }));

  for (let i = 0; i < N; i++) {
    const x = wx(i);
    for (let j = 0; j < N; j++) {
      const z = wz(j);

      // 粗筛：只有落在某条路径的“影响半径”内才需要计算（性能优化）
      const RAD = ROAD_HALF + SHOULDER + 10;
      let far = true;
      // 先对路径做降采样粗查（每隔 8 点），快速排除远场
      for (let k = 0; k < pts.length; k += 8) {
        if (Math.abs(x - pts[k].x) <= RAD && Math.abs(z - pts[k].z) <= RAD) {
          far = false;
          break;
        }
      }
      if (far) {
        grid[i][j] = 0;
        continue;
      }

      // 精细：在影响半径内找最近路径点
      let best = -1;
      let bestD2 = Infinity;
      for (let k = 0; k < pts.length; k++) {
        const dx = x - pts[k].x;
        const dz = z - pts[k].z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = k;
        }
      }
      const d = Math.sqrt(bestD2);
      if (d >= ROAD_HALF + SHOULDER) continue; // 影响半径内但已在路肩外：保持 0，交给起伏
      let h = 0;
      if (d < ROAD_HALF) {
        h = pts[best].y;
      } else {
        const t = (d - ROAD_HALF) / SHOULDER;
        const s = t * t * (3 - 2 * t); // smoothstep 到 0
        h = pts[best].y * (1 - s);
      }
      grid[i][j] = h;
      underTrack[i][j] = true;
    }
  }

  // 赛道外的地面起伏：低频“草浪/缓丘”（远离赛道渐入，路肩外留缓冲带，
  // 避免在路面边缘出现硬台阶；视觉与物理同源，开下路基也是自然缓坡）
  const rnd = mulberry32(7);
  const roll = (x, z) =>
    0.55 * Math.sin(x * 0.045 + 2.1) * Math.sin(z * 0.05 + 0.6)
    + 0.28 * Math.sin(x * 0.021 + 5.2) * Math.cos(z * 0.019 + 1.2)
    + 0.1 * Math.sin((x + z) * 0.12);
  // 赛道点抽稀：0.9m 间距下每 3 点取 1（≈2.7m），最近距离误差 <1.4m，
  // 足够决定起伏渐入幅度，同时大幅降低 O(N²·路径点数) 的开销（赛道加长后尤其明显）
  const coarsePts = [];
  for (let k = 0; k < pts.length; k += 3) coarsePts.push(pts[k]);
  for (let i = 0; i < N; i++) {
    const x = wx(i);
    for (let j = 0; j < N; j++) {
      if (underTrack[i][j]) continue; // 赛道影响区保持赛道高度
      const z = wz(j);
      // 到赛道中心线的最近距离（决定起伏渐入幅度）
      let dmin = Infinity;
      for (let k = 0; k < coarsePts.length; k++) {
        const dx = x - coarsePts[k].x;
        const dz = z - coarsePts[k].z;
        const d2 = dx * dx + dz * dz;
        if (d2 < dmin) dmin = d2;
      }
      const d = Math.sqrt(dmin);
      if (d < 26) continue; // 路肩外缓冲带保持平整
      const amp = Math.min(1, (d - 26) / 30); // 26m~56m 渐入到全额起伏
      grid[i][j] = (rnd() - 0.5) * 0.12 + roll(x, z) * amp;
    }
  }

  // 低地池塘：远离赛道的低地做平滑下凹（物理与视觉同源，水面按凹陷高度放置）
  for (let i = 0; i < N; i++) {
    const x = wx(i);
    for (let j = 0; j < N; j++) {
      if (underTrack[i][j]) continue; // 赛道走廊不动
      const z = wz(j);
      for (const p of PONDS) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d >= p.r) continue;
        const t = 1 - d / p.r;
        const s = t * t * (3 - 2 * t);
        grid[i][j] -= p.depth * s;
      }
    }
  }

  // 边界山脉（美观 + 软性防驶出）：
  //  · 用超椭圆环（四角圆润）替代方形边界，避免生硬的“方框”
  //  · 内侧 30m 缓坡抬起 → 峰带 → 外侧 22m 缓落回地面（世界边缘处归零）
  //  · 沿边叠加多频起伏：峰谷错落、时高时低，低谷处形成可远眺的“山口”
  //  · 峰高 10~34m，高处自然进入岩带/雪顶（顶点色按高度分层）
  const EDGE_P = 8;        // 超椭圆指数：越大越接近方形，8 ≈ 圆角矩形
  const EDGE_RISE = 30;    // 内侧上升带宽度（m）
  const edgeNoise = (x, z) =>
    0.55 * Math.sin(x * 0.021 + z * 0.017 + 1.3)
    + 0.30 * Math.sin(x * 0.043 - z * 0.037 + 4.1)
    + 0.15 * Math.sin(x * 0.011 + z * 0.013 + 2.7);
  for (let i = 0; i < N; i++) {
    const x = wx(i);
    const ax = Math.abs(x);
    for (let j = 0; j < N; j++) {
      const z = wz(j);
      const az = Math.abs(z);
      // 快速排除内圈（不接近边界山脚的格子无需计算幂）
      if (Math.max(ax, az) < RIM - EDGE_RISE) continue;
      const q = Math.pow(Math.pow(ax, EDGE_P) + Math.pow(az, EDGE_P), 1 / EDGE_P);
      const dEdge = q - RIM;
      if (dEdge <= 0) continue;
      const up = Math.min(dEdge / EDGE_RISE, 1);                    // 内侧缓坡
      const down = 1 - Math.min(Math.max(dEdge - EDGE_RISE, 0) / 22, 1); // 峰后缓落
      const su = up * up * (3 - 2 * up);
      const sd = down * down * (3 - 2 * down);
      const peak = 22 + 12 * edgeNoise(x, z);                       // 10 ~ 34m 峰高起伏
      const wall = peak * su * sd;
      if (wall > grid[i][j]) grid[i][j] = wall;
    }
  }

  return grid;
}

/** 网格高度查询（双线性插值），用于放置装饰物等 */
function makeHeightQuery(grid) {
  return (x, z) => {
    const fx = (x + WORLD_HALF) / CELL;
    const fz = (WORLD_HALF - z) / CELL;
    const i0 = Math.max(0, Math.min(N - 2, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(N - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const h00 = grid[i0][j0];
    const h10 = grid[i0 + 1][j0];
    const h01 = grid[i0][j0 + 1];
    const h11 = grid[i0 + 1][j0 + 1];
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  };
}

// ============================================================
// 四、视觉地形 Mesh（顶点色按高度渐变：草-岩-雪）
// ============================================================
function buildTerrainMesh(grid, detailTex) {
  const geo = new THREE.BufferGeometry();
  const verts = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  const grassA = new THREE.Color(0x579b54);
  const grassB = new THREE.Color(0x8aa856);
  const rockA = new THREE.Color(0x8b8471);
  const rockB = new THREE.Color(0x9aa0a0);
  const snow = new THREE.Color(0xe8ecef);
  // 低地生态带配色（避免非赛道区域大片单色）
  const meadow = new THREE.Color(0x4a8443);   // 深草甸
  const pasture = new THREE.Color(0x79a955);  // 牧场嫩草
  const dryGrass = new THREE.Color(0xabae66); // 干草黄绿
  const soil = new THREE.Color(0x8d7351);     // 裸土
  const sand = new THREE.Color(0xc9b78c);     // 沙土/旱地
  const wheat = new THREE.Color(0xd9c46a); // 麦田金
  const deepMeadow = new THREE.Color(0x3d7738); // 湿草甸（更深绿）

  const tmp = new THREE.Color();
  // 位置哈希：为每个顶点生成稳定噪点 → 草地斑驳 / 过渡带打散
  const hash2 = (px, pz) => {
    const s = Math.sin(px * 12.9898 + pz * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  // 低频生态带噪声：波长大致 100~300m，形成大片自然色块
  const biomeNoise = (x, z) => {
    const v =
      0.6 * Math.sin(x * 0.021 + z * 0.017 + 1.3)
      + 0.3 * Math.sin(x * 0.043 - z * 0.037 + 4.1)
      + 0.1 * Math.sin((x + z) * 0.011 + 2.7);
    return Math.max(0, Math.min(1, 0.5 + 0.5 * v));
  };
  // 中频斑块噪声：波长 25~70m，在低地上形成成片的枯黄/深绿草斑
  const patchNoise = (x, z) => {
    const v =
      0.55 * Math.sin(x * 0.13 + z * 0.09 + 0.7)
      + 0.30 * Math.sin(x * 0.05 - z * 0.11 + 3.3)
      + 0.15 * Math.sin((x - z) * 0.21 + 1.9);
    return Math.max(0, Math.min(1, 0.5 + 0.5 * v));
  };
  const sampleColor = (h, px, pz, slope) => {
    const sp = hash2(px * 0.15, pz * 0.19);
    const sp2 = hash2(px * 0.53, pz * 0.47);
    let col;
    if (h < 4) {
      // 低地：草甸 / 牧场 / 干草 / 裸土 / 沙土 五段生态带，细噪打散
      const biome = biomeNoise(px, pz);
      if (biome < 0.2) col = tmp.copy(meadow).lerp(pasture, sp * 0.6);
      else if (biome < 0.45) col = tmp.copy(pasture).lerp(grassA, sp);
      else if (biome < 0.68) col = tmp.copy(grassA).lerp(dryGrass, sp);
      else if (biome < 0.85) col = tmp.copy(dryGrass).lerp(soil, sp * 0.8);
      else col = tmp.copy(soil).lerp(sand, sp);
      // 中频斑块：成片的麦黄 / 深绿草甸交替，进一步打散单色
      const patch = patchNoise(px, pz);
      if (patch > 0.6) col.lerp(wheat, Math.min(0.55, (patch - 0.6) * 1.6));
      else if (patch < 0.36) col.lerp(deepMeadow, Math.min(0.5, (0.36 - patch) * 1.5));
      // 池塘岸线：湿沙/泥岸
      if (inPond(px, pz, 12)) col.lerp(sand, 0.4).lerp(soil, 0.22);
      // 缓坡露土（草地越陡越少）
      if (slope > 0.5) col.lerp(soil, Math.min(0.45, (slope - 0.5) * 0.7));
      col.multiplyScalar(0.88 + sp2 * 0.24);
    } else if (h < 12) {
      // 山脚草→岩过渡：坡度越陡越早露岩
      const t = Math.min(1, ((h - 4) / 8) * (0.7 + sp * 0.7) + (slope > 0.9 ? 0.4 : 0));
      col = tmp.copy(grassB).lerp(rockA, t);
      col.multiplyScalar(0.94 + sp2 * 0.14);
    } else if (h < 18) {
      // 岩带
      const t = Math.min(1, ((h - 12) / 6) * (0.7 + sp * 0.7));
      col = tmp.copy(rockA).lerp(rockB, t);
      col.multiplyScalar(0.9 + sp2 * 0.2);
    } else {
      // 岩→雪顶
      col = tmp.copy(rockB).lerp(snow, Math.min(1, (h - 18) / 8 + (sp - 0.5) * 0.35));
    }
    return col;
  };

  for (let i = 0; i < N; i++) {
    const x = -WORLD_HALF + i * CELL;
    for (let j = 0; j < N; j++) {
      const z = WORLD_HALF - j * CELL;
      const h = grid[i][j];
      // 局部坡度（估算，用于岩壁/草坡分界）
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(N - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(N - 1, j + 1);
      const gx = (grid[i1][j] - grid[i0][j]) / ((i1 - i0) * CELL);
      const gz = (grid[i][j1] - grid[i][j0]) / ((j1 - j0) * CELL);
      const slope = Math.hypot(gx, gz);
      verts.push(x, h, z);
      uvs.push(i / (N - 1), j / (N - 1)); // 全图 0..1，靠纹理 repeat 平铺细节
      const c = sampleColor(h, x, z, slope);
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - 1; j++) {
      const a = i * N + j;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: detailTex || null, // 近白细节贴图：与顶点色相乘，增加草地质感
    roughness: 0.9,
    // 双面渲染：山坡/路肩陡坡处即使背面朝向相机也不会被剔除，
    // 避免“看穿地形看到内部/看到山体另一侧”的穿帮
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // 覆盖整个世界的大网格，关闭剔除避免整块地形意外消失
  return mesh;
}

// ============================================================
// 五、视觉路面（沥青贴图 + 白色边线 + 黄色虚线中线 + 起跑线棋盘）
// ============================================================
function buildRoadStrips(track, asphaltTex, dashedTex, checkerTex) {
  const group = new THREE.Group();
  const pts = track;

  // 沿路累积弧长（供贴图 uv 使用，保证纹理不被弯道拉伸）
  const arc = [0];
  for (let i = 1; i < pts.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }

  const asphaltMat = new THREE.MeshStandardMaterial({
    map: asphaltTex ? asphaltTex.map : null,
    roughnessMap: asphaltTex ? asphaltTex.roughnessMap : null,
    color: asphaltTex ? 0xffffff : 0x3a3f45,
    roughness: 0.82,
    metalness: 0.02,
    // 与地形几乎共面：加深度偏移，消除远处的 z-fighting 闪烁
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0xf2f2f2,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const centerMat = new THREE.MeshStandardMaterial({
    map: dashedTex || null,
    color: dashedTex ? 0xffffff : 0xffd34d,
    roughness: 0.6,
    transparent: !!dashedTex,
    alphaTest: dashedTex ? 0.35 : 0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });

  /**
   * 依中心线扫出条带
   * @param {number} halfWidth 半宽
   * @param {number} offset    相对中心线的横向偏移
   * @param {number} uScale    uv 沿路方向：每多少米一个纹理周期
   */
  const makeStrip = (halfWidth, offset, mat, yOff, uScale) => {
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i < pts.length; i++) {
      // 当前点切向（水平）
      const p = pts[i];
      const pn = pts[Math.min(i + 1, pts.length - 1)];
      const pp = pts[Math.max(i - 1, 0)];
      let tx = pn.x - pp.x;
      let tz = pn.z - pp.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz;
      const nz = tx;
      const y = p.y + yOff;
      const u = uScale > 0 ? arc[i] / uScale : 0;
      positions.push(p.x + nx * (offset + halfWidth), y, p.z + nz * (offset + halfWidth));
      positions.push(p.x + nx * (offset - halfWidth), y, p.z + nz * (offset - halfWidth));
      uvs.push(u, 0, u, 1);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = a + 2;
      const d = b + 2;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // 覆盖全环的长条网格，避免局部被误剔除
    return mesh;
  };

  // 抬升只需很小（闪烁由 polygonOffset 负责），避免车轮视觉上陷入路面
  group.add(makeStrip(ROAD_HALF, 0, asphaltMat, 0.07, 3.2));            // 沥青（每 3.2m 一个纹理周期）
  group.add(makeStrip(0.12, 0, centerMat, 0.14, 7));                    // 中心虚线（7m 周期：实 3.85m + 空 3.15m）
  group.add(makeStrip(0.1, ROAD_HALF - 0.45, edgeMat, 0.13, 0));        // 白色边线（左）
  group.add(makeStrip(0.1, -(ROAD_HALF - 0.45), edgeMat, 0.13, 0));     // 白色边线（右）

  // 起跑线：黑白棋盘带（1m 方格，横跨路面）
  if (checkerTex) {
    checkerTex.repeat.set(1, 7);
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 14),
      new THREE.MeshStandardMaterial({
        map: checkerTex,
        roughness: 0.75,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
      })
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(START.x, 0.2 + 0.11, START.z);
    line.receiveShadow = true;
    group.add(line);
  }

  return group;
}

// ============================================================
// 六、装饰（树木/岩石/路标等），位置依地形采样
// ============================================================
function addDecorations(scene, track, getH, cloudTex, patchTex) {
  const rnd = mulberry32(20240907);
  // 路面上/近处不可放
  const offRoad = (x, z, margin) => {
    let dmin = Infinity;
    for (let k = 0; k < track.length; k += 2) {
      const dx = x - track[k].x;
      const dz = z - track[k].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) dmin = d2;
    }
    return Math.sqrt(dmin) > margin;
  };

  // --- 松树（沿路肩与山脚点缀 + 平原）---
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.19, 0.9, 6);
  trunkGeo.translate(0, 0.45, 0);
  const crownGeo = new THREE.ConeGeometry(1.0, 2.4, 7);
  crownGeo.translate(0, 1.6, 0);
  const TREE = 820; // 世界放大后保持植林密度（含边界山坡）
  const trunkIM = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.9 }), TREE);
  const crownIM = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x2f7d43, roughness: 0.9, flatShading: true }), TREE);
  trunkIM.castShadow = crownIM.castShadow = true;
  trunkIM.receiveShadow = crownIM.receiveShadow = true;
  scene.add(trunkIM, crownIM);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  let placed = 0;
  let guard = 0;
  while (placed < TREE && guard++ < 9000) {
    // 全图（含边界山坡）撒布；铺装区与陡崖除外
    const x = (rnd() * 2 - 1) * (WORLD_HALF - 6);
    const z = (rnd() * 2 - 1) * (WORLD_HALF - 6);
    if (!offRoad(x, z, 12)) continue;
    if (inPond(x, z, 4)) continue;
    const y = getH(x, z);
    if (y < 0.25 || y > 26) continue;
    // 越高越稀疏：接近雪线处基本不长树，山脊保持干净
    if (y > 8) {
      const keep = 1 - (y - 8) / 18;
      if (rnd() > keep) continue;
    }
    // 附近 3m 高差过大 = 陡坡/崖边，不种（防“长在墙上/悬空”的穿帮）
    const g0 = getH(x + 3, z);
    const g1 = getH(x - 3, z);
    const g2 = getH(x, z + 3);
    const g3 = getH(x, z - 3);
    const slope = Math.max(Math.abs(g0 - y), Math.abs(g1 - y), Math.abs(g2 - y), Math.abs(g3 - y));
    if (slope > 1.6) continue;
    const s = 0.8 + rnd() * 1.3;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    trunkIM.setMatrixAt(placed, dummy.matrix);
    crownIM.setMatrixAt(placed, dummy.matrix);
    const g = 0.55 + rnd() * 0.55;
    col.setRGB(0.2 * g, 0.5 * g, 0.27 * g);
    crownIM.setColorAt(placed, col);
    placed++;
  }
  trunkIM.count = crownIM.count = placed;
  trunkIM.instanceMatrix.needsUpdate = true;
  crownIM.instanceMatrix.needsUpdate = true;
  crownIM.instanceColor.needsUpdate = true;

  // --- 山顶平台装饰：观景亭 + 旗帜（新山顶北移，放在大道北侧路肩上）---
  const summit = { x: 0, z: CLIMB.topZ + 15, y: getH(0, CLIMB.topZ + 15) };
  const pav = new THREE.Group();
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.7 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xc23b3b, roughness: 0.6 });
  for (const sx of [-1.8, 1.8]) {
    for (const sz of [-1.8, 1.8]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 6), pillarMat);
      pillar.position.set(sx, 1.2, sz);
      pav.add(pillar);
    }
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.2, 1.1, 4), roofMat);
  roof.position.y = 2.9;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  pav.add(roof);
  pav.position.set(summit.x, summit.y, summit.z);
  scene.add(pav);

  // --- 起点/终点：龙门架与锥桶 ---
  const startPos = { x: START.x, z: START.z, y: getH(START.x, START.z) };
  const bannerMat = new THREE.MeshStandardMaterial({ color: 0xffd34d, emissive: 0x9c6d00, emissiveIntensity: 0.4 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0.4 });
  const banner = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(14, 0.35, 0.35), bannerMat);
  bar.position.y = 5.0; // 横梁搭在立柱顶端（柱高 4.8）
  banner.add(bar);
  for (const sx of [-6.5, 6.5]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 4.8, 8), poleMat);
    pole.position.set(sx, 2.4, 0);
    banner.add(pole);
  }
  // 直道沿 +x 延伸，道路横向为 z：绕 Y 转 90° 让横梁横跨路面（门洞正对行车方向）
  banner.rotation.y = Math.PI / 2;
  banner.position.set(startPos.x, startPos.y, startPos.z);
  scene.add(banner);

  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.7 });
  const coneBase = new THREE.MeshStandardMaterial({ color: 0xe65c12, roughness: 0.7 });
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const cg = new THREE.Group();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 9), coneMat);
      cone.position.y = 0.25;
      cone.castShadow = true;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.4), coneBase);
      cg.add(cone, base);
      cg.position.set(startPos.x + side * (3.2 + k * 2.4), startPos.y, startPos.z + side * 2.6);
      scene.add(cg);
    }
  }

  // --- 山坡散布岩石（只做装饰）---
  const rockMats = [
    new THREE.MeshStandardMaterial({ color: 0x8d8f92, roughness: 0.95, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x75787c, roughness: 0.95, flatShading: true }),
  ];
  for (let k = 0; k < 160; k++) {
    const x = (rnd() * 2 - 1) * 190;
    const z = -150 + rnd() * 320; // 覆盖东西两侧折返爬坡带 + 山脚
    const y = getH(x, z);
    if (y < 1 || !offRoad(x, z, 9)) continue;
    const r = 0.5 + rnd() * 1.3;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockMats[k % 2]);
    rock.position.set(x, y + r * 0.35, z);
    rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    rock.scale.y = 0.6;
    rock.castShadow = true;
    scene.add(rock);
  }

  // --- 低地植被与碎石：丰富非赛道区域的地面层次 ---
  // 灌木丛
  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  const BUSH = 560;
  const bushIM = new THREE.InstancedMesh(
    bushGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true }),
    BUSH
  );
  bushIM.castShadow = true;
  bushIM.receiveShadow = true;
  const bcol = new THREE.Color();
  let bn = 0;
  let bgd = 0;
  while (bn < BUSH && bgd++ < 12000) {
    const x = (rnd() * 2 - 1) * (WORLD_HALF - 8);
    const z = (rnd() * 2 - 1) * (WORLD_HALF - 8);
    if (inPond(x, z, 2)) continue;
    if (!offRoad(x, z, 10)) continue;
    const y = getH(x, z);
    if (y < 0.2 || y > 12) continue;
    const s = 0.6 + rnd() * 1.1;
    dummy.position.set(x, y + s * 0.32, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    dummy.scale.set(s * (0.9 + rnd() * 0.5), s * (0.5 + rnd() * 0.4), s * (0.9 + rnd() * 0.5));
    dummy.updateMatrix();
    bushIM.setMatrixAt(bn, dummy.matrix);
    const t = 0.7 + rnd() * 0.6;
    bcol.setRGB(0.16 * t, 0.42 * t, 0.2 * t);
    bushIM.setColorAt(bn, bcol);
    bn++;
  }
  bushIM.count = bn;
  bushIM.instanceMatrix.needsUpdate = true;
  if (bushIM.instanceColor) bushIM.instanceColor.needsUpdate = true;
  scene.add(bushIM);

  // 野花（贴地彩色小点）
  const flowerGeo = new THREE.IcosahedronGeometry(0.16, 0);
  const FLOWER = 1200;
  const flowerIM = new THREE.InstancedMesh(
    flowerGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
    FLOWER
  );
  const flPal = [0xf2f2f2, 0xf4d35e, 0xe8735c, 0xd07fd0, 0xf0a6c0];
  const flc = new THREE.Color();
  let fn = 0;
  let fgn = 0;
  while (fn < FLOWER && fgn++ < 20000) {
    const x = (rnd() * 2 - 1) * (RIM - 8);
    const z = (rnd() * 2 - 1) * (RIM - 8);
    if (inPond(x, z, 2)) continue;
    if (!offRoad(x, z, 9)) continue;
    const y = getH(x, z);
    if (y < 0.2 || y > 3) continue;
    dummy.position.set(x, y + 0.16, z);
    dummy.rotation.set(0, rnd() * Math.PI * 2, 0);
    const s = 0.7 + rnd() * 0.8;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    flowerIM.setMatrixAt(fn, dummy.matrix);
    flc.setHex(flPal[(rnd() * flPal.length) | 0]);
    flowerIM.setColorAt(fn, flc);
    fn++;
  }
  flowerIM.count = fn;
  flowerIM.instanceMatrix.needsUpdate = true;
  if (flowerIM.instanceColor) flowerIM.instanceColor.needsUpdate = true;
  scene.add(flowerIM);

  // 低地碎石（平原也有零散石头，不再只有山坡）
  const pebbleGeo = new THREE.DodecahedronGeometry(0.42, 0);
  const PEBBLE = 480;
  const pebbleIM = new THREE.InstancedMesh(
    pebbleGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
    PEBBLE
  );
  pebbleIM.castShadow = true;
  pebbleIM.receiveShadow = true;
  const pebCol = new THREE.Color();
  let pebN = 0;
  let pebG = 0;
  while (pebN < PEBBLE && pebG++ < 14000) {
    const x = (rnd() * 2 - 1) * (RIM - 6);
    const z = (rnd() * 2 - 1) * (RIM - 6);
    if (inPond(x, z, 1)) continue;
    if (!offRoad(x, z, 8)) continue;
    const y = getH(x, z);
    if (y < 0.2 || y > 14) continue;
    const s = 0.4 + rnd() * 1.1;
    dummy.position.set(x, y + s * 0.2, z);
    dummy.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    pebbleIM.setMatrixAt(pebN, dummy.matrix);
    const g = 0.6 + rnd() * 0.5;
    pebCol.setRGB(0.55 * g, 0.56 * g, 0.58 * g);
    pebbleIM.setColorAt(pebN, pebCol);
    pebN++;
  }
  pebbleIM.count = pebN;
  pebbleIM.instanceMatrix.needsUpdate = true;
  if (pebbleIM.instanceColor) pebbleIM.instanceColor.needsUpdate = true;
  scene.add(pebbleIM);

  // --- 草地色斑：柔边色块（野花田/枯草块/鲜草块），打破大片同色地面 ---
  // 同样逐顶点采样地形高度 → 贴地不浮空
  const PATCH = 130;
  const PSEG = 4;
  const patchPal = [0xcdc06a, 0xd9d19a, 0x8cc45f, 0xa9c96d, 0xbfcb6f, 0x93bd63];
  const ppos = [];
  const puv = [];
  const patchCol = [];
  const pidx = [];
  const pc = new THREE.Color();
  let pN = 0;
  let pG = 0;
  while (pN < PATCH && pG++ < 12000) {
    const x = (rnd() * 2 - 1) * (RIM - 10);
    const z = (rnd() * 2 - 1) * (RIM - 10);
    if (inPond(x, z, 4)) continue;
    if (!offRoad(x, z, 12)) continue;
    const y = getH(x, z);
    if (y < 0.2 || y > 3.5) continue;
    const s = 14 + rnd() * 22;
    const s2 = s * (0.65 + rnd() * 0.7);
    const rot = rnd() * Math.PI * 2;
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    pc.setHex(patchPal[(rnd() * patchPal.length) | 0]);
    const start = ppos.length / 3;
    for (let a = 0; a <= PSEG; a++) {
      for (let b = 0; b <= PSEG; b++) {
        const lu = (a / PSEG - 0.5) * s;
        const lv = (b / PSEG - 0.5) * s2;
        const px = x + lu * ca - lv * sa;
        const pz = z + lu * sa + lv * ca;
        ppos.push(px, getH(px, pz) + 0.09, pz);
        puv.push(a / PSEG, b / PSEG);
        patchCol.push(pc.r, pc.g, pc.b);
      }
    }
    for (let a = 0; a < PSEG; a++) {
      for (let b = 0; b < PSEG; b++) {
        const i0 = start + a * (PSEG + 1) + b;
        const i1 = i0 + 1;
        const i2 = i0 + (PSEG + 1);
        const i3 = i2 + 1;
        pidx.push(i0, i1, i2, i1, i3, i2);
      }
    }
    pN++;
  }
  const patchGeo = new THREE.BufferGeometry();
  patchGeo.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
  patchGeo.setAttribute('uv', new THREE.Float32BufferAttribute(puv, 2));
  patchGeo.setAttribute('color', new THREE.Float32BufferAttribute(patchCol, 3));
  patchGeo.setIndex(pidx);
  patchGeo.computeVertexNormals();
  const patchMesh = new THREE.Mesh(
    patchGeo,
    new THREE.MeshStandardMaterial({
      map: patchTex || null,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      roughness: 1,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })
  );
  patchMesh.receiveShadow = true;
  patchMesh.renderOrder = 1;
  patchMesh.frustumCulled = false;
  scene.add(patchMesh);

  // --- 赛道两侧反光立柱（红白相间，提升赛道可读性与精致度）---
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.95, 8);
  poleGeo.translate(0, 0.475, 0);
  const POLES = 220;
  const poleIM = new THREE.InstancedMesh(
    poleGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
    POLES
  );
  poleIM.castShadow = true;
  const pcol = new THREE.Color();
  let pn = 0;
  for (let i = 0; i < track.length && pn < POLES - 1; i += 18) {
    const p = track[i];
    const pn2 = track[Math.min(i + 1, track.length - 1)];
    const pp = track[Math.max(i - 1, 0)];
    let tx = pn2.x - pp.x;
    let tz = pn2.z - pp.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const nx = -tz;
    const nz = tx;
    for (const side of [-1, 1]) {
      // 起点龙门架附近留空
      if (Math.abs(p.x - START.x) < 12 && Math.abs(p.z - START.z) < 6) continue;
      dummy.position.set(
        p.x + nx * side * (ROAD_HALF + 0.9),
        p.y,
        p.z + nz * side * (ROAD_HALF + 0.9)
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poleIM.setMatrixAt(pn, dummy.matrix);
      pcol.setHex(pn % 2 === 0 ? 0xe23c3c : 0xf2f2f2);
      poleIM.setColorAt(pn, pcol);
      pn++;
      if (pn >= POLES) break;
    }
  }
  poleIM.count = pn;
  poleIM.instanceMatrix.needsUpdate = true;
  if (poleIM.instanceColor) poleIM.instanceColor.needsUpdate = true;
  scene.add(poleIM);

  // --- 池塘边：芦苇与岸石（形成小生态景）---
  const reedGeo = new THREE.CylinderGeometry(0.05, 0.07, 1.7, 5);
  reedGeo.translate(0, 0.85, 0);
  const REED = 320;
  const reedIM = new THREE.InstancedMesh(
    reedGeo,
    new THREE.MeshStandardMaterial({ color: 0x7fa955, roughness: 0.9, flatShading: true }),
    REED
  );
  reedIM.castShadow = true;
  let reedN = 0;
  for (const pond of PONDS) {
    for (let k = 0; k < 170 && reedN < REED; k++) {
      const a = rnd() * Math.PI * 2;
      const rr = pond.r * (0.7 + rnd() * 0.32);
      const x = pond.x + Math.cos(a) * rr;
      const z = pond.z + Math.sin(a) * rr;
      const y = getH(x, z);
      if (y < -0.55) continue; // 太深的水里不长芦苇
      dummy.position.set(x, y, z);
      dummy.rotation.set((rnd() - 0.5) * 0.25, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.25);
      const s = 0.7 + rnd() * 0.9;
      dummy.scale.set(1, s, 1);
      dummy.updateMatrix();
      reedIM.setMatrixAt(reedN, dummy.matrix);
      reedN++;
    }
  }
  reedIM.count = reedN;
  reedIM.instanceMatrix.needsUpdate = true;
  scene.add(reedIM);

  const shoreGeo = new THREE.DodecahedronGeometry(0.8, 0);
  const SHORE = 170;
  const shoreIM = new THREE.InstancedMesh(
    shoreGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
    SHORE
  );
  shoreIM.castShadow = true;
  shoreIM.receiveShadow = true;
  const shCol = new THREE.Color();
  let shoreN = 0;
  for (const pond of PONDS) {
    for (let k = 0; k < 95 && shoreN < SHORE; k++) {
      const a = rnd() * Math.PI * 2;
      const rr = pond.r * (0.92 + rnd() * 0.22);
      const x = pond.x + Math.cos(a) * rr;
      const z = pond.z + Math.sin(a) * rr;
      const y = getH(x, z);
      const s = 0.5 + rnd() * 1.2;
      dummy.position.set(x, y + s * 0.25, z);
      dummy.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      dummy.scale.set(s, s * 0.75, s);
      dummy.updateMatrix();
      shoreIM.setMatrixAt(shoreN, dummy.matrix);
      const g = 0.62 + rnd() * 0.45;
      shCol.setRGB(0.56 * g, 0.55 * g, 0.52 * g);
      shoreIM.setColorAt(shoreN, shCol);
      shoreN++;
    }
  }
  shoreIM.count = shoreN;
  shoreIM.instanceMatrix.needsUpdate = true;
  if (shoreIM.instanceColor) shoreIM.instanceColor.needsUpdate = true;
  scene.add(shoreIM);

  // --- 远景云朵（柔和 Sprite 贴图，始终面向相机）---
  const cloudMat = new THREE.SpriteMaterial({
    map: cloudTex || null,
    color: 0xffffff,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    fog: false,
  });
  for (let i = 0; i < 22; i++) {
    const cloud = new THREE.Sprite(cloudMat);
    const ring = rnd() * Math.PI * 2;
    const rCloud = 190 + rnd() * 430;
    const w = 34 + rnd() * 56;
    cloud.scale.set(w, w * 0.46, 1);
    cloud.position.set(Math.cos(ring) * rCloud, 78 + rnd() * 95, Math.sin(ring) * rCloud);
    scene.add(cloud);
  }
}

// ============================================================
// 六·二、远景与外围实景
//   世界边界外：远山剪影环 + 剪影树带，让四周不再是空白天空；
//   世界内远郊：阔叶树丛、田野色斑、小村落，丰富平原实景。
// ============================================================
function addFarScenery(scene, track, getH, fieldTex) {
  const rnd = mulberry32(20240911);
  const distToRoad = (x, z) => {
    let dmin = Infinity;
    for (let k = 0; k < track.length; k += 2) {
      const dx = x - track[k].x;
      const dz = z - track[k].z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) dmin = d2;
    }
    return Math.sqrt(dmin);
  };

  // --- 1) 世界外的远山环（被雾柔化，形成地平线剪影） ---
  const mountMat = new THREE.MeshStandardMaterial({ color: 0x7f96ac, roughness: 1, flatShading: true });
  const mGeo = new THREE.ConeGeometry(1, 1, 6);
  const MOUNT = 46;
  const mounts = new THREE.InstancedMesh(mGeo, mountMat, MOUNT);
  const md = new THREE.Object3D();
  for (let i = 0; i < MOUNT; i++) {
    const a = rnd() * Math.PI * 2;
    const R = 460 + rnd() * 180;
    const rad = 150 + rnd() * 220;
    const h = 120 + rnd() * 240;
    md.position.set(Math.cos(a) * R, h * 0.28, Math.sin(a) * R);
    md.rotation.set(0, rnd() * Math.PI, 0);
    md.scale.set(rad, h, rad);
    md.updateMatrix();
    mounts.setMatrixAt(i, md.matrix);
  }
  scene.add(mounts);

  // --- 2) 世界外近处一圈“剪影松林带”（墙外的远景树） ---
  const farTreeMat = new THREE.MeshStandardMaterial({ color: 0x33544a, roughness: 1, flatShading: true });
  const ftGeo = new THREE.ConeGeometry(1, 1, 5);
  const FTL = 160;
  const farTrees = new THREE.InstancedMesh(ftGeo, farTreeMat, FTL);
  for (let i = 0; i < FTL; i++) {
    const a = rnd() * Math.PI * 2;
    const R = WORLD_HALF + 55 + rnd() * 150; // 世界边缘缓丘之外一圈剪影松林
    const h = 10 + rnd() * 26;
    md.position.set(Math.cos(a) * R, EARTH_Y + h * 0.5, Math.sin(a) * R);
    md.scale.set(h * 0.24, h, h * 0.24);
    md.rotation.set(0, rnd() * Math.PI, 0);
    md.updateMatrix();
    farTrees.setMatrixAt(i, md.matrix);
  }
  scene.add(farTrees);

  // --- 3) 世界内远郊：阔叶树丛（低矮平原区，离赛道远） ---
  const leafTrunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 1.1, 6);
  const leafCrownGeo = new THREE.IcosahedronGeometry(1.15, 0);
  const lTrunkIM = new THREE.InstancedMesh(leafTrunkGeo, new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }), 260);
  const lCrownIM = new THREE.InstancedMesh(leafCrownGeo, new THREE.MeshStandardMaterial({ color: 0x3d8b46, roughness: 0.9, flatShading: true }), 260);
  const lc = new THREE.Color();
  let lt = 0;
  let lg = 0;
  while (lt < 260 && lg++ < 4200) {
    const x = (rnd() * 2 - 1) * (RIM - 10);
    const z = (rnd() * 2 - 1) * (RIM - 8);
    const y = getH(x, z);
    if (y < 0.25 || y > 2.0) continue;
    if (distToRoad(x, z) < 34) continue;
    if (inPond(x, z, 2)) continue;
    const s = 1.1 + rnd() * 1.6;
    md.position.set(x, y, z);
    md.rotation.set(0, rnd() * Math.PI * 2, 0);
    md.scale.set(s, s * 1.4, s);
    md.updateMatrix();
    lTrunkIM.setMatrixAt(lt, md.matrix);
    md.scale.set(s * 1.7, s * 1.15, s * 1.7);
    md.position.y = y + s * 1.1;
    md.updateMatrix();
    lCrownIM.setMatrixAt(lt, md.matrix);
    const t = 0.75 + rnd() * 0.5;
    lc.setRGB(0.2 * t, 0.55 * t, 0.24 * t);
    lCrownIM.setColorAt(lt, lc);
    lt++;
  }
  lTrunkIM.count = lCrownIM.count = lt;
  lTrunkIM.instanceMatrix.needsUpdate = true;
  lCrownIM.instanceMatrix.needsUpdate = true;
  if (lCrownIM.instanceColor) lCrownIM.instanceColor.needsUpdate = true;
  scene.add(lTrunkIM, lCrownIM);

  // --- 4) 农田拼布：贴合地形的田块（耕垄纹理 + 田埂边框，绝不浮空） ---
  // 用带细分的网格田块，顶点逐点采样地形高度 → 与地面严丝合缝，
  // 不会像平铺方块那样在起伏地面上“翘起”或陷进地里。
  const fpal = [0x8fae4e, 0xc9b45c, 0x9cbe70, 0x6f9c58, 0xd6c078, 0xa5c273, 0xdcbf5a, 0x9a7a4e, 0x7fa84f, 0xc8b878];
  const FSEG = 6;    // 每块田的细分段数
  const FPITCH = 30; // 田块网格间距（间距越大田块越少；保证互不重叠）
  const fpos = [];
  const fuv = [];
  const fcol = [];
  const fidx = [];
  const fc = new THREE.Color();
  for (let gi = 0; gi < 12; gi++) {
    for (let gj = 0; gj < 12; gj++) {
      const cx = -165 + gi * FPITCH + (rnd() * 2 - 1) * 3;
      const cz = -165 + gj * FPITCH + (rnd() * 2 - 1) * 3;
      if (Math.abs(cx) > RIM - 10 || Math.abs(cz) > RIM - 10) continue;
      const y = getH(cx, cz);
      if (y < -1.5 || y > 5) continue;    // 只在低地铺田（高山/雪线不铺）
      if (distToRoad(cx, cz) < 20) continue;
      if (inPond(cx, cz, 8)) continue;
      if (rnd() < 0.12) continue;   // 留出天然草地的空隙，避免田块过于规整
      const w = 14 + rnd() * 8;
      const d = 14 + rnd() * 8;
      // 田块要落在相对平整的地块上（贴合后依然平整好看）
      const hw = w / 2;
      const hd = d / 2;
      const r0 = getH(cx - hw, cz - hd);
      const r1 = getH(cx + hw, cz - hd);
      const r2 = getH(cx - hw, cz + hd);
      const r3 = getH(cx + hw, cz + hd);
      const relief = Math.max(r0, r1, r2, r3) - Math.min(r0, r1, r2, r3);
      if (relief > 1.5) continue;
      const swap = rnd() > 0.5;           // 耕垄朝向随机
      fc.setHex(fpal[(rnd() * fpal.length) | 0]);
      const start = fpos.length / 3;
      for (let a = 0; a <= FSEG; a++) {
        for (let b = 0; b <= FSEG; b++) {
          const lu = a / FSEG - 0.5;
          const lv = b / FSEG - 0.5;
          const px = cx + (swap ? lu * d : lu * w);
          const pz = cz + (swap ? lv * w : lv * d);
          fpos.push(px, getH(px, pz) + 0.05, pz);
          fuv.push(a / FSEG, b / FSEG);
          fcol.push(fc.r, fc.g, fc.b);
        }
      }
      for (let a = 0; a < FSEG; a++) {
        for (let b = 0; b < FSEG; b++) {
          const i0 = start + a * (FSEG + 1) + b;
          const i1 = i0 + 1;
          const i2 = i0 + (FSEG + 1);
          const i3 = i2 + 1;
          fidx.push(i0, i1, i2, i1, i3, i2);
        }
      }
    }
  }
  const fieldGeo = new THREE.BufferGeometry();
  fieldGeo.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  fieldGeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
  fieldGeo.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
  fieldGeo.setIndex(fidx);
  fieldGeo.computeVertexNormals();
  const fieldMesh = new THREE.Mesh(
    fieldGeo,
    new THREE.MeshStandardMaterial({
      map: fieldTex || null,
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
  );
  fieldMesh.receiveShadow = true;
  fieldMesh.frustumCulled = false;
  scene.add(fieldMesh);

  // --- 5) 远郊小村落（房舍 + 屋顶 + 烟囱） ---
  const homes = [
    [-108, -52], [-52, -96], [18, -102], [84, -66],
    [120, -30], [134, 18], [-132, 26], [-84, -2],
  ];
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xead9bd, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xb35a44, roughness: 0.8 });
  const barnMat = new THREE.MeshStandardMaterial({ color: 0x9c3f2e, roughness: 0.8 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
  const homeGroup = new THREE.Group();
  for (const [hx, hz] of homes) {
    if (Math.abs(hx) > RIM - 8 || Math.abs(hz) > RIM - 8) continue;
    const hy = getH(hx, hz);
    if (hy < 0.3 || hy > 1.3) continue;
    if (distToRoad(hx, hz) < 46) continue;
    const g = new THREE.Group();
    const isBarn = rnd() > 0.5;
    const w = isBarn ? 8 : 5.6;
    const d = isBarn ? 6.4 : 4.4;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.4, d), isBarn ? barnMat : wallMat);
    wall.position.y = 1.7;
    g.add(wall);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.78, 2.0, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = 3.4 + 1.0;
    g.add(roof);
    if (rnd() > 0.35) {
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.6, 0.5), darkMat);
      ch.position.set(w * 0.18, 4.6, 0);
      g.add(ch);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.9, 0.15), darkMat);
    door.position.set(0, 0.95, d / 2 + 0.05);
    g.add(door);
    g.rotation.y = rnd() * Math.PI * 2;
    g.position.set(hx, hy, hz);
    g.scale.setScalar(1 + rnd() * 0.5);
    homeGroup.add(g);
  }
  scene.add(homeGroup);
}

// ============================================================
// 七、主入口
// ============================================================
export function buildEnvironment(scene, world, renderer) {
  const env = {};

  // ---------- 程序化纹理（天空 / 地形 / 路面 / 虚线 / 棋盘 / 云 / 光晕） ----------
  const maxAniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 4;
  const skyTex = createSkyTexture();
  const groundTex = createGroundDetailTexture();
  groundTex.repeat.set(70, 70); // 世界 430m → 每格约 6m 细节
  const asphaltTex = createAsphaltTextures();
  const dashedTex = createDashedLineTexture();
  const checkerTex = createCheckerTexture();
  const cloudTex = createCloudTexture();
  const glowTex = createSunGlowTexture();
  const fieldTex = createFieldTexture();
  const patchTex = createGrassPatchTexture();
  for (const t of [skyTex, groundTex, asphaltTex.map, asphaltTex.roughnessMap, dashedTex, checkerTex, cloudTex, glowTex, fieldTex, patchTex]) {
    if (t) t.anisotropy = maxAniso;
  }
  scene.background = skyTex; // 渐变天空：随视角变化，地平线处与雾同色
  env.textures = { skyTex, groundTex, asphaltTex, dashedTex, checkerTex, cloudTex };

  // ---------- 灯光 ----------
  const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x3f6b3a, 0.7);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0xffffff, 0.14));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  const sc = 34;
  Object.assign(sun.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  env.sun = sun;

  // 补光（无阴影）：柔化背光面，增加明暗层次
  const fill = new THREE.DirectionalLight(0xbdd9ff, 0.45);
  fill.position.set(-60, 40, -40);
  scene.add(fill);

  // 太阳光晕（与主光同向；叠加混合，雾外可见）
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }));
  glow.position.set(38, 55, 24).normalize().multiplyScalar(780);
  glow.scale.set(240, 240, 1);
  scene.add(glow);

  // ---------- 赛道中心线 ----------
  const track = buildTrackCenterline();

  // ---------- 高度网格（物理 + 视觉共用） ----------
  const grid = buildHeightGrid(track);
  const getH = makeHeightQuery(grid);

  // ---------- 视觉地形 ----------
  const terrain = buildTerrainMesh(grid, groundTex);
  scene.add(terrain);

  // 大地基座：从赛道世界边缘一直延伸到远山脚下的大平面，
  // 把地平线以下全部填实（消除“除了赛道之外是虚空”、远山悬空的观感）。
  const groundTexFar = createGroundDetailTexture();
  groundTexFar.repeat.set(320, 320); // 远景地面用更大平铺尺度
  groundTexFar.anisotropy = maxAniso;
  const baseGround = new THREE.Mesh(
    new THREE.PlaneGeometry(4600, 4600),
    new THREE.MeshStandardMaterial({
      color: 0x7f9159,
      map: groundTexFar,
      roughness: 1,
      side: THREE.DoubleSide,
    })
  );
  baseGround.rotation.x = -Math.PI / 2;
  baseGround.position.set(0, EARTH_Y, 0);
  baseGround.frustumCulled = false;
  scene.add(baseGround);

  // ---------- 池塘水面（贴合地形凹陷；低反射高光，让低地不再单调） ----------
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2f7089,
    roughness: 0.14,
    metalness: 0.22,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  for (const pond of PONDS) {
    const gy = getH(pond.x, pond.z);
    const geoW = new THREE.CircleGeometry(pond.r * 0.86, 44);
    geoW.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(geoW, waterMat);
    water.position.set(pond.x, gy + pond.depth * 0.42, pond.z);
    water.receiveShadow = true;
    scene.add(water);
  }

  // ---------- 物理地形（Heightfield） ----------
  // data[xi][yi]：xi 沿世界 X（-150..+150），yi 沿世界 -Z（北->南）
  const hfData = [];
  for (let i = 0; i < N; i++) {
    const row = [];
    for (let j = 0; j < N; j++) row.push(grid[i][j]);
    hfData.push(row);
  }
  const hfShape = new CANNON.Heightfield(hfData, { elementSize: CELL });
  const hfBody = new CANNON.Body({ mass: 0 });
  hfBody.addShape(hfShape);
  hfBody.position.set(-WORLD_HALF, 0, WORLD_HALF);
  hfBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(hfBody);

  // ---------- 路面（视觉） ----------
  const roads = buildRoadStrips(track, asphaltTex, dashedTex, checkerTex);
  scene.add(roads);

  // ---------- 装饰 ----------
  addDecorations(scene, track, getH, cloudTex, patchTex);

  // ---------- 远景与外围实景（远山/树带/农田/村落） ----------
  addFarScenery(scene, track, getH, fieldTex);

  // 供调试/测试使用
  env.track = track;
  env.getHeight = getH;
  env.startPos = { x: START.x, z: START.z };
  env.climbStart = { x: CLIMB.x0, z: CLIMB.z0 };
  env.trackStats = {
    points: track.length,
    length: Math.round(
      track.reduce((s, p, i) => (i ? s + Math.hypot(p.x - track[i - 1].x, p.y - track[i - 1].y, p.z - track[i - 1].z) : 0), 0)
    ),
  };
  env.hairpins = {
    count: _hairpinRadii.length, // 东侧上坡 3 + 西侧下坡镜像 3
    radiusList: _hairpinRadii.slice(),
    minRadius: _hairpinRadii.length ? Math.min(..._hairpinRadii) : 0,
  };

  return env;
}
