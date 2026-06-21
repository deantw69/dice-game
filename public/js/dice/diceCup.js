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
  const scatter = !!options.scatter; // true:骰子在盅內隨機散落(位置/角度/間距皆隨機)

  container.innerHTML = '';
  const scene = document.createElement('div');
  scene.className = 'cup-scene';

  const tray = document.createElement('div');
  tray.className = scatter ? 'cup-tray scatter' : 'cup-tray';

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
    const H = 168;                                        // 盅內可用高度(盅變高後可堆更高,骰子不用縮太小;留邊距給搖動)
    let d = 56;
    for (; d >= 8; d -= 2) {
      const cols = Math.max(1, Math.floor(W / (d + gap)));
      const rows = Math.ceil(n / cols);
      if (rows * (d + gap) <= H) break;
    }
    tray.style.setProperty('--ds', d + 'px');
    tray.style.gap = gap + 'px';
  }

  // ---- 散落佈局(scatter) ----
  // 在盅內可覆蓋範圍隨機產生位置/角度,間距亦隨機;骰子之間「絕不重疊」
  // (用分離軸定理 SAT 對旋轉方塊做碰撞檢測;放不下就縮小骰子重排)。
  // 同一手期間沿用同一組位置與尺寸,換新一手(重搖)才重抽,
  // 確保 peek 蓋回/打開時骰子不跳動。
  let positions = [];   // [{x, y, rot}](x/y 為左上角,供 CSS left/top)
  let layoutCount = 0;
  let layoutDs = 56;    // 排版時實際採用的骰子尺寸(可能比 applyFit 更小,以容下不重疊)

  // 旋轉方塊的四個角(中心 cx,cy、邊長 d、弧度 rad)
  function corners(cx, cy, d, rad) {
    const h = d / 2, cos = Math.cos(rad), sin = Math.sin(rad);
    return [[-h, -h], [h, -h], [h, h], [-h, h]].map(
      ([px, py]) => [cx + px * cos - py * sin, cy + px * sin + py * cos]
    );
  }
  // 分離軸定理:兩個凸多邊形是否重疊(任一軸上投影有縫即不重疊)
  function overlap(A, B) {
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
        const ax = -(y2 - y1), ay = x2 - x1; // 邊的法線
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
        for (const [x, y] of A) { const p = x * ax + y * ay; if (p < minA) minA = p; if (p > maxA) maxA = p; }
        for (const [x, y] of B) { const p = x * ax + y * ay; if (p < minB) minB = p; if (p > maxB) maxB = p; }
        if (maxA < minB || maxB < minA) return false; // 有縫 → 不重疊
      }
    }
    return true;
  }
  // 最小平移向量(MTV):兩個旋轉方塊重疊時,把它們「剛好分開」的最短方向與深度;
  // 不重疊回 null。供動畫每幀把互相穿插的骰子推開(維持不重疊)。
  function mtv(A, B) {
    let best = Infinity, bx = 0, by = 0;
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
        let ax = -(y2 - y1), ay = x2 - x1;
        const len = Math.hypot(ax, ay) || 1; ax /= len; ay /= len;
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
        for (const [x, y] of A) { const p = x * ax + y * ay; if (p < minA) minA = p; if (p > maxA) maxA = p; }
        for (const [x, y] of B) { const p = x * ax + y * ay; if (p < minB) minB = p; if (p > maxB) maxB = p; }
        if (maxA < minB || maxB < minA) return null; // 有分離軸 → 不重疊
        const o = Math.min(maxA, maxB) - Math.max(minA, minB);
        if (o < best) { best = o; bx = ax; by = ay; }
      }
    }
    return { x: bx, y: by, depth: best };
  }
  // 嘗試用尺寸 d 把 n 顆不重疊地散落到盅內;成功回傳位置陣列,失敗回 null
  function tryPlace(n, d) {
    const W = (tray.clientWidth || 200) - d;   // 左上角 x 上界(留一顆寬,不溢出)
    const H = (tray.clientHeight || 150) - d;  // 左上角 y 上界
    if (W < 0 || H < 0) return null;           // 連一顆都放不下
    const pts = [];
    for (let i = 0; i < n; i++) {
      let placed = false;
      for (let t = 0; t < 200; t++) {
        const x = Math.random() * W, y = Math.random() * H, rot = Math.random() * 360;
        const poly = corners(x + d / 2, y + d / 2, d, rot * Math.PI / 180);
        if (pts.every((p) => !overlap(poly, p.poly))) { pts.push({ x, y, rot, poly }); placed = true; break; }
      }
      if (!placed) return null; // 這顆試 200 次都卡到別人 → 整體放棄(改用更小尺寸)
    }
    return pts;
  }
  function layout(n, regen) {
    if (!regen && positions.length === n) return;
    let d = parseInt(tray.style.getPropertyValue('--ds'), 10) || 56;
    let pts = null;
    for (; d >= 10; d -= 4) {            // 放不下就縮小骰子再試,保證最終不重疊
      pts = tryPlace(n, d);
      if (pts) break;
    }
    if (!pts) { d = 10; pts = tryPlace(n, d) || []; } // 極端情況的保底
    positions = pts.map((p) => ({ x: p.x, y: p.y, rot: p.rot }));
    layoutDs = d;
    layoutCount = n;
  }
  function applyPositions() {
    if (!scatter) return;
    tray.style.setProperty('--ds', layoutDs + 'px'); // 用排版時實際採用的尺寸(碰撞檢測即以此為準)
    const scenes = tray.querySelectorAll('.die3d-scene');
    scenes.forEach((el, i) => {
      const p = positions[i];
      if (!p) return;
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      el.style.transform = `rotate(${p.rot}deg)`; // 外層 2D 旋轉,不影響內層點數朝向
    });
  }

  // ---- 掀蓋時的「撞來撞去」動畫 ----
  // 骰子以隨機初速在盅內移動,撞牆、互撞(每幀用 SAT 把穿插的方塊推開),
  // 受阻尼逐漸減速;因為每一幀都保持「不重疊」,自然停下時就已經是不重疊的
  // 散落樣子,直接定格——不再瞬移到另一組預算好的位置(消除停下瞬間的跳動)。
  let rafId = null, animTimer = null;
  function stopAnim() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  }
  function animateScatter() {
    stopAnim();
    const scenes = [...tray.querySelectorAll('.die3d-scene')];
    const n = scenes.length;
    if (!scatter || !n) { applyPositions(); return; }
    const d = layoutDs;
    tray.style.setProperty('--ds', d + 'px');
    const maxX = Math.max(0, (tray.clientWidth || 200) - d);
    const maxY = Math.max(0, (tray.clientHeight || 150) - d);
    const cn = (s) => corners(s.x + d / 2, s.y + d / 2, d, s.a * Math.PI / 180); // 該骰子目前四角
    const clamp = (s) => { s.x = Math.min(maxX, Math.max(0, s.x)); s.y = Math.min(maxY, Math.max(0, s.y)); };
    // 初始位置沿用骰子「目前畫面上的位置」(掀蓋前已不重疊),避免第一幀瞬移;
    // 沒有舊位置(數量改變→DOM 重建)才退回隨機。再給隨機初速與自轉,讓它們撞來撞去。
    const st = scenes.map((el) => {
      const ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
      const or = parseFloat((el.style.transform.match(/rotate\(([-\d.]+)deg\)/) || [])[1]);
      return {
        x: Number.isFinite(ox) ? Math.min(maxX, Math.max(0, ox)) : Math.random() * maxX,
        y: Number.isFinite(oy) ? Math.min(maxY, Math.max(0, oy)) : Math.random() * maxY,
        a: Number.isFinite(or) ? or : Math.random() * 360,
        vx: (Math.random() * 2 - 1) * 320, vy: (Math.random() * 2 - 1) * 320,
        va: (Math.random() * 2 - 1) * 680,
      };
    });
    const render = () => scenes.forEach((el, i) => {
      const s = st[i];
      el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
      el.style.transform = `rotate(${s.a}deg)`;
    });
    // 把目前所有互相穿插的骰子推開(SAT),iters 次;動畫每幀做一次即可。
    function separate(iters) {
      for (let it = 0; it < iters; it++) {
        let any = false;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const a = st[i], b = st[j];
          const m = mtv(cn(a), cn(b));
          if (!m) continue;
          any = true;
          let nx = m.x, ny = m.y;
          if ((b.x - a.x) * nx + (b.y - a.y) * ny < 0) { nx = -nx; ny = -ny; } // 法線朝 a→b
          const push = m.depth / 2 + 0.1;
          a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {                          // 互相靠近才反彈,交換法線方向速度
            a.vx += nx * rel; a.vy += ny * rel; b.vx -= nx * rel; b.vy -= ny * rel;
            const imp = Math.min(1, -rel / 160);  // 自轉亂數依撞擊力道縮放:輕碰幾乎不加,避免快停時一直抖
            a.va += (Math.random() * 2 - 1) * 140 * imp; b.va += (Math.random() * 2 - 1) * 140 * imp;
          }
          clamp(a); clamp(b);
        }
        if (!any) break;
      }
    }
    const MAX = 1900; // 最長動畫時間(ms)保底
    let start = null, last = null, stillFrames = 0;
    function commit() {                           // 定格在目前(已不重疊)位置
      stopAnim();
      separate(8);                                // 保險:確保完全分開
      positions = st.map((s) => ({ x: s.x, y: s.y, rot: s.a }));
      layoutCount = n;
      applyPositions();
    }
    function frame(ts) {
      if (start === null) { start = ts; last = ts; }
      let dt = (ts - last) / 1000; if (dt > 0.05) dt = 0.05; last = ts;
      const elapsed = ts - start;
      const before = st.map((s) => ({ x: s.x, y: s.y }));
      for (const s of st) {
        s.x += s.vx * dt; s.y += s.vy * dt; s.a += s.va * dt;
        if (s.x < 0) { s.x = 0; s.vx = -s.vx * 0.88; } else if (s.x > maxX) { s.x = maxX; s.vx = -s.vx * 0.88; }
        if (s.y < 0) { s.y = 0; s.vy = -s.vy * 0.88; } else if (s.y > maxY) { s.y = maxY; s.vy = -s.vy * 0.88; }
        s.vx *= 0.972; s.vy *= 0.972; s.va *= 0.96; // 阻尼,逐漸停下(撞約 1 秒多)
        // 速度死區:慢到一定程度直接歸零,避免快停時殘留微小速度造成抖動
        if (s.vx * s.vx + s.vy * s.vy < 100) { s.vx = 0; s.vy = 0; }
        if (Math.abs(s.va) < 24) s.va = 0;
      }
      separate(5);                                // 每幀把穿插的骰子推開,維持不重疊(多迭代→收斂快,尾段不殘留creep)
      render();
      let maxStep = 0;                            // 這一幀實際位移(含碰撞推擠)的最大值
      for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.hypot(st[i].x - before[i].x, st[i].y - before[i].y));
      stillFrames = maxStep < 0.5 ? stillFrames + 1 : 0; // 幾乎不動就準備定格(乾脆停,不拖尾)
      if (stillFrames >= 4 || elapsed > MAX) { commit(); return; } // 真的不動了→立刻定格
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
    // 保底:rAF 若被瀏覽器節流(分頁失焦/隱藏)而停擺,仍用計時器確保最終定格在不重疊位置。
    animTimer = setTimeout(commit, MAX + 400);
  }

  applyFit(options.count || 1);
  const dice = createCssDice(tray, { count: options.count || 1 });
  if (scatter) { layout(options.count || 1, true); applyPositions(); }

  function setCount(n) {
    stopAnim();
    applyFit(n);
    dice.setCount(n);
    if (scatter) { layout(n, n !== layoutCount); applyPositions(); }
  }

  // ---- 分段控制(供遊戲分階段操作:蓋著待命 → 搖動 → 掀蓋亮點)----
  // 蓋著待命(尚未搖):盅落下蓋住,無動畫
  function cover() {
    stopAnim();
    vessel.classList.remove('lift');
    vessel.classList.remove('shake');
  }
  // 搖動(蓋著抖):按住搖骰期間持續抖動
  function shake() {
    vessel.classList.remove('lift');
    vessel.classList.add('shake');
    if (options.sound) playRattle(shakeMs);
  }
  // 掀蓋亮點(放開搖骰、拿到結果):停抖、掀蓋、骰子翻滾到點數
  function reveal(values) {
    applyFit(values.length);
    vessel.classList.remove('shake');
    requestAnimationFrame(() => {
      vessel.classList.add('lift');
      if (scatter) layout(values.length, true);
      dice.rollTo(values);
      if (scatter) animateScatter();
    });
  }
  // 靜態(已開過盅、純重繪):直接掀蓋亮點,不重播動畫
  function setStatic(values) {
    stopAnim();
    applyFit(values.length);
    vessel.classList.remove('shake');
    vessel.classList.add('lift');
    if (scatter) layout(values.length, false); // 同一手沿用,僅數量變動才重抽
    dice.setStatic(values);
    if (scatter) applyPositions();             // 純重繪/再打開:直接定位,不重播撞擊
  }

  const shakeMs = options.shakeMs || 1000; // 搖動(蓋著)時長
  function rollTo(values) {
    applyFit(values.length);
    return new Promise((resolve) => {
      vessel.classList.remove('lift');
      vessel.classList.add('shake');
      if (options.sound) playRattle(shakeMs);
      // 搖完:掀蓋的「同時」才開始讓骰子翻滾 → 掀開後仍看得到骰子轉約半秒
      if (scatter) layout(values.length, true);
      setTimeout(() => {
        vessel.classList.remove('shake');
        vessel.classList.add('lift');
        dice.rollTo(values);
        if (scatter) animateScatter();
      }, shakeMs);
      // 掀蓋(~0.35s)+ 翻滾露出(~0.8s)後完成
      setTimeout(resolve, shakeMs + 1000);
    });
  }

  return { setCount, rollTo, cover, shake, reveal, setStatic, type: 'cup' };
}
