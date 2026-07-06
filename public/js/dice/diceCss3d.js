// CSS 3D 骰子渲染器 — 實作共用介面 createRenderer(container, options)
// 介面: { setCount(n), rollTo(values) -> Promise }

const PIP_LAYOUT = {
  1: ['p-mc'],
  2: ['p-tl', 'p-br'],
  3: ['p-tl', 'p-mc', 'p-br'],
  4: ['p-tl', 'p-tr', 'p-bl', 'p-br'],
  5: ['p-tl', 'p-tr', 'p-mc', 'p-bl', 'p-br'],
  6: ['p-tl', 'p-tr', 'p-ml', 'p-mr', 'p-bl', 'p-br'],
};

// 將某點數帶到正面(facing camera)所需的基礎旋轉
const SHOW_ROTATION = {
  1: { x: 0,   y: 0    },
  2: { x: -90, y: 0    },
  3: { x: 0,   y: -90  },
  4: { x: 0,   y: 90   },
  5: { x: 90,  y: 0    },
  6: { x: 0,   y: -180 },
};

function buildFace(value) {
  const face = document.createElement('div');
  face.className = `face f${value}`;
  for (const cls of PIP_LAYOUT[value]) {
    const pip = document.createElement('div');
    pip.className = `pip ${cls}`;
    face.appendChild(pip);
  }
  return face;
}

function buildDie() {
  const scene = document.createElement('div');
  scene.className = 'die3d-scene';
  const die = document.createElement('div');
  die.className = 'die3d';
  for (let v = 1; v <= 6; v++) die.appendChild(buildFace(v));
  scene.appendChild(die);
  // 預設靜止角度(略為傾斜呈現 3D 感),也作為第一次搖骰的動畫起點
  die.style.transform = 'rotateX(-18deg) rotateY(-24deg)';
  return { scene, die, spins: 0 };
}

export function createRenderer(container, options = {}) {
  let dice = [];

  function setCount(n) {
    container.innerHTML = '';
    dice = [];
    for (let i = 0; i < n; i++) {
      const d = buildDie();
      container.appendChild(d.scene);
      dice.push(d);
    }
  }

  // rollIdx:只滾動這些索引的骰子;其餘瞬間定位(不旋轉)。未提供 → 全部滾動
  function rollTo(values, rollIdx) {
    if (values.length !== dice.length) setCount(values.length);
    const animSet = rollIdx ? new Set(rollIdx) : null;
    // 強制 reflow:確保剛建立 / 重設的骰子會以 transition 動畫翻滾,而非瞬間跳到結果
    void container.offsetWidth;
    return new Promise((resolve) => {
      const statics = []; // 不滾動的骰子:先全部寫入,最後只做一次 reflow(仿 setStatic 的批次寫法)
      dice.forEach((d, i) => {
        const target = SHOW_ROTATION[values[i]];
        if (!animSet || animSet.has(i)) {
          // 每次累加整圈,讓動畫每次都翻滾(3~5 圈,依骰子變化)
          d.spins += 3 + Math.floor(((i * 37 + values[i] * 13) % 3));
          const x = target.x + 360 * d.spins;
          const y = target.y + 360 * d.spins;
          d.die.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`;
        } else {
          // 不滾動的骰子(鎖定 / 點數沒變):瞬間定位到該點數,不旋轉
          d.die.style.transition = 'none';
          d.spins = 0;
          d.die.style.transform = `rotateX(${target.x}deg) rotateY(${target.y}deg)`;
          statics.push(d);
        }
      });
      if (statics.length) {
        void container.offsetWidth; // flush 一次,避免恢復 transition 時補動畫
        statics.forEach((d) => { d.die.style.transition = ''; });
      }
      // 與 CSS transition 時長一致(1.4s)
      setTimeout(resolve, 1450);
    });
  }

  // 靜態顯示點數(無翻滾動畫)— 用於「開牌」直接亮點數
  function setStatic(values) {
    if (values.length !== dice.length) setCount(values.length);
    dice.forEach((d, i) => {
      const t = SHOW_ROTATION[values[i]];
      d.spins = 0;
      d.die.style.transition = 'none';
      d.die.style.transform = `rotateX(${t.x}deg) rotateY(${t.y}deg)`;
    });
    void container.offsetWidth; // flush,避免之後恢復 transition 時補動畫
    dice.forEach((d) => { d.die.style.transition = ''; });
  }

  setCount(options.count || 1);
  return { setCount, rollTo, setStatic, type: 'css3d' };
}
