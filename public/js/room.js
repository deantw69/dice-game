// 房間 UI 與 socket 事件繫結
import { socket, emit, loadSession, clearSession } from './net.js';
import { createRenderer as createDice } from './dice/diceCss3d.js';

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

// 顯示骰子(快取 renderer)。staticShow=true 時直接亮點數(無翻滾動畫,用於開牌)
function showDice(container, key, values, hidden = false, staticShow = false) {
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
  const sig = (staticShow ? 's:' : 'a:') + values.join(',');
  if (entry.last !== sig) {
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

// 把「自己」排到第一個(其餘維持原順序),讓每個人在自己畫面上都排第一
function orderedPlayers() {
  const mine = state.players.filter((p) => p.id === myId);
  const others = state.players.filter((p) => p.id !== myId);
  return [...mine, ...others];
}

// ---- 主 render ----
function render() {
  if (!state) return;
  $('rcode').textContent = state.code;

  const mode = state.modes.find((m) => m.id === state.modeId);
  $('modeBadge').textContent = mode ? mode.name : '尚未選模式';
  $('modeBadge').style.display = state.modeId ? '' : 'none';

  // 房主才看得到「強制重來」
  $('forceReset').style.display = state.you.isHost ? '' : 'none';

  renderRoster();
  renderLobby();
  renderBanner();
  renderBoard();
  renderControls();
}

function renderRoster() {
  const el = $('roster');
  const playerRow = (p, extra = '') => {
    const crown = p.id === state.hostId ? '👑 ' : '';
    const me = p.id === myId ? ' (你)' : '';
    const dot = p.connected ? 'on' : 'off';
    const actions = (state.you.isHost && p.id !== myId)
      ? `<span class="row-actions">`
        + `<button class="mkhost" data-host="${p.id}" title="指定為房主">👑</button>`
        + `<button class="kick" data-kick="${p.id}" title="踢出房間">✕</button>`
        + `</span>`
      : '';
    return `<li><span class="dot ${dot}"></span><span class="pname">${crown}${esc(p.name)}${me}</span>${extra}${actions}</li>`;
  };
  let html = `<h3>玩家 (${state.players.length})</h3><ul class="roster">`;
  html += orderedPlayers().map((p) => {
    let extra = '';
    if (state.game && (state.game.mode === 'liars' || state.game.mode === 'mixed') && state.game.diceLeft) {
      const n = state.game.diceLeft[p.id] ?? 0;
      extra = n > 0 ? ` <span class="muted">🎲×${n}</span>` : ' <span class="muted">出局</span>';
    }
    return playerRow(p, extra);
  }).join('');
  html += '</ul>';
  if (state.spectators.length) {
    html += `<h3>觀戰中 (下一輪加入)</h3><ul class="roster">`;
    html += state.spectators.map((p) => playerRow(p)).join('');
    html += '</ul>';
  }
  el.innerHTML = html;

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

  if (state.modeId === 'roll') {
    html += `<div class="lobby-row"><span class="label">每人骰子數</span>
      <input id="diceCount" type="number" min="1" max="5" value="${state.diceCount}" /></div>`;
  }

  const startLabel = startButtonLabel();
  html += `<div class="lobby-row"><button id="start" ${state.modeId ? '' : 'disabled'}>${startLabel}</button></div>`;
  el.innerHTML = html;

  el.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => act('setMode', { modeId: b.dataset.mode }))
  );
  const dc = $('diceCount');
  if (dc) dc.addEventListener('change', () => act('setDiceCount', { count: dc.value }));
  $('start')?.addEventListener('click', () => act('startRound', {}));
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
    if (state.status === 'playing' && g.phase === 'choosing') return show('👇 選擇這局玩法 — <strong>任何人先按先決定!</strong>');
    if (state.status === 'playing' && g.phase === 'condition') {
      if (g.openPick) return show('👇 要拿掉「紅 / 黑 / 單 / 雙」哪一種 — <strong>任何人先按先決定!</strong>');
      return show(g.chooserId === myId
        ? '👉 換你決定:要拿掉「紅 / 黑 / 單 / 雙」哪一種?'
        : `等待 <strong>${nm(g.chooserId)}</strong> 決定要拿掉哪一種…`);
    }
    if (g.reveal && !g.reveal.pending) {
      const r = g.reveal;
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
  if (g && g.mode === 'liars' && state.status === 'playing') {
    if (g.currentPlayerId) {
      const cur = state.players.find((p) => p.id === g.currentPlayerId);
      const mine = g.currentPlayerId === myId;
      el.innerHTML = mine ? '👉 輪到你了!' : `輪到 <strong>${esc(cur ? cur.name : '')}</strong>`;
      el.style.display = '';
      return;
    }
  }
  if (g && g.mode === 'liars' && g.reveal) {
    const r = g.reveal;
    el.innerHTML = `開盅!喊「${r.bid.quantity} 個 ${r.bid.face}」,實際 <strong>${r.actual}</strong> 個 ・ `
      + `${esc(r.loserName)} 失去 1 顆${r.eliminated ? '(出局)' : ''}`;
    el.style.display = '';
    return;
  }
  el.style.display = 'none';
  el.innerHTML = '';
}

function renderBoard() {
  const board = $('board');
  const g = state.game;
  if (!g) { board.innerHTML = '<p class="muted center-pad">選擇模式後開始遊戲 🎲</p>'; return; }

  // 確保每位玩家一個 cell(保留 dice DOM 以利動畫);自己排第一個
  const ordered = orderedPlayers();
  const wanted = ordered.map((p) => p.id);
  // 移除多餘 cell
  [...board.children].forEach((c) => { if (!wanted.includes(c.dataset.pid)) { board.removeChild(c); diceCache.delete('cell-' + c.dataset.pid); } });

  for (const p of ordered) {
    let cell = board.querySelector(`[data-pid="${p.id}"]`);
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.dataset.pid = p.id;
      cell.innerHTML = `<div class="cell-name"></div><div class="dice-stage"></div><div class="cell-info muted"></div>`;
    }
    board.appendChild(cell); // 依序 append(會把既有節點移到正確順序)
    cell.querySelector('.cell-name').innerHTML =
      (p.id === state.hostId ? '👑 ' : '') + esc(p.name) + (p.id === myId ? ' (你)' : '');
    const stage = cell.querySelector('.dice-stage');
    const info = cell.querySelector('.cell-info');

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
      if (reveal && reveal.hands[p.id]) {
        showDice(stage, 'cell-' + p.id, reveal.hands[p.id]); // 開盅公開
      } else if (p.id === myId && g.myDice && g.myDice.length) {
        showDice(stage, 'cell-' + p.id, g.myDice);           // 自己的暗骰
      } else {
        const n = g.diceLeft ? (g.diceLeft[p.id] ?? 0) : 0;
        showDice(stage, 'cell-' + p.id, Array(n).fill(0), true); // 他人蓋著的骰盅
      }
      info.textContent = '';
    } else if (g.mode === 'mixed') {
      const reveal = g.reveal;
      if (reveal && reveal.hands[p.id]) {
        showDice(stage, 'cell-' + p.id, reveal.hands[p.id], false, true); // 開牌:靜態亮點數(無動畫)
        markRemovedDice(stage, reveal.hands[p.id], reveal.condition);     // 要被拿掉的畫叉叉
      } else if (p.id === myId && g.myDice && g.myDice.length) {
        showDice(stage, 'cell-' + p.id, g.myDice);           // 自己的暗骰(2 顆以上才看得到)
      } else if (g.phase === 'rolling' && !(g.rolled || []).includes(p.id)) {
        stage.innerHTML = '<div class="waiting">尚未搖骰</div>';
        diceCache.delete('cell-' + p.id);
      } else {
        const n = g.diceLeft ? (g.diceLeft[p.id] ?? 0) : 0;
        showDice(stage, 'cell-' + p.id, Array(n).fill(0), true); // 他人(或盲骰者自己)蓋著的骰盅
      }
      // 結算顯示被拿掉幾顆;盲骰者(只剩 1 顆)提示
      if (reveal && reveal.removed && reveal.removed[p.id] != null) {
        const rm = reveal.removed[p.id];
        info.textContent = rm > 0 ? `拿掉 ${rm} 顆` : '保留';
      } else if (p.id === myId && g.blind) {
        info.textContent = '🙈 盲骰(看不到自己)';
      } else {
        info.textContent = '';
      }
    }
  }
}

function renderControls() {
  const el = $('controls');
  const g = state.game;
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
    $('roll')?.addEventListener('click', () => act('action', { type: 'roll' }));
    return;
  }

  if (g.mode === 'liars' && state.status === 'playing' && g.currentPlayerId === myId) {
    const bid = g.currentBid;
    const minQ = bid ? bid.quantity : 1;
    el.innerHTML = `
      <div class="bid-row">
        <label class="field">數量 <input id="bidQ" type="number" min="${minQ}" value="${minQ}" /></label>
        <label class="field">點數
          <select id="bidF">${[1,2,3,4,5,6].map((f) => `<option value="${f}">${f}</option>`).join('')}</select>
        </label>
        <button id="bid">喊牌</button>
        ${bid ? '<button id="challenge" class="secondary">開盅質疑!</button>' : ''}
      </div>
      ${bid ? `<p class="muted">目前喊牌:${bid.quantity} 個 ${bid.face}</p>` : '<p class="muted">你先喊(任意數量/點數)</p>'}`;
    $('bid')?.addEventListener('click', () =>
      act('action', { type: 'bid', quantity: $('bidQ').value, face: $('bidF').value })
    );
    $('challenge')?.addEventListener('click', () => act('action', { type: 'challenge' }));
    return;
  }

  if (g.mode === 'mixed' && state.status === 'playing') {
    if (g.phase === 'rolling' || g.phase === 'reveal') {
      const rolled = g.phase === 'rolling' && (g.rolled || []).includes(myId);
      const label = g.phase === 'reveal' ? '🎲 搖下一骰!' : '🎲 搖骰!';
      el.innerHTML = rolled
        ? '<p class="muted">已搖骰,等待其他人…</p>'
        : `<button id="roll">${label}</button>`;
      $('roll')?.addEventListener('click', () => act('action', { type: 'roll' }));
      return;
    }
    if (g.phase === 'choosing') {
      el.innerHTML = `<p class="muted">選擇這局玩法(任何人先按先決定):</p>`
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
        el.innerHTML = `<p class="muted">等待 ${esc(ch ? ch.name : '')} 決定要拿掉哪一種…</p>`;
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
