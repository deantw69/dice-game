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
