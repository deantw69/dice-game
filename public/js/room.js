// 房間 UI 與 socket 事件繫結
import { socket, emit, loadSession, clearSession } from './net.js';
import { createRenderer as createDice } from './dice/diceCss3d.js';
import { playAlert, playFanfare, playRattle } from './dice/cupSound.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase();
const session = loadSession();

if (!session || !session.playerId || session.code !== code) {
  location.href = '/';
}

let state = null;            // 最新 roomState
const myId = session.playerId;
const diceCache = new Map(); // cellKey -> { renderer, last }
let pokerStaticDone = false; // 話胚:初次「一次開全部牌」用靜態,之後重骰點數變動才滾動
let lastRollSeq = 0;          // 話胚:已處理的重骰序號(用來觸發「該次重骰」的滾動動畫)
let wasLowest = false;        // 話胚:上次 render 時我是否為最小者(用來在「剛輪到我」時播提示音)
let wasNeedRoll = false;      // 上次 render 時我是否需要搖骰(用來在「剛輪到我搖骰」時播提示音)
let lastLoserKey = '';        // 上次顯示的輸家(用來在「剛決出輸家」時播一次嘲諷音效)
let autoNext = localStorage.getItem('dice.autoNext') === '1'; // 房主:自動下一場
let autoNextTimer = null;     // 自動下一場的延遲計時器
let autoNextArmed = false;    // 本次進大廳是否已排程過(避免重複/洗版)
let autoRoll = localStorage.getItem('dice.autoRoll') === '1'; // 玩家:搖骰環節自動骰
let autoRolling = false;      // 防止自動骰重複送出

// ---- 連線 / 重連 ----
async function doRejoin() {
  const res = await emit('rejoin', { code, playerId: myId });
  if (res.error) {
    toast(res.error + '(將返回首頁)');
    clearSession();
    setTimeout(() => (location.href = '/'), 1500);
  }
}
socket.on('connect', doRejoin);
socket.on('roomState', (s) => { state = s; render(); });

// 被房主踢出
socket.on('kicked', () => {
  clearSession();
  alert('你已被房主移出房間');
  location.href = '/';
});

// ---- 小工具 ----
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg || '';
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => ($('toast').textContent = ''), 3500);
}
async function act(event, payload) {
  const res = await emit(event, payload);
  if (res.error) toast(res.error);
}

// 顯示骰子(快取 renderer)。staticShow=true 直接亮點數(無翻滾動畫,用於開牌)
// rollIdx:明確指定要滾動的骰子索引 → 強制滾動(即使點數與上次相同,例如重骰剛好同點)
function showDice(container, key, values, hidden = false, staticShow = false, rollIdx = undefined) {
  if (hidden) {
    container.innerHTML = values.map(() => '<div class="cup">?</div>').join('');
    diceCache.delete(key);
    return;
  }
  let entry = diceCache.get(key);
  if (!entry || entry.el !== container || entry.count !== values.length) {
    container.innerHTML = '';
    const renderer = createDice(container, { count: values.length });
    entry = { renderer, el: container, count: values.length, last: null };
    diceCache.set(key, entry);
  }
  const sig = values.join(',');
  if (!staticShow && rollIdx !== undefined) {
    // 強制滾動指定骰子(由重骰事件驅動,不受「點數沒變」影響)
    entry.renderer.rollTo(values, rollIdx);
    entry.last = sig;
  } else if (entry.last !== sig) {
    // 一般情形:以「點數」為簽章,點數有變才更新(靜態↔動畫切換但點數沒變時不誤觸發)
    if (staticShow) entry.renderer.setStatic(values);
    else entry.renderer.rollTo(values);
    entry.last = sig;
  }
  // 清除上一輪開牌的叉叉(reveal 時會由 markRemovedDice 重新標記)
  container.querySelectorAll('.die3d-scene.marked').forEach((s) => s.classList.remove('marked'));
}

// 紅黑單雙條件判定(與後端一致)
const COND_MATCH = {
  red: (d) => d === 1 || d === 4,
  black: (d) => !(d === 1 || d === 4),
  odd: (d) => d % 2 === 1,
  even: (d) => d % 2 === 0,
  big: (d) => d >= 4,
  small: (d) => d <= 3,
};

// 開牌時在「要被拿掉」的骰子上畫叉叉
function markRemovedDice(container, values, condition) {
  const fn = COND_MATCH[condition];
  const scenes = container.querySelectorAll('.die3d-scene');
  scenes.forEach((sc, i) => {
    if (fn && fn(values[i])) sc.classList.add('marked');
    else sc.classList.remove('marked');
  });
}

// 話胚:鎖定骰子(灰框+鎖頭)。locked=要顯示鎖定的索引(server 廣播,所有人可見);
// interactive=只有「輪到我重骰」時可點選切換,點選會送 setLock 給 server
function applyLockUI(container, locked, interactive) {
  const set = new Set(locked || []);
  const scenes = container.querySelectorAll('.die3d-scene');
  scenes.forEach((sc, i) => {
    sc.classList.toggle('locked', set.has(i));
    if (interactive) {
      sc.classList.add('lockable');
      sc.onclick = () => {
        const next = new Set(set);
        if (next.has(i)) next.delete(i); else next.add(i);
        sc.classList.toggle('locked', next.has(i)); // 立即視覺回饋
        act('action', { type: 'setLock', locked: [...next] });
      };
    } else {
      sc.classList.remove('lockable');
      sc.onclick = null;
    }
  });
}

// 依當下玩家列表的順序(不再把自己移到第一格)
function orderedPlayers() {
  return [...state.players];
}

// ---- 主 render ----
function render() {
  if (!state) return;
  $('rcode').textContent = state.code;

  const mode = state.modes.find((m) => m.id === state.modeId);
  $('modeBadge').textContent = mode ? mode.name : '尚未選模式';
  $('modeBadge').style.display = state.modeId ? '' : 'none';

  // 房主才看得到「強制重來」與「自動下一場」(頂部常駐,隨時可勾)
  $('forceReset').style.display = state.you.isHost ? '' : 'none';
  $('autoNextWrap').style.display = state.you.isHost ? '' : 'none';
  const anCb = $('autoNext'); if (anCb) anCb.checked = autoNext;

  renderRoster();
  renderLobby();
  renderBanner();
  renderBoard();
  renderControls();
  renderPokerGuide();
  renderLoserBanner();
  maybeAutoNext();

  // 輪到我搖骰(各模式 rolling 階段、含紅黑單雙「搖下一骰」)→ 提示音(同話胚)
  const needRoll = iNeedToRoll();
  if (needRoll && !wasNeedRoll) playAlert();
  wasNeedRoll = needRoll;
  if (!needRoll) autoRolling = false; // 已不需搖骰 → 解除自動骰鎖
  if (needRoll && autoRoll) maybeAutoRoll();
}

// 目前是否「換我搖骰」(在進行中、非觀戰、rolling 階段且我還沒搖)
function iNeedToRoll() {
  const g = state.game;
  if (!g || state.status !== 'playing' || state.you.isSpectator) return false;
  if (g.mode === 'roll') return g.phase === 'rolling' && !(g.rolls && g.rolls[myId]);
  if (g.mode === 'liars' || g.mode === 'mixed') {
    return g.phase === 'rolling'
      && (g.order || []).includes(myId)
      && !(g.rolled || []).includes(myId);
  }
  return false;
}

// 自動骰:輪到我搖骰時,不用按、直接送出(每回合僅送一次)
function maybeAutoRoll() {
  if (!autoRoll || autoRolling || rollSpin.active || !iNeedToRoll()) return;
  autoRolling = true;
  playRattle(500); // 給點音效回饋
  emit('action', { type: 'roll' }).then((res) => {
    if (res && res.error) { autoRolling = false; toast(res.error); }
    // 成功 → 等 roomState 廣播,iNeedToRoll 變 false 時會自動解鎖
  });
}

// 本局輸家(話胚:reveal.loserId;紅黑單雙:reveal.losers)
function currentLosers() {
  const g = state.game;
  if (!g || !g.reveal) return [];
  if (g.reveal.subGame === 'poker' && g.reveal.loserId) return [g.reveal.loserId];
  if (g.reveal.subGame === 'redblack' && (g.reveal.losers || []).length) return g.reveal.losers;
  return [];
}

// 決出輸家 → 獨立大字公告 + 嘲諷音效(放上方,不蓋住房主的「再來一場」)
function renderLoserBanner() {
  const el = $('loserBanner');
  const losers = currentLosers();
  if (!losers.length) { el.style.display = 'none'; el.innerHTML = ''; lastLoserKey = ''; return; }
  const names = losers.map((id) => { const p = state.players.find((x) => x.id === id); return p ? esc(p.name) : '?'; }).join('、');
  el.style.display = '';
  // 紅黑單雙:額外寫出因為被拿掉哪一種而輸
  const rv = state.game && state.game.reveal;
  const reason = (rv && rv.subGame === 'redblack' && rv.conditionName)
    ? `<div class="loser-reason">因為被拿掉「${esc(rv.conditionName)}」而輸</div>`
    : '';
  el.innerHTML = `<div class="loser-title">💀 本局輸家 💀</div><div class="loser-name">${names}</div>${reason}`;
  const key = losers.slice().sort().join(',');
  if (key !== lastLoserKey) { lastLoserKey = key; playFanfare(); } // 剛決出 → 播一次
}

// 選了話胚 → 顯示牌型大小順序(一橫排,精簡)
const POKER_RANK_HTML = '🃏 牌型大小:<b>豹子</b> › 鐵支 › 順子 › 葫蘆 › 三條 › 兩對 › 一對 › 散牌';
function renderPokerGuide() {
  const el = $('pokerGuide');
  const show = !!(state.game && state.game.subGame === 'poker');
  el.style.display = show ? '' : 'none';
  if (show && !el.innerHTML) el.innerHTML = POKER_RANK_HTML;
}

function renderRoster() {
  const el = $('rosterBody');
  const playerRow = (p, extra = '', opts = {}) => {
    const isHost = p.id === state.hostId;
    const me = p.id === myId ? ' (你)' : '';
    const dot = p.connected ? 'on' : 'off';
    // 房主用皇冠取代綠點(不重複);其他玩家顯示連線狀態圓點
    const lead = isHost ? '<span class="crown">👑</span>' : `<span class="dot ${dot}"></span>`;
    const hostCtrl = state.you.isHost && p.id !== myId;
    const benchBtn = (hostCtrl && opts.bench)
      ? `<button class="bench" data-bench="${p.id}" title="丟入暫離觀戰區">💤</button>` : '';
    const actions = hostCtrl
      ? `<span class="row-actions">`
        + benchBtn
        + `<button class="mkhost" data-host="${p.id}" title="指定為房主">👑</button>`
        + `<button class="kick" data-kick="${p.id}" title="踢出房間">✕</button>`
        + `</span>`
      : '';
    return `<li>${lead}<span class="pname">${esc(p.name)}${me}</span>${extra}${actions}</li>`;
  };
  let html = `<h3>玩家 (${state.players.length})</h3><ul class="roster">`;
  // 玩家列表固定用加入順序(state.players 原始順序:房主先、之後依加入先後)
  html += state.players.map((p) => {
    const losses = (state.losses && state.losses[p.id]) || 0;
    const extra = ` <span class="muted">輸 ${losses} 次</span>`;
    return playerRow(p, extra, { bench: true });
  }).join('');
  html += '</ul>';
  if (state.spectators.length) {
    html += `<h3>觀戰中 (下一輪加入)</h3><ul class="roster">`;
    html += state.spectators.map((p) => playerRow(p)).join('');
    html += '</ul>';
  }
  if (state.away && state.away.length) {
    html += `<h3>💤 暫離觀戰 (按「我回來了」才回歸)</h3><ul class="roster">`;
    html += state.away.map((p) => playerRow(p)).join('');
    html += '</ul>';
  }
  el.innerHTML = html;

  // 房主:丟入暫離觀戰區
  el.querySelectorAll('[data-bench]').forEach((b) =>
    b.addEventListener('click', () => act('benchPlayer', { targetId: b.dataset.bench }))
  );
  // 房主:踢人按鈕
  el.querySelectorAll('[data-kick]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm('確定要將此玩家移出房間嗎?')) act('kickPlayer', { targetId: b.dataset.kick });
    })
  );
  // 房主:指定為房主
  el.querySelectorAll('[data-host]').forEach((b) =>
    b.addEventListener('click', () => {
      if (confirm('確定把房主轉移給此玩家嗎?')) act('transferHost', { targetId: b.dataset.host });
    })
  );
}

function renderLobby() {
  const el = $('lobby');
  const isHost = state.you.isHost;
  const inLobby = state.status === 'lobby';

  if (!inLobby) { el.style.display = 'none'; return; }
  el.style.display = '';

  if (!isHost) {
    el.innerHTML = `<p class="muted">等待房主 ${esc(hostName())} 選擇模式並開始…</p>`;
    return;
  }

  // 房主控制(只顯示開放的模式,未開放的隱藏)
  let html = '<div class="lobby-row"><span class="label">模式</span><div class="mode-btns">';
  for (const m of state.modes) {
    if (!m.available) continue;
    const active = m.id === state.modeId ? 'active' : '';
    html += `<button class="chip ${active}" data-mode="${m.id}">${esc(m.name)}</button>`;
  }
  html += '</div></div>';

  if (state.modeId === 'roll' || state.modeId === 'liars') {
    const label = state.modeId === 'liars' ? '每人起始骰子數' : '每人骰子數';
    html += `<div class="lobby-row"><span class="label">${label}</span>
      <input id="diceCount" type="number" min="1" max="100" value="${state.diceCount}" /></div>`;
  }
  if (state.modeId === 'mixed') {
    html += `<div class="lobby-row"><label class="auto-next">
      <input type="checkbox" id="loserDecides" ${state.loserDecides ? 'checked' : ''}/> 由輸家決定玩法</label>
      <label class="auto-next">
      <input type="checkbox" id="autoRotate" ${state.autoRotate ? 'checked' : ''}/> 自動順位(紅黑單雙)</label></div>`;
  }

  html += `<div class="lobby-row"><button id="shuffle" class="secondary">🔀 打亂玩家順序</button></div>`;

  const startLabel = startButtonLabel();
  html += `<div class="lobby-row"><button id="start" ${state.modeId ? '' : 'disabled'}>${startLabel}</button></div>`;
  el.innerHTML = html;

  el.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => act('setMode', { modeId: b.dataset.mode }))
  );
  const dc = $('diceCount');
  if (dc) dc.addEventListener('change', () => act('setDiceCount', { count: dc.value }));
  $('loserDecides')?.addEventListener('change', (e) => act('setLoserDecides', { on: e.target.checked }));
  $('autoRotate')?.addEventListener('change', (e) => act('setAutoRotate', { on: e.target.checked }));
  $('start')?.addEventListener('click', () => act('startRound', {}));
  $('shuffle')?.addEventListener('click', () => act('shufflePlayers', {}));
}

// 房主開啟「自動下一場」時:在大廳且已玩過一局 → 延遲後自動開下一場
// 每次進大廳只排程一次(autoNextArmed),失敗只提示、不取消勾選,避免洗版
function maybeAutoNext() {
  if (!state) return;
  if (state.status !== 'lobby') { // 離開大廳 → 重置,下次進大廳可再排程
    autoNextArmed = false;
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
    return;
  }
  const should = state.you.isHost && autoNext && state.modeId && state.game;
  if (!should) {
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
    return;
  }
  if (autoNextArmed || autoNextTimer) return; // 本次大廳已排程過
  autoNextArmed = true;
  autoNextTimer = setTimeout(async () => {
    autoNextTimer = null;
    if (!(state.you.isHost && autoNext && state.status === 'lobby' && state.game)) return;
    const res = await emit('startRound', {});
    if (res.error) toast('自動下一場:' + res.error); // 只提示,不關閉勾選
  }, 6000);
}

function startButtonLabel() {
  if (state.modeId === 'liars' || state.modeId === 'mixed') {
    if (state.matchOver) return '再來一場';
    if (state.game) return '下一輪';
    return '開始遊戲';
  }
  if (state.modeId === 'roll') return state.game ? '再搖一輪' : '開始搖骰';
  return '開始';
}

function renderBanner() {
  const el = $('banner');
  const g = state.game;
  const nm = (id) => { const p = state.players.find((x) => x.id === id); return p ? esc(p.name) : ''; };
  const show = (html) => { el.innerHTML = html; el.style.display = ''; };

  // 混合模式優先處理(階段提示 / 結算)
  if (g && g.mode === 'mixed') {
    if (state.status === 'playing' && g.phase === 'rolling') return show('🎲 搖出你的暗骰(只有你看得到)');
    if (state.status === 'playing' && g.phase === 'choosing') {
      if (g.decider && g.decider !== myId) return show(`⏳ 等待由 <span class="hl">${nm(g.decider)}</span> 決定玩法…`);
      return show(g.decider ? '👇 選擇這局玩法 — <strong>由你決定!</strong>' : '👇 選擇這局玩法 — <strong>任何人先按先決定!</strong>');
    }
    if (state.status === 'playing' && g.phase === 'bluffReady') return show('✊ 全員已搖完 — <strong>任何人可按「抓(開盅)」!</strong>');
    if (state.status === 'playing' && g.phase === 'condition') {
      if (g.openPick) return show('👇 要拿掉「紅 / 黑 / 單 / 雙 / 大 / 小」哪一種 — <strong>任何人先按先決定!</strong>');
      return show(g.chooserId === myId
        ? '👉 換你決定:要拿掉「紅 / 黑 / 單 / 雙 / 大 / 小」哪一種?'
        : `等待 <span class="hl">${nm(g.chooserId)}</span> 決定要拿掉哪一種…`);
    }
    if (g.reveal && !g.reveal.pending) {
      const r = g.reveal;
      if (r.subGame === 'bluff') {
        const s = r.stats || {};
        const parts = [1, 2, 3, 4, 5, 6].map((f) => `${f}=${s[f] || 0}`).join('　');
        return show(`✊ 開盅!各點數統計 — <strong>${parts}</strong> ・ 房主可按「再來一場」`);
      }
      if (r.subGame === 'poker') {
        if (r.loserId) {
          const how = r.loseBy === 'exhausted' ? '重骰用完' : '認輸';
          return show(`🏳️ <strong>${nm(r.loserId)}</strong> ${how},輸了! ・ 房主可按「再來一場」`);
        }
        const low = (r.lowestIds || []).map((id) => `<span class="hl">${nm(id)}</span>`).join('、');
        return show(`🃏 話胚開牌!牌型最小:${low} — 由他「重骰」或「認輸」`);
      }
      let msg = `<strong>${nm(g.chooserId)}</strong> 選「<strong>${esc(r.conditionName)}的拿掉</strong>」,開牌!`;
      if (r.losers && r.losers.length) msg += ` ・ 💀 ${r.losers.map(nm).join('、')} 失去所有骰子,輸了!`;
      else if (state.winnerId) msg += ` ・ 🏆 ${nm(state.winnerId)} 獲勝!`;
      else if (g.phase === 'reveal') msg += ' ・ 按「搖下一骰」繼續';
      return show(msg);
    }
    if (g.reveal && g.reveal.pending) return show('規則建置中…');
  }

  if (state.winnerId) {
    const w = state.players.find((p) => p.id === state.winnerId);
    el.innerHTML = `🏆 <strong>${esc(w ? w.name : '')}</strong> 獲勝!`;
    el.style.display = '';
    return;
  }
  if (g && g.mode === 'liars') {
    if (state.status === 'playing' && g.phase === 'rolling') {
      const done = (g.rolled || []).length;
      const total = (g.order || []).length;
      if (total > 0 && done === total) return show('✊ 全員已搖完 — 任何人可按「抓(開盅)」!');
      return show(`🎲 各自搖骰中(<strong>${done}/${total}</strong> 已搖完),全員搖完才能抓`);
    }
    if (g.reveal) {
      const s = g.reveal.stats || {};
      const parts = [1, 2, 3, 4, 5, 6].map((f) => `${f}=${s[f] || 0}`).join('　');
      return show(`✊ 開盅!各點數統計 — <strong>${parts}</strong>`);
    }
  }
  el.style.display = 'none';
  el.innerHTML = '';
}

function renderBoard() {
  const board = $('board');
  const g = state.game;
  if (!g) { board.innerHTML = '<p class="muted center-pad">選擇模式後開始遊戲 🎲</p>'; return; }

  // 按住搖骰:放開後結果已回 → 停止轉動,讓正常渲染收尾(滾到最終點數)
  if (rollSpin.committing && myRollRegistered()) stopRollSpin();

  // 話胚:初次一次開全部牌 → 靜態(不轉動);之後(重骰)點數變動才滾動
  const pokerReveal = !!(g.reveal && g.reveal.subGame === 'poker');
  const pokerInitial = pokerReveal && !pokerStaticDone;
  // 我是否為可重骰者(最小者)→ 可鎖定自己的骰子
  const iCanReroll = pokerReveal && g.phase === 'pokerCompare'
    && (g.reveal.lowestIds || []).includes(myId);
  // 剛輪到我(成為最小者)→ 播提示音
  if (iCanReroll && !wasLowest) playAlert();
  wasLowest = iCanReroll;
  // 本次 render 是否有「新的重骰」要播放動畫(由 server 帶來:誰、重骰了哪些索引)
  const lastRoll = pokerReveal ? g.reveal.lastRoll : null;
  const isNewRoll = !!(lastRoll && lastRoll.seq !== lastRollSeq);

  // 確保每位玩家一個 cell(保留 dice DOM 以利動畫);自己排第一個
  let ordered = orderedPlayers();
  // 吹牛骰「抓(開盅)」之前:完全只顯示自己,其他人不呈現
  const soloView = g.mode === 'liars' && !g.reveal;
  if (soloView) ordered = ordered.filter((p) => p.id === myId);
  board.classList.toggle('solo', soloView); // 單人視圖時格子撐滿寬度

  // 正在等待哪位玩家做決定(選玩法 / 紅黑單雙選條件)→ 在其格子加外框
  let decidingId = null;
  if (g.mode === 'mixed' && state.status === 'playing') {
    if (g.phase === 'choosing' && g.decider) decidingId = g.decider;
    else if (g.phase === 'condition' && !g.openPick && g.chooserId) decidingId = g.chooserId;
  }

  const wanted = ordered.map((p) => p.id);
  // 移除多餘 cell
  [...board.children].forEach((c) => { if (!wanted.includes(c.dataset.pid)) { board.removeChild(c); diceCache.delete('cell-' + c.dataset.pid); } });

  let idx = 0;
  for (const p of ordered) {
    let cell = board.querySelector(`[data-pid="${p.id}"]`);
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.dataset.pid = p.id;
      cell.innerHTML = `<div class="cell-name"></div><div class="dice-stage"></div><div class="cell-info muted"></div>`;
    }
    // 只在位置不對時才搬移:重新插入 DOM 會打斷進行中的 CSS 動畫,
    // 故避免每次 render 都搬動(否則別人重骰的滾動會被後續 render 截斷)
    if (board.children[idx] !== cell) board.insertBefore(cell, board.children[idx] || null);
    idx++;
    cell.classList.toggle('mine', p.id === myId); // 自己的格子用不同底色標示
    cell.querySelector('.cell-name').innerHTML =
      (p.id === state.hostId ? '👑 ' : '') + esc(p.name) + (p.id === myId ? ' (你)' : '');
    const stage = cell.querySelector('.dice-stage');
    const info = cell.querySelector('.cell-info');

    // 按住搖骰轉動中:保留我的轉動畫面,不被一般渲染覆蓋
    if (rollSpin.active && p.id === myId) continue;

    // 話胚:牌型最小者加外框
    const lowPoker = g.mode === 'mixed' && g.reveal && g.reveal.subGame === 'poker'
      && (g.reveal.lowestIds || []).includes(p.id);
    cell.classList.toggle('lowest', !!lowPoker);
    cell.classList.toggle('deciding', p.id === decidingId); // 正在等他決定 → 外框

    if (g.mode === 'roll') {
      const dice = g.rolls[p.id];
      if (dice) {
        showDice(stage, 'cell-' + p.id, dice);
        const sum = dice.reduce((a, b) => a + b, 0);
        info.textContent = `總和 ${sum}`;
      } else {
        stage.innerHTML = '<div class="waiting">尚未搖骰</div>';
        info.textContent = '';
        diceCache.delete('cell-' + p.id);
      }
    } else if (g.mode === 'liars') {
      const reveal = g.reveal;
      if (reveal) {
        if (reveal.hands[p.id]) {
          showDice(stage, 'cell-' + p.id, reveal.hands[p.id], false, true); // 開盅:靜態亮點數(無動畫)
        } else {
          stage.innerHTML = '<div class="waiting">未搖骰</div>';
          diceCache.delete('cell-' + p.id);
        }
      } else if (g.myDice && g.myDice.length) {
        showDice(stage, 'cell-' + p.id, g.myDice);           // 抓之前:只顯示自己的
      } else {
        stage.innerHTML = '<div class="waiting">尚未搖骰</div>';
        diceCache.delete('cell-' + p.id);
      }
      info.textContent = '';
    } else if (g.mode === 'mixed') {
      const reveal = g.reveal;
      if (reveal && reveal.hands[p.id]) {
        const key = 'cell-' + p.id;
        const hand = reveal.hands[p.id];
        if (reveal.subGame === 'poker' && !pokerInitial && isNewRoll && lastRoll.id === p.id) {
          // 這手剛重骰:強制滾動「沒被鎖定」的骰子(即使新點數和原本相同也要轉)
          showDice(stage, key, hand, false, false, lastRoll.idx);
        } else {
          // 紅黑/吹牛開牌靜態;話胚初次開全部牌靜態;其餘維持(沒變則 no-op)
          const staticShow = (reveal.subGame !== 'poker') || pokerInitial;
          showDice(stage, key, hand, false, staticShow);
        }
        markRemovedDice(stage, hand, reveal.condition);     // 要被拿掉的畫叉叉
        // 話胚:鎖定顯示給所有人看;只有「輪到我」時我的骰子可點選切換
        if (reveal.subGame === 'poker') {
          const interactive = p.id === myId && iCanReroll;
          const locks = (reveal.lockBy === p.id) ? (reveal.locked || []) : [];
          applyLockUI(stage, locks, interactive);
        }
      } else if (p.id === myId && g.myDice && g.myDice.length) {
        showDice(stage, 'cell-' + p.id, g.myDice);           // 自己的暗骰(2 顆以上才看得到)
      } else if (g.phase === 'rolling' && !(g.rolled || []).includes(p.id)) {
        stage.innerHTML = '<div class="waiting">尚未搖骰</div>';
        diceCache.delete('cell-' + p.id);
      } else {
        const n = g.diceLeft ? (g.diceLeft[p.id] ?? 0) : 0;
        showDice(stage, 'cell-' + p.id, Array(n).fill(0), true); // 他人(或盲骰者自己)蓋著的骰盅
      }
      // 話胚:顯示牌型名稱(最小者標記);紅黑:顯示被拿掉幾顆;盲骰者提示
      if (reveal && reveal.subGame === 'poker' && reveal.ranks) {
        info.textContent = (reveal.ranks[p.id] || '') + (lowPoker ? ' ⚠️ 最小' : '');
      } else if (reveal && reveal.removed && reveal.removed[p.id] != null) {
        const rm = reveal.removed[p.id];
        info.textContent = rm > 0 ? `拿掉 ${rm} 顆` : '保留';
      } else if (p.id === myId && g.blind) {
        info.textContent = '🙈 盲骰(看不到自己)';
      } else {
        info.textContent = '';
      }
    }
  }

  // 初次靜態開牌完成後,後續話胚點數變動(重骰)就改用滾動;離開話胚則重置
  pokerStaticDone = pokerReveal;
  if (isNewRoll) lastRollSeq = lastRoll.seq; // 標記本次重骰動畫已播放
}

function renderControls() {
  const el = $('controls');
  const g = state.game;
  if (state.you.isAway) {
    el.style.display = '';
    el.innerHTML = '<p class="muted">💤 你被移到暫離觀戰區</p>'
      + '<button id="imback">🙋 我回來了</button>';
    $('imback')?.addEventListener('click', () => act('imBack', {}));
    return;
  }
  if (state.you.isSpectator) {
    el.style.display = '';
    el.innerHTML = '<p class="muted">👀 觀戰中,下一輪開始時自動加入</p>';
    return;
  }
  // 非進行中(大廳/回合結束)→ 收起動作面板,交給大廳控制
  if (!g || state.status !== 'playing') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = '';

  if (g.mode === 'roll' && state.status === 'playing') {
    const rolled = g.rolls[myId];
    el.innerHTML = rolled
      ? '<p class="muted">已搖骰,等待其他玩家…</p>'
      : '<button id="roll">🎲 搖骰!</button>';
    return; // 搖骰改由「按住→放開」處理(見 pressRoll/releaseRoll)
  }

  if (g.mode === 'liars' && state.status === 'playing' && g.phase === 'rolling') {
    const rolled = (g.rolled || []).includes(myId);
    const allRolled = (g.order || []).length > 0 && (g.rolled || []).length === g.order.length;
    el.innerHTML = '<div class="bid-row">'
      + (rolled
        ? `<span class="muted">${allRolled ? '全員已搖完' : '已搖骰,等待其他人…'}</span>`
        : '<button id="roll">🎲 搖骰!</button>')
      + (allRolled ? '<button id="grab" class="secondary">✊ 抓(開盅)!</button>' : '')
      + '</div>';
    $('grab')?.addEventListener('click', () => act('action', { type: 'grab' }));
    return;
  }

  if (g.mode === 'mixed' && state.status === 'playing') {
    if (g.phase === 'rolling' || g.phase === 'reveal') {
      const rolled = g.phase === 'rolling' && (g.rolled || []).includes(myId);
      const label = g.phase === 'reveal' ? '🎲 搖下一骰!' : '🎲 搖骰!';
      el.innerHTML = rolled
        ? '<p class="muted">已搖骰,等待其他人…</p>'
        : `<button id="roll">${label}</button>`;
      return; // 搖骰改由「按住→放開」處理
    }
    if (g.phase === 'pokerCompare') {
      const low = (g.reveal && g.reveal.lowestIds) || [];
      if (low.includes(myId)) {
        const left = (g.reveal.rerolls && g.reveal.rerolls[myId]) || 0;
        const lockPaid = !!(g.reveal.lockUsed && g.reveal.lockUsed[myId]); // 本段已用過鎖定
        const hasLock = (g.reveal.locked || []).length > 0;
        // 第一次用鎖定扣 2,之後鎖定也只扣 1
        const cost = (hasLock && !lockPaid) ? 2 : 1;
        const canAfford = left >= cost;
        const costNote = cost > 1 ? `,本次扣 ${cost}` : '';
        el.innerHTML = '<div class="bid-row">'
          + `<button id="reroll"${canAfford ? '' : ' disabled'}>🎲 重骰 (剩 ${left}${costNote})</button>`
          + '<button id="concede" class="secondary">🏳️ 認輸</button>'
          + '</div>';
        $('reroll')?.addEventListener('click', () => {
          if (left < cost) { toast(`重骰次數不足(本次需 ${cost} 次,剩 ${left})`); return; }
          act('action', { type: 'reroll' });
        });
        $('concede')?.addEventListener('click', () => act('action', { type: 'concede' }));
      } else {
        const names = low.map((id) => { const p = state.players.find((x) => x.id === id); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; }).join('、');
        el.innerHTML = `<p class="muted">等待 ${names} 重骰或認輸…</p>`;
      }
      return;
    }
    if (g.phase === 'bluffReady') {
      const allRolled = (g.order || []).length > 0 && (g.rolled || []).length === g.order.length;
      el.innerHTML = '<div class="bid-row"><span class="muted">全員已搖完</span>'
        + (allRolled ? '<button id="grab" class="secondary">✊ 抓(開盅)!</button>' : '')
        + '</div>';
      $('grab')?.addEventListener('click', () => act('action', { type: 'grab' }));
      return;
    }
    if (g.phase === 'choosing') {
      // 由輸家決定:不是指定的人 → 只顯示等待
      if (g.decider && g.decider !== myId) {
        const d = state.players.find((p) => p.id === g.decider);
        el.innerHTML = `<p class="muted">正在等待由 <span class="hl">${esc(d ? d.name : '')}</span> 決定玩法…</p>`;
        return;
      }
      const hint = g.decider ? '(由你決定)' : '(任何人先按先決定)';
      el.innerHTML = `<p class="muted">選擇這局玩法${hint}:</p>`
        + `<div class="mode-btns">`
        + (g.subGames || []).map((s) => `<button class="chip" data-sub="${s.id}">${esc(s.name)}</button>`).join('')
        + `</div>`;
      el.querySelectorAll('[data-sub]').forEach((b) =>
        b.addEventListener('click', () => act('action', { type: 'chooseSubGame', subGame: b.dataset.sub }))
      );
      return;
    }
    if (g.phase === 'condition') {
      const canPick = g.openPick || g.chooserId === myId;
      if (canPick) {
        const hint = g.openPick ? '要拿掉哪一種?(任何人先按先決定,紅=1與4、大=4~6)' : '你決定!要拿掉哪一種?(紅=1與4、大=4~6)';
        const opts = [['red', '紅的拿掉'], ['black', '黑的拿掉'], ['odd', '單數拿掉'], ['even', '雙數拿掉'], ['big', '大的拿掉'], ['small', '小的拿掉']];
        el.innerHTML = `<p class="muted">${hint}</p><div class="mode-btns">`
          + opts.map(([id, label]) => `<button class="chip" data-cond="${id}">${label}</button>`).join('')
          + `</div>`;
        el.querySelectorAll('[data-cond]').forEach((b) =>
          b.addEventListener('click', () => act('action', { type: 'chooseCondition', condition: b.dataset.cond }))
        );
      } else {
        const ch = state.players.find((p) => p.id === g.chooserId);
        el.innerHTML = `<p class="muted">等待 <span class="hl">${esc(ch ? ch.name : '')}</span> 決定要拿掉哪一種…</p>`;
      }
      return;
    }
  }

  el.innerHTML = '<p class="muted">等待中…</p>';
}

// ---- helpers ----
function hostName() {
  const h = state.players.find((p) => p.id === state.hostId);
  return h ? h.name : '';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- 按住搖骰:按住時骰子一直轉,放開才送出搖骰並停在結果 ----
const rollSpin = { active: false, committing: false, timer: null };
function rollDiceCount() {
  const g = state && state.game; if (!g) return 0;
  if (g.mode === 'roll') return g.diceCount || 3;
  return (g.diceLeft && g.diceLeft[myId]) || 0;
}
function myRollRegistered() {
  const g = state && state.game; if (!g) return true;
  if (g.mode === 'roll') return !!(g.rolls && g.rolls[myId]);
  return (g.rolled || []).includes(myId);
}
function canRollNow() {
  const btn = document.getElementById('roll'); // 各模式的搖骰/搖下一骰按鈕
  return !!(btn && !btn.disabled);
}
function pressRoll() {
  if (rollSpin.active || !canRollNow()) return;
  rollSpin.active = true; rollSpin.committing = false;
  const cell = document.querySelector(`#board [data-pid="${myId}"]`);
  const stage = cell && cell.querySelector('.dice-stage');
  const count = rollDiceCount();
  if (!stage || !count) return; // 找不到也沒關係,放開時仍會送出
  const spin = () => {
    const vals = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
    showDice(stage, 'cell-' + myId, vals); // 連續滾隨機點數
    playRattle(400); // 喀啦喀啦(按住期間每個 tick 補一段,持續播放)
  };
  spin();
  rollSpin.timer = setInterval(spin, 360);
}
function releaseRoll() {
  if (!rollSpin.active || rollSpin.committing) return;
  rollSpin.committing = true;
  if (!canRollNow()) { stopRollSpin(); return; }
  emit('action', { type: 'roll' }).then((res) => {
    if (res && res.error) { toast(res.error); stopRollSpin(); render(); }
    // 成功 → 等 roomState 廣播,在 renderBoard 收尾停住
  });
}
function stopRollSpin() {
  if (rollSpin.timer) { clearInterval(rollSpin.timer); rollSpin.timer = null; }
  rollSpin.active = false; rollSpin.committing = false;
}

// 滑鼠/觸控按住搖骰鈕
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('#roll')) { e.preventDefault(); pressRoll(); }
});
document.addEventListener('pointerup', () => releaseRoll());
document.addEventListener('pointercancel', () => releaseRoll());
window.addEventListener('blur', () => releaseRoll());

// 空白鍵按住搖骰(打字中不觸發)
const isSpace = (e) => e.code === 'Space' || e.key === ' ';
document.addEventListener('keydown', (e) => {
  if (e.repeat || !isSpace(e)) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (!canRollNow()) return;
  e.preventDefault();
  pressRoll();
});
document.addEventListener('keyup', (e) => { if (isSpace(e)) releaseRoll(); });

// ---- 頂部按鈕 ----
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(code); toast('已複製房號 ' + code); }
  catch { toast('房號:' + code); }
});
$('leave').addEventListener('click', async () => {
  await emit('leaveRoom', {});
  clearSession();
  location.href = '/';
});
$('forceReset').addEventListener('click', () => {
  if (confirm('確定強制重來?目前這場將中止,回到大廳重新開始。')) act('forceReset', {});
});
// 自動下一場(頂部常駐,房主隨時可切換)
$('autoNext').addEventListener('change', (e) => {
  autoNext = e.target.checked;
  localStorage.setItem('dice.autoNext', autoNext ? '1' : '0');
  autoNextArmed = false; // 重新切換 → 允許本次大廳重新排程
  maybeAutoNext();
});

// 懸浮玩家列表:收起 / 展開(記住偏好)
function setRosterCollapsed(v) {
  localStorage.setItem('dice.rosterCollapsed', v ? '1' : '0');
  $('roster').classList.toggle('collapsed', v);
  $('rosterOpen').style.display = v ? '' : 'none';
}
$('rosterCollapse').addEventListener('click', () => setRosterCollapsed(true));
$('rosterOpen').addEventListener('click', () => setRosterCollapsed(false));
setRosterCollapsed(localStorage.getItem('dice.rosterCollapsed') === '1');

// 音效靜音切換(每位玩家各自控制,記在 localStorage)
function setMuted(v) {
  window.__cupMuted = v;
  localStorage.setItem('dice.muted', v ? '1' : '0');
  const b = $('muteToggle');
  b.textContent = v ? '🔇' : '🔊';
  b.title = v ? '音效已關(點擊開啟)' : '音效開啟(點擊靜音)';
}
$('muteToggle').addEventListener('click', () => setMuted(!window.__cupMuted));
setMuted(localStorage.getItem('dice.muted') === '1');

// 自動骰:勾選後搖骰環節自動送出
$('autoRoll').checked = autoRoll;
$('autoRoll').addEventListener('change', (e) => {
  autoRoll = e.target.checked;
  localStorage.setItem('dice.autoRoll', autoRoll ? '1' : '0');
  if (autoRoll) maybeAutoRoll(); // 若此刻正好輪到我搖,立即骰
});

