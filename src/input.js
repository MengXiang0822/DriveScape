// ============================================================
// input.js - 键盘输入管理
// 使用 e.code（物理按键位置），同时支持 WASD 与方向键。
// ============================================================

const KEY = {
  W: 'KeyW', A: 'KeyA', S: 'KeyS', D: 'KeyD',
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  SPACE: 'Space', C: 'KeyC', R: 'KeyR', V: 'KeyV',
};

export class Input {
  constructor() {
    this.keys = new Set();          // 当前按住的按键
    this.pressed = new Set();       // 本帧按下的一次性事件（keydown 触发，被消费后移除）

    this._onKeyDown = (e) => {
      // 阻止方向键/空格滚动页面
      if ([KEY.UP, KEY.DOWN, KEY.LEFT, KEY.RIGHT, KEY.SPACE].includes(e.code)) {
        e.preventDefault();
      }
      if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.keys.add(e.code);
        this.pressed.add(e.code);
      }
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
    };

    this._onBlur = () => {
      this.keys.clear();
      this.pressed.clear();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** 是否按住某键 */
  down(code) {
    return this.keys.has(code);
  }

  /** 取出一次性按下事件（只触发一次），例如视角切换 */
  consume(code) {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  /**
   * 油门：W / 方向上
   * 返回 0..1
   */
  get throttle() {
    return this.down(KEY.W) || this.down(KEY.UP) ? 1 : 0;
  }

  /** 刹车/倒车输入：S / 方向下 */
  get brake() {
    return this.down(KEY.S) || this.down(KEY.DOWN) ? 1 : 0;
  }

  /**
   * 转向：左为 -1（A / 方向左），右为 +1（D / 方向右）
   */
  get steer() {
    let s = 0;
    if (this.down(KEY.A) || this.down(KEY.LEFT)) s -= 1;
    if (this.down(KEY.D) || this.down(KEY.RIGHT)) s += 1;
    return s;
  }

  /** 手刹：空格 */
  get handbrake() {
    return this.down(KEY.SPACE);
  }

  /** 视角切换请求（C / V） */
  consumeViewToggle() {
    return this.consume(KEY.C) || this.consume(KEY.V);
  }

  /** 车辆复位请求（R） */
  consumeReset() {
    return this.consume(KEY.R);
  }

  /** 是否按了任意键（用于跳过启动画面） */
  consumeAny() {
    if (this.pressed.size > 0) {
      this.pressed.clear();
      return true;
    }
    return false;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }
}

export { KEY };
