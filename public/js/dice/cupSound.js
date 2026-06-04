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
