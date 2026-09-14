// ============================================================
// main.js - 入口
// DriveScape：3D 物理驾驶模拟器（Three.js + cannon-es）
// 启动方式：npm run dev
// ============================================================

import './style.css';
import { Game } from './game.js';

const container = document.getElementById('game-container');

// 全局错误显示（便于开发阶段排查）
window.addEventListener('error', (e) => {
  console.error('[DriveScape] 运行时错误:', e.error || e.message);
});

const game = new Game(container);
window.game = game; // 便于在控制台调试

// 赛道巡航演示：URL 带 auto=1 时启动自动驾驶（验证/演示爬山赛道）
if (new URLSearchParams(location.search).get('auto') === '1') {
  import('./autopilot.js').then((m) => m.startAutopilot(game));
}
