// 20 面骰(d20)渲染器 — 真正的 CSS 3D 二十面體(icosahedron)
// 介面: { setCount(n), rollTo(values) -> Promise, setStatic(values) }
// 20 個三角形面各自帶數字 1~20,搖動時於 3D 空間翻滾,最後把對應點數的面轉向鏡頭。

const ROLL_MS = 1200;
const R_PX = 42;                              // 外接球半徑(像素)
const LIGHT = norm([-0.4, -0.7, 0.6]);       // 世界(螢幕)空間打光方向,y 朝下

const BASE = {
  violet:  [124, 92, 255],
  emerald: [52, 211, 153],
  crimson: [251, 113, 133],
};

// ---- 向量小工具 ----
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function scale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function len(a) { return Math.sqrt(dot(a, a)); }
function norm(a) { const l = len(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

// ---- 3x3 矩陣小工具 ----
function matMul(A, B) {
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    C[i][j] = A[i][0]*B[0][j] + A[i][1]*B[1][j] + A[i][2]*B[2][j];
  return C;
}
function rotX(t) { const c=Math.cos(t), s=Math.sin(t); return [[1,0,0],[0,c,-s],[0,s,c]]; }
function rotY(t) { const c=Math.cos(t), s=Math.sin(t); return [[c,0,s],[0,1,0],[-s,0,c]]; }
function rotZ(t) { const c=Math.cos(t), s=Math.sin(t); return [[c,-s,0],[s,c,0],[0,0,1]]; }
// 由 3x3 旋轉矩陣(+可選平移)組成 CSS matrix3d(欄優先)
function m3(R, t) {
  const T = t || [0, 0, 0];
  return `matrix3d(${R[0][0]},${R[1][0]},${R[2][0]},0,${R[0][1]},${R[1][1]},${R[2][1]},0,${R[0][2]},${R[1][2]},${R[2][2]},0,${T[0]},${T[1]},${T[2]},1)`;
}

// 靜止時的傾斜角(也作為動畫起點),用 matrix3d 表示以利和關鍵影格插補
const INIT = matMul(rotX(-0.35), rotY(0.4));
const INIT_STR = m3(INIT);

// ---- 二十面體幾何(只算一次) ----
const GEO = (() => {
  const P = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [0, 1, P], [0, 1, -P], [0, -1, P], [0, -1, -P],
    [1, P, 0], [1, -P, 0], [-1, P, 0], [-1, -P, 0],
    [P, 0, 1], [P, 0, -1], [-P, 0, 1], [-P, 0, -1],
  ];
  const s = R_PX / Math.sqrt(1 + P * P);
  const V = raw.map((v) => scale(v, s));
  const edge2 = 4 * s * s;                 // 邊長²(原始邊長 2)
  const faces = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++)
      for (let k = j + 1; k < 12; k++) {
        const d = (a, b) => { const t = sub(V[a], V[b]); return dot(t, t); };
        const close = (x) => Math.abs(x - edge2) < edge2 * 0.05;
        if (close(d(i, j)) && close(d(j, k)) && close(d(i, k))) faces.push([i, j, k]);
      }
  const faceR = (2 * s) / Math.sqrt(3);    // 三角面外接半徑(像素)
  const list = faces.map(([a, b, c], idx) => {
    const A = V[a], B = V[b], C = V[c];
    const cen = scale(add(add(A, B), C), 1 / 3);
    let n = norm(cross(sub(B, A), sub(C, A)));
    if (dot(n, cen) < 0) n = scale(n, -1);
    const u = norm(sub(A, cen));            // 指向頂點 A
    const w = cross(n, u);                  // 與 u、n 正交;det[u w n]=+1 不鏡像
    // 面矩陣:欄 = u / w / n,平移 = 面中心
    const matrix = `matrix3d(${u[0]},${u[1]},${u[2]},0,${w[0]},${w[1]},${w[2]},0,${n[0]},${n[1]},${n[2]},0,${cen[0]},${cen[1]},${cen[2]},1)`;
    return { idx, n, matrix };
  });
  return { faces: list, faceR };
})();

// 把面法線 n 轉向鏡頭(+z)的旋轉矩陣(3x3)
function landingR(n) {
  const z = [0, 0, 1];
  const d = Math.max(-1, Math.min(1, dot(n, z)));
  if (d > 0.99999) return [[1,0,0],[0,1,0],[0,0,1]];
  if (d < -0.99999) return [[1,0,0],[0,-1,0],[0,0,-1]];
  const a = norm(cross(n, z));
  const t = Math.acos(d), c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const [x, y, zz] = a;
  return [
    [c + x*x*C,     x*y*C - zz*s, x*zz*C + y*s],
    [y*x*C + zz*s,  c + y*y*C,    y*zz*C - x*s],
    [zz*x*C - y*s,  zz*y*C + x*s, c + zz*zz*C],
  ];
}

// 把 3x3 旋轉套到向量上
function applyR(R, v) {
  return [
    R[0][0]*v[0] + R[0][1]*v[1] + R[0][2]*v[2],
    R[1][0]*v[0] + R[1][1]*v[1] + R[1][2]*v[2],
    R[2][0]*v[0] + R[2][1]*v[1] + R[2][2]*v[2],
  ];
}

function transpose(R) {
  return [[R[0][0],R[1][0],R[2][0]],[R[0][1],R[1][1],R[2][1]],[R[0][2],R[1][2],R[2][2]]];
}

// 繞任意單位軸 a 轉角度 t 的旋轉矩陣(Rodrigues)
function rotAxis(a, t) {
  const c = Math.cos(t), s = Math.sin(t), C = 1 - c, [x, y, z] = a;
  return [
    [c + x*x*C,   x*y*C - z*s, x*z*C + y*s],
    [y*x*C + z*s, c + y*y*C,   y*z*C - x*s],
    [z*x*C - y*s, z*y*C + x*s, c + z*z*C],
  ];
}

// 由旋轉矩陣取出軸與角(angle ∈ [0, π])
function axisAngle(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  const angle = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (angle < 1e-6) return { axis: [0, 1, 0], angle: 0 };
  if (Math.PI - angle < 1e-6) {                 // 角≈π:由對角線取軸
    const xx = (R[0][0]+1)/2, yy = (R[1][1]+1)/2, zz = (R[2][2]+1)/2;
    let x = Math.sqrt(Math.max(0, xx)), y = Math.sqrt(Math.max(0, yy)), z = Math.sqrt(Math.max(0, zz));
    const xy = (R[0][1]+R[1][0])/4, xz = (R[0][2]+R[2][0])/4, yz = (R[1][2]+R[2][1])/4;
    if (x >= y && x >= z) { if (xy < 0) y = -y; if (xz < 0) z = -z; }
    else if (y >= z)      { if (xy < 0) x = -x; if (yz < 0) z = -z; }
    else                  { if (xz < 0) x = -x; if (yz < 0) y = -y; }
    return { axis: norm([x, y, z]), angle: Math.PI };
  }
  const s = 2 * Math.sin(angle);
  return { axis: norm([(R[2][1]-R[1][2])/s, (R[0][2]-R[2][0])/s, (R[1][0]-R[0][1])/s]), angle };
}

// 依骰子目前朝向 R,用「世界空間」法線重新打光,讓面隨視角呈現明暗(立體感關鍵)
function shade(d, R) {
  const base = d.base;
  d.faces.forEach((fc) => {
    const wn = applyR(R, fc.n);                       // 世界空間法線
    const k = 0.34 + 0.66 * Math.max(0, dot(wn, LIGHT));
    const c = base.map((v) => Math.round(Math.min(255, v * k)));
    fc.el.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
  });
}

function buildDie(style) {
  const base = BASE[style] || BASE.violet;
  const scene = document.createElement('div');
  scene.className = 'd20-scene';
  const die = document.createElement('div');
  die.className = 'd20';
  const box = GEO.faceR * 2;
  const faces = GEO.faces.map((f, i) => {
    const face = document.createElement('div');
    face.className = 'd20-face';
    face.style.width = box + 'px';
    face.style.height = box + 'px';
    face.style.marginLeft = -GEO.faceR + 'px';
    face.style.marginTop = -GEO.faceR + 'px';
    face.style.fontSize = (box * 0.28) + 'px';
    face.style.transform = f.matrix;
    const num = document.createElement('span');
    num.className = 'd20-num';
    const val = i + 1;
    num.textContent = val;              // 第 i 個面 = 點數 i+1
    if (val === 6 || val === 9) num.classList.add('ul');  // 底線區分 6/9
    face.appendChild(num);
    die.appendChild(face);
    return { el: face, n: f.n };
  });
  die.style.transform = INIT_STR;
  scene.appendChild(die);
  const d = { scene, die, faces, base, R: INIT, raf: 0 };
  shade(d, INIT);                        // 初始朝向先打一次光
  return d;
}

export function createRenderer(container, options = {}) {
  const style = options.style || 'violet';
  const scatter = !!options.scatter; // true:骰子在容器內隨機散落,翻滾時撞來撞去(同吹牛骰盅內的散落感)
  let dice = [];
  let tray = container;              // scatter 時改用內層相對定位 tray 當邊界

  // ---- 散落 / 碰撞(scatter,移植自 diceCup;d20 已自帶 3D 翻滾,故碰撞用軸對齊方框即可)----
  let BOX = 96;          // 量到的單顆 scene 尺寸(px),作為碰撞方框邊長基準
  let positions = [];    // [{x, y}] scene 左上角
  let layoutCount = 0;
  let layoutDs = 96;     // 排版時實際採用的方框邊長(放不下會縮小)

  const clampv = (v, max) => Math.min(max, Math.max(0, v));

  // 嘗試用邊長 d 把 n 顆軸對齊方框不重疊地散落到 tray 內;成功回位置陣列,失敗回 null
  function tryPlace(n, d) {
    const W = (tray.clientWidth || 300) - d, H = (tray.clientHeight || 260) - d;
    if (W < 0 || H < 0) return null;
    const pts = [];
    for (let i = 0; i < n; i++) {
      let placed = false;
      for (let t = 0; t < 200; t++) {
        const x = Math.random() * W, y = Math.random() * H;
        if (pts.every((p) => !(x < p.x + d && x + d > p.x && y < p.y + d && y + d > p.y))) {
          pts.push({ x, y }); placed = true; break;
        }
      }
      if (!placed) return null;
    }
    return pts;
  }
  function layout(n, regen) {
    if (!regen && positions.length === n) return;
    let d = BOX, pts = null;
    for (; d >= 32; d -= 8) { pts = tryPlace(n, d); if (pts) break; }
    if (!pts) { d = 32; pts = tryPlace(n, d) || []; }
    positions = pts.map((p) => ({ x: p.x, y: p.y }));
    layoutDs = d; layoutCount = n;
  }
  function applyPositions() {
    if (!scatter) return;
    const s = layoutDs / BOX;
    [...tray.querySelectorAll('.d20-scene')].forEach((el, i) => {
      const p = positions[i]; if (!p) return;
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      el.style.transform = `scale(${s})`;
    });
  }

  // ---- 翻滾時的「撞來撞去」動畫(2D 平移 + 軸對齊碰撞,逐漸阻尼停下)----
  let rafId = null, animTimer = null;
  function stopAnim() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  }
  function animateScatter() {
    stopAnim();
    const scenes = [...tray.querySelectorAll('.d20-scene')];
    const n = scenes.length;
    if (!scatter || !n) return;
    const d = layoutDs;
    const maxX = Math.max(0, (tray.clientWidth || 300) - d);
    const maxY = Math.max(0, (tray.clientHeight || 260) - d);
    const s = d / BOX;
    // 由目前畫面位置起步(避免第一幀瞬移),再給隨機初速撞來撞去
    const st = scenes.map((el) => {
      const ox = parseFloat(el.style.left), oy = parseFloat(el.style.top);
      return {
        x: Number.isFinite(ox) ? clampv(ox, maxX) : Math.random() * maxX,
        y: Number.isFinite(oy) ? clampv(oy, maxY) : Math.random() * maxY,
        vx: (Math.random() * 2 - 1) * 360, vy: (Math.random() * 2 - 1) * 360,
      };
    });
    const clamp = (o) => { o.x = clampv(o.x, maxX); o.y = clampv(o.y, maxY); };
    const render = () => scenes.forEach((el, i) => {
      el.style.left = st[i].x + 'px'; el.style.top = st[i].y + 'px';
      el.style.transform = `scale(${s})`;
    });
    function separate(iters) {
      for (let it = 0; it < iters; it++) {
        let any = false;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const a = st[i], b = st[j];
          const ox = Math.min(a.x + d, b.x + d) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + d, b.y + d) - Math.max(a.y, b.y);
          if (ox <= 0 || oy <= 0) continue;
          any = true;
          if (ox < oy) {                          // 沿 x 軸分離(穿透較淺)
            const nx = a.x <= b.x ? 1 : -1, push = ox / 2 + 0.1;
            a.x -= nx * push; b.x += nx * push;
            const rel = (b.vx - a.vx) * nx;
            if (rel < 0) { a.vx += nx * rel; b.vx -= nx * rel; } // 互相靠近才交換法線方向速度
          } else {                                // 沿 y 軸分離
            const ny = a.y <= b.y ? 1 : -1, push = oy / 2 + 0.1;
            a.y -= ny * push; b.y += ny * push;
            const rel = (b.vy - a.vy) * ny;
            if (rel < 0) { a.vy += ny * rel; b.vy -= ny * rel; }
          }
          clamp(a); clamp(b);
        }
        if (!any) break;
      }
    }
    const MAX = ROLL_MS; // 散落位移在 3D 翻滾露出最終面的那一刻就停,結尾不留小滑動
    let start = null, last = null, stillFrames = 0;
    function commit() {
      stopAnim();
      separate(8);
      positions = st.map((o) => ({ x: o.x, y: o.y }));
      layoutCount = n;
      applyPositions();
    }
    function frame(ts) {
      if (start === null) { start = ts; last = ts; }
      let dt = (ts - last) / 1000; if (dt > 0.05) dt = 0.05; last = ts;
      const elapsed = ts - start;
      const damp = Math.pow(0.945, dt * 60);     // 阻尼較強,讓位移在 ROLL_MS(露面)前自然停妥而非突然凍結;依時間衰減,高刷新率螢幕一致
      const before = st.map((o) => ({ x: o.x, y: o.y }));
      let moving = false;
      for (const o of st) {
        o.x += o.vx * dt; o.y += o.vy * dt;
        if (o.x < 0) { o.x = 0; o.vx = -o.vx * 0.88; } else if (o.x > maxX) { o.x = maxX; o.vx = -o.vx * 0.88; }
        if (o.y < 0) { o.y = 0; o.vy = -o.vy * 0.88; } else if (o.y > maxY) { o.y = maxY; o.vy = -o.vy * 0.88; }
        o.vx *= damp; o.vy *= damp;
        if (o.vx * o.vx + o.vy * o.vy < 100) { o.vx = 0; o.vy = 0; }
        if (o.vx || o.vy) moving = true;
      }
      separate(5);
      render();
      if (!moving) { commit(); return; }
      let maxStep = 0;
      for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.hypot(st[i].x - before[i].x, st[i].y - before[i].y));
      stillFrames = maxStep < 0.5 ? stillFrames + 1 : 0;
      if (stillFrames >= 4 || elapsed > MAX) { commit(); return; }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
    animTimer = setTimeout(commit, MAX + 200);
  }

  // 與 diceCup 一致:建立時就依 count 先渲染骰子(否則首次 roll 前畫面空白)

  function setCount(n) {
    stopAnim();
    container.innerHTML = '';
    dice = [];
    tray = container;
    if (scatter) {
      tray = document.createElement('div');
      tray.className = 'd20-tray';
      tray.style.cssText = 'position:relative;width:100%;height:100%;';
      container.appendChild(tray);
    }
    for (let i = 0; i < n; i++) {
      const d = buildDie(style);
      if (scatter) { d.scene.style.position = 'absolute'; d.scene.style.transformOrigin = '0 0'; }
      tray.appendChild(d.scene);
      dice.push(d);
    }
    if (scatter) {
      BOX = dice[0] ? (dice[0].scene.offsetWidth || 96) : 96;
      layout(n, true);
      applyPositions();
    }
  }

  function faceFor(value) {
    const idx = Math.max(1, Math.min(20, value | 0)) - 1;
    return GEO.faces[idx];
  }

  function settle(d, R) {                 // 立即定位 + 打光,並停掉進行中的翻滾
    if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
    d.R = R;
    d.die.style.transform = m3(R);
    shade(d, R);
  }

  function setStatic(values) {
    if (values.length !== dice.length) setCount(values.length);
    stopAnim();
    dice.forEach((d, i) => settle(d, landingR(faceFor(values[i]).n)));
    if (scatter) { layout(values.length, values.length !== layoutCount); applyPositions(); }
  }

  // 以 rAF 連續剛體翻滾:繞「起點→落點」的旋轉軸多轉幾圈,每幀依世界空間
  // 法線重新打光(光源固定在螢幕、不隨骰子轉),最後剛好落在結果面。
  function spin(d, Rl) {
    return new Promise((resolve) => {
      if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
      const Rstart = d.R;
      // 對齊用的測地線旋轉:把 Rstart 轉到落點 Rl(角度小、不負責「多圈」)
      const { axis, angle } = axisAngle(matMul(Rl, transpose(Rstart)));
      // 翻滾主體:繞「隨機方向軸」整數圈翻滾,每次擲骰方向都不同;
      // 因為是整數圈(2π 倍數),回到單位旋轉,不影響最終落點。
      const tumbleAxis = norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
      const dir = Math.random() < 0.5 ? -1 : 1;
      const turns = 3 + ((Math.random() * 3) | 0);      // 整圈數 → 轉得快又夠亂
      const tumble = dir * 2 * Math.PI * turns;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      let t0 = 0;
      const step = (now) => {
        if (!t0) t0 = now;
        const p = Math.min(1, (now - t0) / ROLL_MS);
        const e = ease(p);
        // 先繞隨機軸翻滾(整圈),再做測地線對齊;p=1 時翻滾歸零 → 精準落在 Rl
        const R = matMul(rotAxis(axis, angle * e), matMul(rotAxis(tumbleAxis, tumble * e), Rstart));
        d.die.style.transform = m3(R);
        shade(d, R);
        if (p < 1) { d.raf = requestAnimationFrame(step); }
        else { d.raf = 0; settle(d, Rl); resolve(); }
      };
      d.raf = requestAnimationFrame(step);
    });
  }

  // rollIdx:只翻滾這些索引;其餘瞬間定位。未提供 → 全部翻滾
  function rollTo(values, rollIdx) {
    if (values.length !== dice.length) setCount(values.length);
    const animSet = rollIdx ? new Set(rollIdx) : null;
    const p = Promise.all(dice.map((d, i) => {
      const Rl = landingR(faceFor(values[i]).n);
      if (animSet && !animSet.has(i)) { settle(d, Rl); return Promise.resolve(); }
      return spin(d, Rl);
    }));
    // 3D 翻滾的同時,讓骰子在容器內撞來撞去散落(由目前位置起步,不瞬移)
    if (scatter) animateScatter();
    return p;
  }

  if (options.count) setCount(options.count);

  return { setCount, rollTo, setStatic };
}
