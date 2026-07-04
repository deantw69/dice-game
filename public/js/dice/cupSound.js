// 喀啦喀啦搖骰音效 — 用 Web Audio 即時合成(無需音檔)
let actx = null;
function ctx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

// 單一「喀」聲:短促帶通雜訊
function burst(ac, when) {
  const dur = 0.025 + Math.random() * 0.035;
  const buf = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * dur)), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1600 + Math.random() * 2600;
  bp.Q.value = 0.7;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.18 + Math.random() * 0.22, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

  src.connect(bp).connect(g).connect(ac.destination);
  src.start(when);
  src.stop(when + dur);
}

// 提示音:輪到你時(話胚成為最小者)播兩聲嗶
export function playAlert() {
  if (typeof window !== 'undefined' && window.__cupMuted) return; // 靜音
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime;
  const beep = (when, freq) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.3, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    o.connect(g).connect(ac.destination);
    o.start(when);
    o.stop(when + 0.2);
  };
  beep(t, 880);        // 第一聲
  beep(t + 0.16, 1175); // 第二聲(higher)
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

// 倒數「督」聲:短促低沉的提示音(手速骰 3-2-1 倒數用)
export function playCountdownTick() {
  if (typeof window !== 'undefined' && window.__cupMuted) return;
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'sine';
  o.frequency.value = 440;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + 0.18);
}

// 嘲諷用的歡樂小號:決出輸家時播(上行 C-E-G-C)
export function playFanfare() {
  if (typeof window !== 'undefined' && window.__cupMuted) return; // 靜音
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime;
  const note = (when, freq, dur) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.2, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(ac.destination);
    o.start(when);
    o.stop(when + dur + 0.02);
  };
  note(t0 + 0.00, 523.25, 0.14); // C5
  note(t0 + 0.14, 659.25, 0.14); // E5
  note(t0 + 0.28, 783.99, 0.14); // G5
  note(t0 + 0.44, 1046.50, 0.40); // C6(拉長)
}

// 最終勝利者:華麗凱旋號角(雙音和聲 + 末段顫音收尾)
export function playVictory() {
  if (typeof window !== 'undefined' && window.__cupMuted) return; // 靜音
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime;
  const note = (when, freq, dur, vol = 0.2, type = 'square') => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(ac.destination);
    o.start(when);
    o.stop(when + dur + 0.02);
  };
  // 上行琶音 G-C-E-G,主旋律 + 低五度和聲
  const mel = [
    [0.00, 783.99, 0.16], // G5
    [0.16, 1046.50, 0.16], // C6
    [0.32, 1318.51, 0.16], // E6
    [0.48, 1567.98, 0.55], // G6(拉長,凱旋)
  ];
  mel.forEach(([w, f, d]) => {
    note(t0 + w, f, d);
    note(t0 + w, f / 1.5, d, 0.12, 'triangle'); // 低五度和聲鋪底
  });
  // 末段顫音收尾
  note(t0 + 1.05, 1567.98, 0.10, 0.18);
  note(t0 + 1.18, 2093.00, 0.30, 0.2); // C7 高八度作結
}

// 炸彈爆炸:低頻轟隆爆裂 + 次低音衝擊 + 碎裂尾音(驚爆骰爆掉時播)
export function playExplosion() {
  if (typeof window !== 'undefined' && window.__cupMuted) return; // 靜音
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime;

  // 1) 寬頻雜訊爆裂(低通掃頻,模擬轟隆衝擊波)
  const dur = 0.9;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const decay = Math.pow(1 - i / data.length, 2); // 指數衰減
    data[i] = (Math.random() * 2 - 1) * decay;
  }
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, t0);
  lp.frequency.exponentialRampToValueAtTime(120, t0 + dur);
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.0001, t0);
  ng.gain.exponentialRampToValueAtTime(0.9, t0 + 0.01);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  noise.connect(lp).connect(ng).connect(ac.destination);
  noise.start(t0);
  noise.stop(t0 + dur);

  // 2) 次低音衝擊(下滑正弦,胸腔感)
  const sub = ac.createOscillator();
  const sg = ac.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(160, t0);
  sub.frequency.exponentialRampToValueAtTime(35, t0 + 0.5);
  sg.gain.setValueAtTime(0.0001, t0);
  sg.gain.exponentialRampToValueAtTime(0.9, t0 + 0.015);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
  sub.connect(sg).connect(ac.destination);
  sub.start(t0);
  sub.stop(t0 + 0.6);
}

// 在 durationMs 內連續播放喀啦聲(模擬骰子在盅內碰撞)
let lastPlay = -1;
export function playRattle(durationMs = 950) {
  if (typeof window !== 'undefined' && window.__cupMuted) return; // 靜音
  const ac = ctx();
  if (!ac) return;
  // 同一時間多個骰盅只播一次,避免疊加吵雜
  if (ac.currentTime - lastPlay < 0.2) return;
  lastPlay = ac.currentTime;
  const start = ac.currentTime;
  const end = start + durationMs / 1000;
  let t = start;
  while (t < end) {
    burst(ac, t);
    t += 0.045 + Math.random() * 0.07; // 約 45~115ms 一聲
  }
}
