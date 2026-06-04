// Three.js 輕量 3D 骰子渲染器 — 實作共用介面 createRenderer(container, options)
// 介面: { setCount(n), rollTo(values) -> Promise }
import * as THREE from 'three';

// BoxGeometry 材質順序: [+X右, -X左, +Y上, -Y下, +Z前, -Z後]
// 指定點數使對面相加為 7
const FACE_VALUES = [3, 4, 2, 5, 1, 6];

// 將某點數帶到正面(+Z 朝相機)所需的目標旋轉(弧度)
const SHOW_ROTATION = {
  1: { x: 0,            y: 0           },
  6: { x: 0,            y: Math.PI     },
  3: { x: 0,            y: -Math.PI/2  },
  4: { x: 0,            y: Math.PI/2   },
  2: { x: Math.PI/2,    y: 0           },
  5: { x: -Math.PI/2,   y: 0           },
};

function makePipTexture(value) {
  const size = 200;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fdfdfd';
  ctx.fillRect(0, 0, size, size);
  // 傳統骰子:1 點與 4 點為紅色
  ctx.fillStyle = (value === 1 || value === 4) ? '#d4232a' : '#1a1f3d';
  const layouts = {
    1: [[0.5,0.5]],
    2: [[0.27,0.27],[0.73,0.73]],
    3: [[0.27,0.27],[0.5,0.5],[0.73,0.73]],
    4: [[0.27,0.27],[0.73,0.27],[0.27,0.73],[0.73,0.73]],
    5: [[0.27,0.27],[0.73,0.27],[0.5,0.5],[0.27,0.73],[0.73,0.73]],
    6: [[0.27,0.25],[0.73,0.25],[0.27,0.5],[0.73,0.5],[0.27,0.75],[0.73,0.75]],
  };
  const r = size * 0.09;
  for (const [px, py] of layouts[value]) {
    ctx.beginPath();
    ctx.arc(px * size, py * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function makeDie() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const edges = 0.08;
  geo.deleteAttribute('uv'); // 重新走預設 uv 即可,這裡保留簡單
  const materials = FACE_VALUES.map((v) =>
    new THREE.MeshStandardMaterial({ map: makePipTexture(v), roughness: 0.45, metalness: 0.05 })
  );
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
  return mesh;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function createRenderer(container, options = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0.6, 6);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 5, 4);
  scene.add(key);

  let dice = [];

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 280;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setCount(n) {
    for (const d of dice) scene.remove(d.mesh);
    dice = [];
    const spacing = 1.5;
    const startX = -((n - 1) * spacing) / 2;
    for (let i = 0; i < n; i++) {
      const mesh = makeDie();
      mesh.position.x = startX + i * spacing;
      mesh.rotation.set(-0.3, 0.4, 0.1);
      scene.add(mesh);
      dice.push({ mesh });
    }
    resize();
    render();
  }

  function render() {
    renderer.render(scene, camera);
  }

  function rollTo(values) {
    if (values.length !== dice.length) setCount(values.length);
    return new Promise((resolve) => {
      const duration = 1400;
      const start = performance.now();
      const anims = dice.map((d, i) => {
        const target = SHOW_ROTATION[values[i]];
        const spins = 2 + ((i + values[i]) % 3); // 2~4 圈
        return {
          mesh: d.mesh,
          fromX: d.mesh.rotation.x,
          fromY: d.mesh.rotation.y,
          toX: target.x + Math.PI * 2 * spins,
          toY: target.y + Math.PI * 2 * spins,
        };
      });
      function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const e = easeOutCubic(t);
        for (const a of anims) {
          a.mesh.rotation.x = a.fromX + (a.toX - a.fromX) * e;
          a.mesh.rotation.y = a.fromY + (a.toY - a.fromY) * e;
        }
        render();
        if (t < 1) requestAnimationFrame(frame);
        else {
          // 收斂到正規角度,避免累積過大
          anims.forEach((a, i) => {
            a.mesh.rotation.x = SHOW_ROTATION[values[i]].x;
            a.mesh.rotation.y = SHOW_ROTATION[values[i]].y;
          });
          render();
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  window.addEventListener('resize', () => { resize(); render(); });
  setCount(options.count || 1);
  return { setCount, rollTo, type: 'three' };
}
