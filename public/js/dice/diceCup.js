// 骰盅版渲染器 — 骰盅蓋住骰子搖動(喀啦音效),再掀蓋亮點數
// 介面同其他渲染器:{ setCount(n), rollTo(values) -> Promise }
// options: { count, style, lift, sound }
//   style: purple | wood | metal | jade | dark
//   lift : up | left | right | tilt
//   sound: 是否播放喀啦喀啦音效
import { createRenderer as createCssDice } from './diceCss3d.js';
import { playRattle } from './cupSound.js';

export function createRenderer(container, options = {}) {
  const style = options.style || 'purple';
  const lift = options.lift || 'up';

  container.innerHTML = '';
  const scene = document.createElement('div');
  scene.className = 'cup-scene';

  const tray = document.createElement('div');
  tray.className = 'cup-tray';

  const vessel = document.createElement('div');
  vessel.className = `cup-vessel cup-style-${style} dir-${lift}`;
  vessel.innerHTML = '<div class="cup-body"></div>';

  scene.appendChild(tray);
  scene.appendChild(vessel);
  container.appendChild(scene);

  // 依數量算出最大可塞進盅內的骰子尺寸(用實際量到的盅寬,確保不溢出)
  function applyFit(n) {
    const gap = n > 30 ? 2 : 4;
    const W = Math.max(110, tray.clientWidth || 260) - 6; // 盅內可用寬度
    const H = 108;                                        // 盅內可用高度(留邊距給搖動)
    let d = 56;
    for (; d >= 8; d -= 2) {
      const cols = Math.max(1, Math.floor(W / (d + gap)));
      const rows = Math.ceil(n / cols);
      if (rows * (d + gap) <= H) break;
    }
    tray.style.setProperty('--ds', d + 'px');
    tray.style.gap = gap + 'px';
  }

  applyFit(options.count || 1);
  const dice = createCssDice(tray, { count: options.count || 1 });

  function setCount(n) {
    applyFit(n);
    dice.setCount(n);
  }

  const shakeMs = options.shakeMs || 1000; // 搖動(蓋著)時長
  function rollTo(values) {
    applyFit(values.length);
    return new Promise((resolve) => {
      vessel.classList.remove('lift');
      vessel.classList.add('shake');
      if (options.sound) playRattle(shakeMs);
      // 搖完:掀蓋的「同時」才開始讓骰子翻滾 → 掀開後仍看得到骰子轉約半秒
      setTimeout(() => {
        vessel.classList.remove('shake');
        vessel.classList.add('lift');
        dice.rollTo(values);
      }, shakeMs);
      // 掀蓋(~0.35s)+ 翻滾露出(~0.8s)後完成
      setTimeout(resolve, shakeMs + 1000);
    });
  }

  return { setCount, rollTo, type: 'cup' };
}
