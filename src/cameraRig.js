// ============================================================
// cameraRig.js - 视角系统
// 模式：
//   chase   - 第三人称跟随（平滑阻尼 + 高速 FOV 拉伸）
//   cockpit - 第一人称驾驶舱（随车身姿态）
// ============================================================

import * as THREE from 'three';

const DAMP = (k, dt) => 1 - Math.exp(-k * dt);

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';

    this._desired = new THREE.Vector3();
    this._smoothed = new THREE.Vector3();
    this._lookDesired = new THREE.Vector3();
    this._lookSmoothed = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tmp = new THREE.Vector3();

    // 第三人称参数
    this.chaseDist = 7.2;
    this.chaseHeight = 3.2;
    this.chaseLookAhead = 7;

    this.baseFov = 62;
    this.camera.fov = this.baseFov;
  }

  get viewName() {
    return this.mode === 'chase' ? '第三人称' : '驾驶舱';
  }

  toggle() {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    // 切换后立即贴近，避免镜头从远处“飞”过来
    if (this.mode === 'cockpit') {
      this._smoothed.copy(this.camera.position);
    }
  }

  /** 重置平滑状态（车辆复位时调用） */
  snap() {
    this._smoothed.copy(this.camera.position);
  }

  /**
   * @param {number} dt
   * @param {object} car 车辆
   * @param {(x:number,z:number)=>number} [getGroundY] 地形高度查询（用于相机防穿地）
   */
  update(dt, car, getGroundY) {
    const cam = this.camera;

    if (this.mode === 'cockpit') {
      // 驾驶舱：位于车体右前驾驶位，姿态跟随车身
      this._tmp
        .copy(car.forward).multiplyScalar(0.15)
        .addScaledVector(car.right, 0.38)
        .addScaledVector(this._up, 1.18);
      cam.position.copy(car.pos).add(this._tmp);
      cam.quaternion.copy(car.quat);
      cam.rotateY(0);
      if (Math.abs(cam.fov - this.baseFov) > 0.1) {
        cam.fov += (this.baseFov - cam.fov) * DAMP(6, dt);
        cam.updateProjectionMatrix();
      }
      return;
    }

    // ---- 第三人称跟随 ----
    const speedK = Math.min(1, Math.abs(car.forwardSpeed) / 45);

    // 目标位置：车后上方
    this._desired
      .copy(car.pos)
      .addScaledVector(car.forward, -this.chaseDist)
      .addScaledVector(this._up, this.chaseHeight + speedK * 0.4);

    // 目标注视点：车前偏上
    this._lookDesired
      .copy(car.pos)
      .addScaledVector(car.forward, this.chaseLookAhead)
      .addScaledVector(this._up, 1.6);

    const k = DAMP(this.mode === 'chase' ? 7 : 10, dt);
    this._smoothed.lerp(this._desired, k);
    this._lookSmoothed.lerp(this._lookDesired, DAMP(11, dt));

    // ---- 防穿地：相机与注视点都抬到地形之上 ----
    // 否则在陡坡/山脊附近相机会钻进山体，看到地形内部（背面）而穿帮
    if (getGroundY) {
      const lift = (v, margin) => {
        const g = getGroundY(v.x, v.z) + margin;
        if (v.y < g) v.y = g;
      };
      lift(this._desired, 1.3);
      lift(this._smoothed, 1.3);
      lift(this._lookSmoothed, 0.8);
    }

    cam.position.copy(this._smoothed);
    cam.lookAt(this._lookSmoothed);

    // 高速 FOV 拉升，增强速度感
    const fovTarget = this.baseFov + speedK * 16;
    if (Math.abs(cam.fov - fovTarget) > 0.05) {
      cam.fov += (fovTarget - cam.fov) * DAMP(5, dt);
      cam.updateProjectionMatrix();
    }
  }
}
