// ============================================================
// game.js - 游戏主控
// 组装：渲染器 / 场景 / 物理世界 / 车辆 / 环境 / 视角 / 特效 / HUD
// 主循环：输入 -> 车辆控制 -> 物理步进 -> 视觉同步 -> 特效 -> 相机
// ============================================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Vehicle } from './vehicle.js';
import { buildEnvironment } from './environment.js';
import { CameraRig } from './cameraRig.js';
import { Effects } from './effects.js';
import { HUD } from './hud.js';
import { Input } from './input.js';

const SKY = 0x9fd8ef;
const FIXED_DT = 1 / 60; // 物理固定步长

export class Game {
  constructor(container) {
    // ================= 1. 渲染器 =================
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    container.appendChild(this.renderer.domElement);

    // ================= 2. 场景与相机 =================
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 190, 980); // 雾稍推远：中景地面保留色彩，远处仍柔和

    // near 稍大以提升深度精度（缓解路面/地形共面的远处闪烁），仍远小于相机到车距
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 1200);
    this.camera.position.set(0, 4.4, 38);
    this.camera.lookAt(0, 1.5, 25);

    // ================= 3. 物理世界 =================
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -10, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.defaultContactMaterial.friction = 0.4;
    this.world.defaultContactMaterial.restitution = 0.05;
    this.world.solver.iterations = 12;

    // ================= 4. 子系统 =================
    this.env = buildEnvironment(this.scene, this.world, this.renderer);
    this.vehicle = new Vehicle(this.scene, this.world);
    this.rig = new CameraRig(this.camera);
    this.fx = new Effects(this.scene, this.camera);
    this.hud = new HUD();
    this.input = new Input();

    this._rearA = new THREE.Vector3();
    this._rearB = new THREE.Vector3();
    this._acc = 0;                 // 物理固定步长累加器
    this._lastTime = performance.now();
    this._started = false;

    // ================= 5. 事件 =================
    window.addEventListener('resize', () => this._onResize());
    this._bindLoop();
    this.hud.waitForStart().then(() => {
      this._started = true;
    });
  }

  _bindLoop() {
    this._onFrame = () => {
      requestAnimationFrame(this._onFrame);
      const now = performance.now();
      const dt = Math.min((now - this._lastTime) / 1000, 0.1);
      this._lastTime = now;
      this._tick(dt);
    };
    requestAnimationFrame(this._onFrame);
  }

  // ============================================================
  // 每帧更新
  // ============================================================
  _tick(dt) {
    const inp = this.input;
    const car = this.vehicle;

    // ---------- 车辆控制输入 ----------
    if (this._started) {
      car.applyControls({
        throttle: inp.throttle,
        brake: inp.brake,
        steer: inp.steer,
        handbrake: inp.handbrake,
        dt,
      });
    } else {
      car.applyControls({ throttle: 0, brake: 0, steer: 0, handbrake: false, dt });
    }

    // ---------- 物理步进（固定步长累加器；内部自动执行 RaycastVehicle 的 preStep） ----------
    this._acc += dt;
    let steps = 0;
    while (this._acc >= FIXED_DT && steps < 4) {
      this.world.step(FIXED_DT); // 单参数模式 = 固定步长无插值
      this._acc -= FIXED_DT;
      steps++;
    }
    if (steps === 4) this._acc = 0; // 严重掉帧时丢弃累积时间，避免“死亡螺旋”

    // ---------- 同步视觉 ----------
    car.postStepSync();

    // ---------- 功能键 ----------
    if (inp.consumeViewToggle()) this.rig.toggle();
    if (inp.consumeReset()) {
      car.reset();
      this.rig.snap();
    }

    // 坠出世界自动复位（如被撞飞出边界）
    if (car.pos.y < -25) {
      car.reset();
      this.rig.snap();
    }

    // 翻车自动扶正（底盘朝上持续 1.6s 后复位到起点）
    if (car.up.y < 0.35) {
      this._flipTime += dt;
      if (this._flipTime > 1.6) {
        car.reset();
        this.rig.snap();
        this._flipTime = 0;
      }
    } else {
      this._flipTime = 0;
    }

    // ---------- 阴影跟随车辆，保证近距离阴影清晰 ----------
    const sun = this.env.sun;
    sun.position.set(car.pos.x + 38, car.pos.y + 55, car.pos.z + 24);
    sun.target.position.copy(car.pos);

    // ---------- 特效 ----------
    const handbrake = inp.handbrake;
    const fwd = car.forwardSpeed;
    const lat = car.lateralSpeed;
    const drifting =
      car.wheelsOnGround >= 2 &&
      Math.abs(car.speedKmh) > 22 &&
      (Math.abs(lat) > 3.4 || (handbrake && Math.abs(fwd) > 2.5));
    car.wheelWorldPosition(2, this._rearA);
    car.wheelWorldPosition(3, this._rearB);
    this.fx.update({
      dt,
      speedKmh: car.speedKmh,
      drifting,
      rearWorld: [this._rearA, this._rearB],
      carForward: car.forward,
    });

    // ---------- 相机（传入地形高度查询，避免镜头穿进山体看到内部） ----------
    this.rig.update(dt, car, this.env.getHeight);

    // ---------- HUD ----------
    let gear = 'D';
    if (car.forwardSpeed < -0.6) gear = 'R';
    else if (Math.abs(car.speedKmh) < 3 && inp.throttle === 0 && inp.brake === 0) gear = 'N';
    this.hud.update(car.speedKmh, gear, this.rig.viewName, handbrake, dt);

    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
