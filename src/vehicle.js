// ============================================================
// vehicle.js - 车辆（Three.js 视觉 + cannon-es 物理）
//
// 物理：RaycastVehicle 射线车辆，模拟悬挂（弹簧+阻尼）与轮胎
//       抓地力；四轮驱动（前后扭矩 0.75 : 1）、前轮转向。
// 坐标约定：车辆前进方向为局部 -Z（同 three.js 相机默认朝向），
//       局部 +X 为右侧，+Y 为上。因此正引擎力 = 前进。
//
// v2 操控调校：
//  - 转向角加大（0.9 rad≈51°），随车速自适应衰减，低速也灵活
//  - S 制动采用引擎反向力矩（平滑不锁轮）→ 高速重刹也不前翻/甩尾
//  - 手刹柔和随车速封顶增益，中高速不暴甩，低速可漂移回正
// ============================================================

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// ---------- 物理调参 ----------
const CHASSIS_MASS = 160;
const CHASSIS_HALF = new CANNON.Vec3(0.95, 0.32, 1.7); // 碰撞盒压低：低重心且底盘不易被棱线架空
const WHEEL_RADIUS = 0.42;
const SPAWN = { x: -50, z: -138, y: 1.4, yaw: -Math.PI / 2 }; // 南侧直道西段，车头朝 +X

const WHEEL_POS = [
  [-0.8, 0.0, -1.42], // 0 左前（加长轴距提升俯仰稳定）
  [0.8, 0.0, -1.42],  // 1 右前
  [-0.8, 0.0, 1.42],  // 2 左后
  [0.8, 0.0, 1.42],   // 3 右后
];

const WHEEL_BASE = {
  directionLocal: new CANNON.Vec3(0, -1, 0),
  axleLocal: new CANNON.Vec3(1, 0, 0),
  radius: WHEEL_RADIUS,
  suspensionStiffness: 44,
  suspensionRestLength: 0.38,
  maxSuspensionTravel: 0.36,
  dampingCompression: 3.6,    // 柔和压缩：吸收起伏不弹跳
  dampingRelaxation: 3.8,
  frictionSlip: 3.0,           // 高抓地：上坡与过弯可靠（S 已改引擎制动不锁轮，安全）
  rollInfluence: 0.06,         // 越低越不易侧翻（官方: 1=易翻）
  maxSuspensionForce: 140000,
  customSlidingRotationalSpeed: -30,
  useCustomSlidingRotationalSpeed: true,
};

// ---------- 动力 / 制动 / 转向参数 ----------
const MAX_ENGINE = 620;        // 引擎驱动力（收敛极速，急刹场景更可控；仍可爬 8° 山道）
const REVERSE_ENGINE = 500;    // 反向力矩：既用于倒车，也作为 S 键“发动机制动”
const FRONT_DRIVE = 1.0;       // 前轴扭矩比例（前轮拉动抑制抬头）
const REAR_DRIVE = 0.9;
const HBASE_REAR = 170;        // 手刹后轮基础锁制（柔和，宁滑不翻）
const HBASE_FRONT = 60;
const MAX_STEER = 0.9;         // 前轮最大转向角（弧度≈51°）

export class Vehicle {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;

    // 复用的临时向量，避免每帧分配
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this.forward = new THREE.Vector3(0, 0, -1); // 世界系前进方向
    this.right = new THREE.Vector3(1, 0, 0);    // 世界系右侧方向
    this.up = new THREE.Vector3(0, 1, 0);       // 世界系上方向
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();

    this._steerAngle = 0;
    this.steeringSmoothed = 0;
    this._throttleState = 0; // 油门缓升状态（0..1）
    this._brakeState = 0;    // 刹车渐进状态（0..1），避免瞬间锁轮前翻

    this._buildPhysics();
    this._buildVisual();
  }

  // ============================================================
  // 物理构建
  // ============================================================
  _buildPhysics() {
    // 车架刚体
    const chassisShape = new CANNON.Box(CHASSIS_HALF);
    this.chassisBody = new CANNON.Body({ mass: CHASSIS_MASS });
    // 质心相对悬挂平面下移 0.2m（重心低 → 急刹/侧滑不易空翻与侧翻）
    // 配合碰撞盒半高 0.32：底盘离地≈0.22m，肩坡棱线不会把车架空
    this.chassisBody.addShape(chassisShape, new CANNON.Vec3(0, -0.2, 0));
    this.chassisBody.position.set(SPAWN.x, SPAWN.y, SPAWN.z); // 出生点（起点直道西端）
    this.chassisBody.quaternion.setFromEuler(0, SPAWN.yaw, 0);
    this.chassisBody.linearDamping = 0.08;  // 空气/滚动阻力：抑制极速
    this.chassisBody.angularDamping = 0.62; // 阻尼翻滚/急转的角速度，抑制空翻

    // 射线车辆：局部坐标轴 = 右X / 上Y / 前Z
    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    // 添加四个车轮（含独立悬架）
    for (const [x, y, z] of WHEEL_POS) {
      this.vehicle.addWheel({
        ...WHEEL_BASE,
        chassisConnectionPointLocal: new CANNON.Vec3(x, y, z),
      });
    }

    this.vehicle.addToWorld(this.world); // 自动将车架加入 world 并注册 preStep
    this.frontWheels = [0, 1];
    this.rearWheels = [2, 3];
    this._applySpawn();
  }

  // ============================================================
  // 视觉构建（低多边形车身，全部程序化生成）
  // ============================================================
  _buildVisual() {
    const group = new THREE.Group();
    this.group = group;

    const paint = new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.35, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.6, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0e1620, roughness: 0.08, metalness: 0.9 });
    const glassLight = new THREE.MeshStandardMaterial({ color: 0x22303e, roughness: 0.1, metalness: 0.7 });
    const headlight = new THREE.MeshStandardMaterial({
      color: 0xfff6d8, emissive: 0xfff2b0, emissiveIntensity: 0.9,
    });
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x8f1d1d, emissive: 0xff2222, emissiveIntensity: 0.7,
    });
    const silver = new THREE.MeshStandardMaterial({ color: 0x9aa7b4, roughness: 0.25, metalness: 0.9 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.3, metalness: 0.5 });

    // 简易车身：主体 + 车厢 + 前鼻 + 保险杠
    const body = this._mesh(new THREE.BoxGeometry(1.9, 0.42, 3.2), paint, 0, 0.18, 0);
    const hood = this._mesh(new THREE.BoxGeometry(1.8, 0.16, 0.9), paint, 0, 0.34, -1.0);
    const cabin = this._mesh(new THREE.BoxGeometry(1.42, 0.4, 1.35), glass, 0, 0.58, -0.18);
    const cabinFrame = this._mesh(new THREE.BoxGeometry(1.48, 0.34, 1.4), paint, 0, 0.52, -0.18);
    this._mesh(new THREE.BoxGeometry(1.5, 0.14, 1.45), paint, 0, 0.68, -0.18); // 车顶
    this._mesh(new THREE.BoxGeometry(0.3, 0.34, 0.9), paint, 0, 0.4, 0.6);     // 车尾溜背
    this._mesh(new THREE.BoxGeometry(1.9, 0.1, 0.18), dark, 0, 0.08, 1.62);   // 后保险杠
    this._mesh(new THREE.BoxGeometry(1.86, 0.09, 0.12), dark, 0, 0.3, -1.62); // 前保险杠
    this._mesh(new THREE.BoxGeometry(0.3, 0.09, 1.9), accent, 0, 0.03, 0);    // 底盘饰条

    // 前灯 / 尾灯
    for (const sx of [-0.55, 0.55]) {
      this._mesh(new THREE.BoxGeometry(0.34, 0.08, 0.04), headlight, sx, 0.34, -1.62);
      this._mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05), tailMat, sx, 0.36, 1.63);
    }

    // 尾翼
    this._mesh(new THREE.BoxGeometry(1.76, 0.05, 0.32), paint, 0, 0.72, 1.42);
    for (const sx of [-0.6, 0.6]) {
      this._mesh(new THREE.BoxGeometry(0.05, 0.18, 0.12), dark, sx, 0.6, 1.42);
    }

    // 后视镜
    for (const sx of [-0.96, 0.96]) {
      this._mesh(new THREE.BoxGeometry(0.05, 0.05, 0.14), dark, sx, 0.6, -0.7);
    }

    // 车轮视觉（放在场景根部，由物理 wheelTransform 直接驱动）
    this.wheelMeshes = [];
    const tireGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 22);
    tireGeo.rotateZ(Math.PI / 2); // 使圆柱轴向 = +X（车轴方向）
    const hubGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.32, 12);
    hubGeo.rotateZ(Math.PI / 2);

    for (let i = 0; i < 4; i++) {
      const tire = new THREE.Mesh(tireGeo, tireMat);
      const hub = new THREE.Mesh(hubGeo, silver);
      tire.add(hub);
      tire.castShadow = true;
      tire.receiveShadow = true;
      this.scene.add(tire);
      this.wheelMeshes.push(tire);
    }

    // 车身阴影
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(group);

    // 记录需要参与碰撞的可见部件（用于调试/后续扩展）
    this.body = body;
    this.cabin = cabin;
    this.cabinFrame = cabinFrame;
  }

  _mesh(geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.group.add(m);
    return m;
  }

  // ============================================================
  // 驾驶控制输入（每帧调用一次）
  //   controls: { throttle, brake, steer(-1..1), handbrake, dt }
  // ============================================================
  applyControls(c) {
    const dt = c.dt;
    const fwdSpeed = this.forwardSpeed;

    // 1) 油门状态平滑（缓升缓降），避免起步/爬坡瞬间大扭矩抬头
    const rampK = Math.min(1, dt * 5);
    this._throttleState += (c.throttle - this._throttleState) * rampK;
    // 刹车渐进：S 或空格约 0.2~0.5s 内逐渐加力；松开快速归零
    const wantBrake = c.brake > 0 || c.handbrake;
    const upK = c.handbrake ? 10 : 6;
    if (wantBrake) this._brakeState += (1 - this._brakeState) * Math.min(1, dt * upK);
    else this._brakeState *= Math.max(0, 1 - Math.min(1, dt * 14));
    const br = this._brakeState;

    for (let i = 0; i < 4; i++) {
      this.vehicle.setBrake(0, i);
      this.vehicle.applyEngineForce(0, i);
    }

    if (c.handbrake) {
      // 手刹漂移：后轮锁制柔和、随车速衰减（宁滑不翻），高速自动减弱；
      // 低速行驶中补油维持滑行姿态，松键即可回正
      const v = Math.abs(fwdSpeed);
      const sp = Math.min(1, v / 8);
      const fade = 1 / (1 + v * 0.09); // 车速越高锁制越弱
      const rearBrake = Math.min(240, (HBASE_REAR + 260 * sp) * fade + 30);
      for (const w of this.rearWheels) this.vehicle.setBrake(rearBrake * br, w);
      for (const w of this.frontWheels) this.vehicle.setBrake(Math.min(90, HBASE_FRONT + 40 * sp) * fade * br, w);
      if (this._throttleState > 0.05 && v < 12) {
        const f = this._throttleState * MAX_ENGINE * 0.3;
        for (const w of this.rearWheels) this.vehicle.applyEngineForce(f, w);
      }
    } else if (c.brake > 0) {
      if (fwdSpeed > 1.2) {
        // 前进制动 = 引擎反向力矩（平滑不锁轮，重刹也不会前空翻/暴甩）
        // + 极弱摩擦协助低速停稳
        const ef = -REVERSE_ENGINE * 0.85 * br;
        for (const w of this.frontWheels) this.vehicle.applyEngineForce(ef * FRONT_DRIVE, w);
        for (const w of this.rearWheels) this.vehicle.applyEngineForce(ef * REAR_DRIVE, w);
        for (let i = 0; i < 4; i++) this.vehicle.setBrake(18 * br, i);
      } else {
        // 静止/低速 -> 倒车
        const force = -REVERSE_ENGINE * br;
        for (const w of this.frontWheels) this.vehicle.applyEngineForce(force * FRONT_DRIVE, w);
        for (const w of this.rearWheels) this.vehicle.applyEngineForce(force * REAR_DRIVE, w);
      }
    } else {
      // 油门：四驱，前轴比例略高抑制抬头
      const force = this._throttleState * MAX_ENGINE;
      for (const w of this.frontWheels) this.vehicle.applyEngineForce(force * FRONT_DRIVE, w);
      for (const w of this.rearWheels) this.vehicle.applyEngineForce(force * REAR_DRIVE, w);
    }

    // 2) 转向：基础角加大，随车速“低速渐入 + 高速衰减”，更不容易失控
    const sp = Math.abs(fwdSpeed);
    const lowGain = Math.min(1, sp / 4);   // <4 m/s 渐进，避免原地猛甩
    const highGain = 1 / (1 + sp * 0.012); // 高速降低转向灵敏度
    const target = -c.steer * MAX_STEER * lowGain * highGain;
    const k = 1 - Math.exp(-13 * dt);
    this.steeringSmoothed += (target - this.steeringSmoothed) * k;
    this.vehicle.setSteeringValue(this.steeringSmoothed, 0);
    this.vehicle.setSteeringValue(this.steeringSmoothed, 1);
  }

  /**
   * 物理步进后同步视觉（每帧一次）
   * 必须在 world.step 之后调用：车轮变换以底盘最新位姿刷新
   */
  postStepSync() {
    const chassis = this.chassisBody;
    this.group.position.copy(chassis.position);
    this.group.quaternion.copy(chassis.quaternion);

    for (let i = 0; i < 4; i++) {
      this.vehicle.updateWheelTransform(i);
      const t = this.vehicle.wheelInfos[i].worldTransform;
      const mesh = this.wheelMeshes[i];
      mesh.position.copy(t.position);
      mesh.quaternion.copy(t.quaternion);
    }

    // 更新派生向量
    this.pos.copy(chassis.position);
    this.quat.copy(chassis.quaternion);
    this._v.set(0, 0, -1).applyQuaternion(this.quat);
    this.forward.copy(this._v);
    this._v.set(1, 0, 0).applyQuaternion(this.quat);
    this.right.copy(this._v);
    this._v.set(0, 1, 0).applyQuaternion(this.quat);
    this.up.copy(this._v);
  }

  /** 复位到出生点 */
  reset() {
    this._applySpawn();
    this.steeringSmoothed = 0;
    this.vehicle.setSteeringValue(0, 0);
    this.vehicle.setSteeringValue(0, 1);
    for (const w of [0, 1, 2, 3]) {
      this.vehicle.setBrake(0, w);
      this.vehicle.applyEngineForce(0, w);
    }
    this.postStepSync();
  }

  _applySpawn() {
    const b = this.chassisBody;
    b.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    b.quaternion.setFromEuler(0, SPAWN.yaw, 0);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
  }

  // ============================================================
  // 状态读数
  // ============================================================

  /** 世界系速度 (m/s) */
  get speed() {
    return this.chassisBody.velocity.length();
  }

  /** 沿前进方向的速度 (m/s)，负值=倒车 */
  get forwardSpeed() {
    return this.chassisBody.velocity.dot(this.forward);
  }

  /** 横向速度 (m/s)，用于检测侧滑/漂移 */
  get lateralSpeed() {
    return this.chassisBody.velocity.dot(this.right);
  }

  /** 车速 (km/h，取带方向的数值) */
  get speedKmh() {
    return this.forwardSpeed * 3.6;
  }

  get wheelsOnGround() {
    return this.vehicle.numWheelsOnGround;
  }

  /** 车轮世界坐标（供特效系统取后轮喷烟位置） */
  wheelWorldPosition(i, out) {
    return out.copy(this.wheelMeshes[i].position);
  }
}
