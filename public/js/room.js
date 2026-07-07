// 房間 UI 與 socket 事件繫結
import { socket, emit, loadSession, clearSession } from './net.js';
import { createRenderer as createDice } from './dice/diceCss3d.js';
import { createRenderer as createCup } from './dice/diceCup.js';
import { playAlert, playFanfare, playRattle, playVictory, playExplosion, playCountdownTick, playIronFour, playLeopard, playInstantKill } from './dice/cupSound.js';
import { makeQrMatrix } from './vendor/qrcode.js';

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
const cupCache = new Map();  // 吹牛骰「抓」之前自己骰子用的骰盅渲染器 cellKey -> { renderer, el, count, revealedSig }
const rollSettled = {};      // 純搖骰:pid -> 已落定(動畫結束)的點數簽章,落定後才顯示總和
const rollPending = {};      // 純搖骰:pid -> 已排定延遲顯示的點數簽章(避免重複排程)
const lossSettled = {};      // pid -> 已落定的輸次數(骰子動畫結束後才顯示新值)
const lossPending = {};      // pid -> 待落定的輸次數簽章(避免重複排程)
let pokerStaticDone = false; // 話胚:初次「一次開全部牌」用靜態,之後重骰點數變動才滾動
let lastRollSeq = 0;          // 話胚:已處理的重骰序號(用來觸發「該次重骰」的滾動動畫)
let pokerRerollAnim = false;  // 話胚:重骰動畫進行中 → 延後「最小者切換/控制/橫幅」等結果
let prevStatus = null;        // 上次 render 時的 status(用來偵測 playing→lobby 轉換)
let roundEndAnim = false;     // 回合結束動畫進行中 → 延後顯示大廳順序按鈕等結果 UI
let roundEndTimer = null;
let pokerRerollTimer = null;
let wasLowest = false;        // 話胚:上次 render 時我是否為最小者(用來在「剛輪到我」時播提示音)
let wasNeedRoll = false;      // 上次 render 時我是否需要搖骰(用來在「剛輪到我搖骰」時播提示音)
let prevSpeedPhase = null;    // 手速骰:上次 render 的 phase(用來偵測 countdown→racing 揭題播音)
let speedClockTimer = null;   // 手速骰:本地倒數/計時 interval
let speedLastCountN = null;   // 手速骰:上次倒數播音的數字(避免同秒重複播)
let speedSkew = 0;            // 手速骰:client 與 server 的時鐘偏移(Date.now() - serverNow)
let speedLastMyRolls = 0;     // 手速骰:上次 render 時自己的搖骰次數(用來在「我剛搖完」時播骰子動畫)
let speedLastRolls = {};      // 手速骰:上次 render 時各「他人」的搖骰次數(用來在他人剛搖完時播骰子動畫)
let speedRollReadyAt = 0;     // 手速骰:下次可擲骰的時間(連續擲骰冷卻 1.5 秒,前端同步顯示)
let speedCooldownTimer = null;// 手速骰:冷卻倒數的 re-render 計時器
let speedRolling = false;     // 手速骰:骰子動畫是否進行中(延遲達標顯示)
let speedRollingTimer = null; // 手速骰:動畫結束計時器
let lastLoserKey = '';        // 上次顯示的輸家(用來在「剛決出輸家」時播一次嘲諷音效)
let loserDismissedKey = '';   // 已被使用者點掉的輸家 popup(同一場不再顯示)
let lastStatsKey = '';        // 吹牛開盅各點數統計 popup 的內容簽章
let statsDismissedKey = '';   // 已被點掉的統計 popup(同一次開盅不再顯示)
let autoNext = localStorage.getItem('dice.autoNext') === '1'; // 房主:自動下一場
let autoNextTimer = null;     // 自動下一場的延遲計時器
let autoNextArmed = false;    // 本次進大廳是否已排程過(避免重複/洗版)
let autoRoll = localStorage.getItem('dice.autoRoll') === '1'; // 玩家:搖骰環節自動骰
let autoRolling = false;      // 防止自動骰重複送出
let lastWinnerKey = '';       // 上次顯示的最終勝利者
let winnerDismissedKey = '';  // 已被點掉的勝利者 popup
let winnerTimer = null;       // 勝利者 popup 延遲顯示計時器
let lastMilestoneKey = '';    // 嘲諷里程碑 popup 簽章
let milestoneDismissed = '';  // 已被點掉的里程碑
let milestoneTimer = null;    // 里程碑延遲顯示計時器
let lobbyExpanded = false;    // 房主:一局結束後 lobby 預設精簡(只剩「再來一場/換模式」),按「換模式」才展開
let lastHandFxKey = '';       // 話胚:上次播放的鐵支/豹子特效簽章(避免重複播放)

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

// ---- 斷線提示橫幅:斷線時固定於頁面上方顯示,重連成功即隱藏 ----
let netBanner = null;
function setNetBanner(show) {
  if (!netBanner) {
    netBanner = document.createElement('div');
    netBanner.id = 'netBanner';
    netBanner.className = 'net-banner';
    netBanner.textContent = '⚠️ 連線中斷,重連中…';
    netBanner.style.display = 'none';
    document.body.appendChild(netBanner);
  }
  netBanner.style.display = show ? '' : 'none';
}
socket.on('disconnect', () => setNetBanner(true));
socket.on('connect', () => setNetBanner(false));
let modes = [];
socket.on('modes', (m) => { modes = m; });
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}
socket.on('roomState', (s) => { state = s; state.modes = modes; scheduleRender(); });

// 被房主踢出
socket.on('kicked', async () => {
  clearSession();
  await uiAlert('你已被房主移出房間');
  location.href = '/';
});

// ---- 自訂確認/提示框(取代原生 confirm/alert,沿用深色卡片風格) ----
// uiConfirm(msg) → Promise<boolean>;uiAlert(msg) → Promise<void>;點遮罩或 Esc 視同取消
function uiDialog(msg, { showCancel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay._close = close; // Esc 關閉用(視同取消)
    const box = document.createElement('div');
    box.className = 'confirm-box';
    const msgEl = document.createElement('div');
    msgEl.className = 'confirm-msg';
    msgEl.textContent = msg;
    const btns = document.createElement('div');
    btns.className = 'confirm-btns';
    const okBtn = document.createElement('button');
    okBtn.textContent = '確定';
    okBtn.addEventListener('click', () => close(true));
    btns.appendChild(okBtn);
    if (showCancel) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => close(false));
      btns.appendChild(cancelBtn);
    }
    box.appendChild(msgEl);
    box.appendChild(btns);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
    okBtn.focus();
  });
}
function uiConfirm(msg) { return uiDialog(msg, { showCancel: true }); }
function uiAlert(msg) { return uiDialog(msg, { showCancel: false }).then(() => {}); }

// ---- 小工具 ----
let toastTimer;
const TOAST_TYPES = ['toast-show', 'toast-error', 'toast-success', 'toast-info'];
function toast(msg, type = 'error') {
  const el = $('toast');
  el.textContent = msg || '';
  el.classList.remove(...TOAST_TYPES);
  clearTimeout(toastTimer);
  if (msg) {
    el.classList.add('toast-show', 'toast-' + type);
    toastTimer = setTimeout(() => { el.textContent = ''; el.classList.remove(...TOAST_TYPES); }, 3500);
  }
}
async function act(event, payload) {
  const res = await emit(event, payload);
  if (res.error) toast(res.error);
  return res;
}

// 搖骰鈕:長按機制見 pressRoll/releaseRoll(提示只放 title tooltip,不佔版面)
function rollBtn(label) {
  return `<button id="roll" title="按住搖、放開定">${label}</button>`;
}

// 顯示骰子(快取 renderer)。staticShow=true 直接亮點數(無翻滾動畫,用於開牌)
// rollIdx:明確指定要滾動的骰子索引 → 強制滾動(即使點數與上次相同,例如重骰剛好同點)
function showDice(container, key, values, hidden = false, staticShow = false, rollIdx = undefined) {
  if (hidden) {
    container.innerHTML = values.map(() => '<div class="cup">?</div>').join('');
    diceCache.delete(key);
    return;
  }
  // 若這個 stage 之前是骰盅(吹牛骰 solo),先清掉盅 DOM 與快取,改建 CSS3D 骰子
  if (container.querySelector('.cup-scene')) { container.innerHTML = ''; container.classList.remove('cup-cell'); diceCache.delete(key); }
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

// 吹牛骰「抓」之前:自己的骰子用骰盅(木紋/上掀,demo #2)蓋著搖、掀蓋亮點。
// 取得/建立該 stage 的骰盅渲染器(數量改變或盅 DOM 已被換掉時重建)。
function getCup(stage, key, count) {
  const n = Math.max(1, count || 1);
  let entry = cupCache.get(key);
  if (!entry || entry.el !== stage || entry.count !== n || !stage.querySelector('.cup-scene')) {
    stage.innerHTML = '';
    stage.classList.add('cup-cell');
    diceCache.delete(key); // 同一格若曾是 CSS3D 骰子,清掉避免混用
    const renderer = createCup(stage, { count: n, style: 'wood', lift: 'up', sound: false, scatter: true });
    entry = { renderer, el: stage, count: n, handSig: null, peeked: false };
    cupCache.set(key, entry);
  }
  return entry;
}

// 目前是否為吹牛骰「抓」之前(只顯示自己骰子的 solo 階段)
function isLiarsSolo() {
  const g = state && state.game;
  return !!(g && g.mode === 'liars' && !g.reveal);
}

// 開牌時在「要被拿掉」的骰子上畫叉叉(索引由後端 reveal.removedIdx 提供,前端不再自算條件)
function markRemovedDice(container, removedIdx) {
  const set = new Set(removedIdx || []);
  const scenes = container.querySelectorAll('.die3d-scene');
  scenes.forEach((sc, i) => sc.classList.toggle('marked', set.has(i)));
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
  // 吹牛骰整個模式都是吹牛 → 不提供自動下一場;混合模式仍顯示(僅吹牛子玩法那局不自動)
  $('autoNextWrap').style.display = (state.you.isHost && state.modeId !== 'liars') ? '' : 'none';
  // 「我要暫離」:正式玩家才看得到(觀戰中/已暫離不顯示)
  $('benchSelf').style.display = (!state.you.isAway && !state.you.isSpectator) ? '' : 'none';
  const anCb = $('autoNext'); if (anCb) anCb.checked = autoNext;
  if (state.status !== 'lobby') lobbyExpanded = false; // 離開大廳 → 下次回大廳重新精簡

  // 話胚重骰:動畫期間先別切換「最小者外框/控制/橫幅」,等動畫(約 1.45s)停了再更新
  const _lr = (state.game && state.game.reveal && state.game.reveal.subGame === 'poker') ? state.game.reveal.lastRoll : null;
  if (_lr && _lr.seq !== lastRollSeq) {
    pokerRerollAnim = true;
    if (pokerRerollTimer) clearTimeout(pokerRerollTimer);
    pokerRerollTimer = setTimeout(() => { pokerRerollAnim = false; scheduleRender(); }, 1450);
  }

  // 回合結束(playing→lobby):骰子動畫還在跑,延後 1.5s 才顯示順序按鈕等大廳結果 UI
  if (prevStatus === 'playing' && state.status === 'lobby') {
    roundEndAnim = true;
    if (roundEndTimer) clearTimeout(roundEndTimer);
    roundEndTimer = setTimeout(() => { roundEndAnim = false; if (state) scheduleRender(); }, 1500);
  }
  prevStatus = state.status;

  renderRoster();
  if (!pokerRerollAnim) renderLobby();    // 重骰動畫期間保留前一畫面(避免輸家骰子還沒停 lobby 就跳出)
  if (!pokerRerollAnim) renderBanner();   // 重骰動畫期間保留前一畫面
  renderBoard();                          // 骰子動畫照常播放
  maybeBlackjack21Fx();                   // 21 點骰:開牌時若有人剛好 21 點 → 金光特效
  if (!pokerRerollAnim) renderControls(); // 重骰動畫期間保留前一畫面
  renderPokerGuide();
  renderModeInfo();
  if (!pokerRerollAnim && !speedRolling) renderLoserBanner(); // 重骰/手速骰動畫期間先別跳輸家公告(等動畫停再顯示)
  renderWinnerBanner();
  renderMilestone();
  renderBluffStats();
  updateBarMetric(); // 量測底部動作條高度 → 浮動鈕/棋盤留白貼齊(手機直向)
  maybeAutoNext();

  // 手速骰:本地倒數/計時 + 揭題提示音(countdown→racing)
  setupSpeedClock();
  if (state.game && state.game.mode === 'speed') {
    if (state.game.phase === 'racing' && prevSpeedPhase === 'countdown') playAlert();
    prevSpeedPhase = state.game.phase;
  } else {
    prevSpeedPhase = null;
  }

  // 輪到我搖骰(各模式 rolling 階段、含紅黑單雙「搖下一骰」)→ 提示音(同話胚)
  const needRoll = iNeedToRoll();
  if (needRoll && !wasNeedRoll) playAlert();
  wasNeedRoll = needRoll;
  if (!needRoll) autoRolling = false; // 已不需搖骰 → 解除自動骰鎖
  if (needRoll && autoRoll) maybeAutoRoll();
}

// 手機直向:量測底部固定動作條的實際高度,寫入 --controls-h,讓棋盤留白與浮動鈕剛好貼齊
const barMQ = window.matchMedia('(max-width: 600px) and (orientation: portrait)');
function updateBarMetric() {
  const el = $('controls');
  const active = barMQ.matches && el && el.style.display !== 'none'
    && document.body.classList.contains('has-bottom-controls');
  const h = active ? el.offsetHeight : 0;
  document.documentElement.style.setProperty('--controls-h', h + 'px');
}
window.addEventListener('resize', updateBarMetric);
window.addEventListener('orientationchange', updateBarMetric);

// 目前是否「換我搖骰」(在進行中、非觀戰、rolling 階段且我還沒搖)
function iNeedToRoll() {
  const g = state.game;
  if (!g || state.status !== 'playing' || state.you.isSpectator) return false;
  if (g.mode === 'roll') return g.phase === 'rolling' && !(g.rolls && g.rolls[myId]);
  if (g.mode === 'roulette') {
    return g.phase === 'playing' && (g.order || [])[g.turnIndex] === myId;
  }
  if (g.mode === 'blackjack21') {
    return g.phase === 'rolling' && (g.order || [])[g.turnIndex] === myId;
  }
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
  const m = state.game?.mode;
  if (m === 'roulette' || m === 'blackjack21') return;
  autoRolling = true;
  playRattle(500); // 給點音效回饋
  emit('action', { type: 'roll' }).then((res) => {
    if (res && res.error) { autoRolling = false; toast(res.error); }
    // 成功 → 等 roomState 廣播,iNeedToRoll 變 false 時會自動解鎖
  });
}

// 本局輸家(話胚:reveal.loserId;紅黑單雙:reveal.losers;吹牛/吹牛骰:房主選定後)
function currentLosers() {
  const g = state.game;
  if (!g || !g.reveal) return [];
  if (g.mode === 'roulette' && g.reveal.loserId) return [g.reveal.loserId];
  if (g.mode === 'blackjack21' && g.reveal.losers) return g.reveal.losers;
  if (g.reveal.subGame === 'poker' && g.reveal.loserId) return [g.reveal.loserId];
  if (g.reveal.subGame === 'redblack' && (g.reveal.losers || []).length) return g.reveal.losers;
  if (!g.reveal.pending && (g.reveal.losers || []).length) return g.reveal.losers;
  return [];
}

// 決出輸家 → 置中 popup 公告 + 嘲諷音效;下一場開始(reveal 清空)會自動消失
// popup 設 pointer-events:none,純視覺、不擋住房主按「再來一場」
function renderLoserBanner() {
  const el = $('loserPopup');
  const losers = currentLosers();
  if (!losers.length) { el.style.display = 'none'; el.innerHTML = ''; lastLoserKey = ''; loserDismissedKey = ''; return; }
  const key = losers.slice().sort().join(',');
  if (key === loserDismissedKey) { el.style.display = 'none'; return; } // 已被點掉 → 不再顯示
  if (key === lastLoserKey) {
    // 同一個輸家且已顯示 → 不重設 innerHTML,避免重播彈出動畫造成閃爍
    if (el.style.display === 'none') el.style.display = 'flex';
    return;
  }
  // 新輸家 → 建立內容(彈出動畫播一次)+ 音效
  lastLoserKey = key;
  loserDismissedKey = '';
  const names = losers.map((id) => { const p = state.players.find((x) => x.id === id); return p ? esc(p.name) : '?'; }).join('<br>');
  // 紅黑單雙:額外寫出因為被拿掉哪一種而輸
  const rv = state.game && state.game.reveal;
  const reason = (rv && rv.subGame === 'redblack' && rv.conditionName)
    ? `<div class="loser-reason">因為被拿掉「${esc(rv.conditionName)}」而輸</div>`
    : '';
  el.innerHTML = `<div class="loser-card">`
    + `<div class="loser-title">💀 本局輸家 💀</div>`
    + `<div class="loser-name">${names}</div>${reason}`
    + `</div>`;
  el.style.display = 'flex';
  // 紅黑單雙秒殺 → 秒殺特效;驚爆骰爆掉 → 炸彈特效;其餘 → 嘲諷小號
  if (rv && rv.subGame === 'redblack' && rv.instantKill && rv.instantKill.length) {
    playInstantKillFx();
  } else if (state.game && state.game.mode === 'roulette') {
    playBombFx();
    playExplosion();
  } else {
    playFanfare();
  }
}

// 炸彈爆炸動圖特效:滿版閃光 + 擴散衝擊環 + 💥 核心 + 四散碎片,播一次後自動隱藏
function playBombFx() {
  const el = $('bombFx');
  if (!el) return;
  const shards = ['💥', '🔥', '💢', '✨', '💀', '🔥', '💥', '✨'];
  const parts = shards.map((emo, i) => {
    const ang = (Math.PI * 2 * i) / shards.length + (i % 2 ? 0.3 : -0.3);
    const dist = 160 + (i % 3) * 70;
    const dx = Math.round(Math.cos(ang) * dist);
    const dy = Math.round(Math.sin(ang) * dist);
    const rot = (i % 2 ? 1 : -1) * (180 + i * 40);
    return `<div class="bomb-shard" style="--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg">${emo}</div>`;
  }).join('');
  el.innerHTML = `<div class="bomb-flash"></div><div class="bomb-ring"></div>`
    + `<div class="bomb-core">💥</div>${parts}`;
  el.style.display = 'flex';
  setTimeout(() => { el.style.display = 'none'; el.innerHTML = ''; }, 1000);
}

// 秒殺特效:暗紅衝擊波 + 刀痕斬擊 + 中央「秒殺」大字 + 骷髏碎片
function playInstantKillFx() {
  const el = $('instantKillFx');
  if (!el) return;
  const skulls = ['💀', '⚡', '🗡️', '☠️', '💀', '⚡', '🗡️', '☠️', '🔥', '💢'];
  const parts = skulls.map((emo, i) => {
    const ang = (Math.PI * 2 * i) / skulls.length + (i % 2 ? 0.2 : -0.2);
    const dist = 150 + (i % 3) * 60;
    const dx = Math.round(Math.cos(ang) * dist);
    const dy = Math.round(Math.sin(ang) * dist);
    const rot = (i % 2 ? 1 : -1) * (150 + i * 35);
    return `<div class="ik-shard" style="--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg">${emo}</div>`;
  }).join('');
  el.innerHTML = `<div class="ik-flash"></div><div class="ik-ring"></div><div class="ik-ring ik-ring2"></div>`
    + `<div class="ik-slash"></div><div class="ik-label">⚡ 秒殺 ⚡</div>${parts}`;
  el.style.display = 'flex';
  playInstantKill();
  setTimeout(() => { el.style.display = 'none'; el.innerHTML = ''; }, 1800);
}

// 鐵支特效:金色衝擊波 + 星芒四射 + 中央「鐵支」大字
function playIronFx() {
  const el = $('handFx');
  if (!el) return;
  const stars = ['⭐', '✨', '💫', '🌟', '⭐', '✨'];
  const parts = stars.map((emo, i) => {
    const ang = (Math.PI * 2 * i) / stars.length + (i % 2 ? 0.25 : -0.25);
    const dist = 120 + (i % 3) * 60;
    const dx = Math.round(Math.cos(ang) * dist);
    const dy = Math.round(Math.sin(ang) * dist);
    return `<div class="iron-star" style="--dx:${dx}px;--dy:${dy}px">${emo}</div>`;
  }).join('');
  el.innerHTML = `<div class="iron-flash"></div><div class="iron-ring"></div>`
    + `<div class="iron-label">🔩 鐵支</div>${parts}`;
  el.style.display = 'flex';
  playIronFour();
  setTimeout(() => { el.style.display = 'none'; el.innerHTML = ''; }, 1300);
}

// 豹子特效:彩虹漩渦 + 爆發粒子 + 中央豹子名稱
function playLeopardFx(label) {
  const el = $('handFx');
  if (!el) return;
  const emojis = ['🎯', '🔥', '💎', '👑', '🎯', '🔥', '💎', '👑', '⚡', '🌈'];
  const parts = emojis.map((emo, i) => {
    const ang = (Math.PI * 2 * i) / emojis.length + (i % 2 ? 0.2 : -0.2);
    const dist = 140 + (i % 3) * 55;
    const dx = Math.round(Math.cos(ang) * dist);
    const dy = Math.round(Math.sin(ang) * dist);
    const rot = (i % 2 ? 1 : -1) * (120 + i * 35);
    return `<div class="pao-burst" style="--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg">${emo}</div>`;
  }).join('');
  const colors = ['#f44', '#ff0', '#0f0', '#0ff', '#f0f'];
  const ring1 = `<div class="pao-ring" style="border-color:${colors[0]};animation-delay:0s"></div>`;
  const ring2 = `<div class="pao-ring" style="border-color:${colors[2]};animation-delay:.15s"></div>`;
  el.innerHTML = `<div class="pao-vortex"></div><div class="pao-flash"></div>`
    + `${ring1}${ring2}<div class="pao-label">🐆 ${label}</div>${parts}`;
  el.style.display = 'flex';
  playLeopard();
  setTimeout(() => { el.style.display = 'none'; el.innerHTML = ''; }, 1600);
}

// 21 點骰:開牌(reveal / roundEnd)時,場上只要有人剛好 21 點就播一次金光特效(每局一次)
function maybeBlackjack21Fx() {
  const g = state && state.game;
  if (!g || g.mode !== 'blackjack21' || (g.phase !== 'reveal' && g.phase !== 'roundEnd')) {
    bj21Shown = false; // 非開牌階段 → 重置,下一局可再觸發
    return;
  }
  if (bj21Shown) return;
  const ids21 = Object.entries(g.hands || {})
    .filter(([, h]) => h && h.total === 21 && !h.bust)
    .map(([id]) => id);
  if (!ids21.length) return;
  bj21Shown = true;
  const names = ids21.map((id) => { const p = state.players.find((x) => x.id === id); return p ? esc(p.name) : '?'; });
  playBlackjack21Fx(names);
}

// 21 點骰:剛好湊到 21 點的特效 —— 金色爆閃 + 雙衝擊環 + 「🃏 21 點!」大字 + 撲克牌雨
function playBlackjack21Fx(names = []) {
  const el = $('handFx');
  if (!el) return;
  const cards = ['🃏', '🎴', '👑', '💰', '✨', '🃏', '🎴', '💰', '⭐', '🎰'];
  const parts = cards.map((emo, i) => {
    const ang = (Math.PI * 2 * i) / cards.length + (i % 2 ? 0.2 : -0.2);
    const dist = 140 + (i % 3) * 60;
    const dx = Math.round(Math.cos(ang) * dist);
    const dy = Math.round(Math.sin(ang) * dist);
    const rot = (i % 2 ? 1 : -1) * (140 + i * 40);
    return `<div class="bj21-card" style="--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg">${emo}</div>`;
  }).join('');
  const who = names.length ? `<div class="bj21-who">${names.join('、')}</div>` : '';
  el.innerHTML = `<div class="bj21-flash"></div>`
    + `<div class="bj21-ring"></div><div class="bj21-ring bj21-ring2"></div>`
    + `<div class="bj21-label">🃏 21 點!</div>${who}${parts}`;
  el.style.display = 'flex';
  playFanfare();
  setTimeout(() => { el.style.display = 'none'; el.innerHTML = ''; }, 1600);
}

// 淘汰制最終勝利者 popup:matchOver + winnerId 時延遲彈出(讓輸家 popup 先顯示)
function renderWinnerBanner() {
  const el = $('winnerPopup');
  if (!state || !state.matchOver || !state.winnerId) {
    el.style.display = 'none'; el.innerHTML = '';
    lastWinnerKey = ''; winnerDismissedKey = '';
    if (winnerTimer) { clearTimeout(winnerTimer); winnerTimer = null; }
    return;
  }
  const key = state.winnerId;
  if (key === winnerDismissedKey) { el.style.display = 'none'; return; }
  if (key === lastWinnerKey) {
    if (el.style.display === 'none') el.style.display = 'flex';
    return;
  }
  // 新的勝利者 → 延遲顯示(讓輸家 popup 先亮 1.5 秒)
  if (winnerTimer) return;
  winnerTimer = setTimeout(() => {
    winnerTimer = null;
    lastWinnerKey = key;
    winnerDismissedKey = '';
    const w = state.players.find((p) => p.id === state.winnerId);
    el.innerHTML = `<div class="winner-card">`
      + `<div class="winner-title">🏆 最終勝利者 🏆</div>`
      + `<div class="winner-name">${esc(w ? w.name : '?')}</div>`
      + `</div>`;
    el.style.display = 'flex';
    playVictory();
  }, 1800);
}

// 輸到 10 的倍數次 → 嘲諷 popup(延遲 2.5 秒,讓輸家 popup 先亮)
function renderMilestone() {
  const el = $('milestonePopup');
  const ms = state && state.lossMilestone;
  if (!ms || !ms.length) {
    el.style.display = 'none'; el.innerHTML = '';
    lastMilestoneKey = ''; milestoneDismissed = '';
    if (milestoneTimer) { clearTimeout(milestoneTimer); milestoneTimer = null; }
    return;
  }
  const key = ms.map((m) => `${m.id}:${m.count}`).join(',');
  if (key === milestoneDismissed) { el.style.display = 'none'; return; }
  if (key === lastMilestoneKey) {
    if (el.style.display === 'none') el.style.display = 'flex';
    return;
  }
  if (milestoneTimer) return;
  milestoneTimer = setTimeout(() => {
    milestoneTimer = null;
    lastMilestoneKey = key;
    milestoneDismissed = '';
    const icon = ms[0].icon || '🤡';
    const lines = ms.map((m) => `<div>${esc(m.text)}</div>`).join('');
    el.innerHTML = `<div class="milestone-card">`
      + `<div class="milestone-icon">${icon}</div>`
      + `<div class="milestone-text">${lines}</div>`
      + `<div class="milestone-sub">點擊關閉</div>`
      + `</div>`;
    el.style.display = 'flex';
  }, 2500);
}

// 吹牛開盅(吹牛骰模式 / 混合吹牛子玩法)→ 各點數統計用 popup 顯示
// 兩者 reveal 都帶 stats;下一場開始(reveal 清空)自動消失,點外面可關
function renderBluffStats() {
  const el = $('statsPopup');
  const g = state.game;
  const stats = (g && g.reveal && g.reveal.stats) ? g.reveal.stats : null;
  if (!stats) { el.style.display = 'none'; el.innerHTML = ''; lastStatsKey = ''; statsDismissedKey = ''; return; }
  const key = [1, 2, 3, 4, 5, 6].map((f) => stats[f] || 0).join(',');
  if (key === statsDismissedKey) { el.style.display = 'none'; return; }
  if (key === lastStatsKey) { if (el.style.display === 'none') el.style.display = 'flex'; return; }
  lastStatsKey = key;
  statsDismissedKey = '';
  const card = document.createElement('div');
  card.className = 'stats-card';
  const titleEl = document.createElement('div');
  titleEl.className = 'stats-title';
  titleEl.textContent = '✊ 開盅!各點數統計';
  card.appendChild(titleEl);
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  for (let f = 1; f <= 6; f++) {
    const cell = document.createElement('span');
    cell.className = 'stat-cell';
    const stage = document.createElement('div');
    stage.className = 'stat-die-stage';
    const countEl = document.createElement('b');
    countEl.textContent = `×${stats[f] || 0}`;
    cell.appendChild(stage);
    cell.appendChild(countEl);
    grid.appendChild(cell);
    const renderer = createDice(stage, { count: 1 });
    renderer.setStatic([f]);
  }
  card.appendChild(grid);
  el.innerHTML = '';
  el.appendChild(card);
  el.style.display = 'flex';
}

// 點 popup 卡片以外的地方 → 關掉(記住已關,同一場不再彈出)
document.addEventListener('click', (e) => {
  const sp = $('statsPopup');
  if (sp && sp.style.display !== 'none' && lastStatsKey && !(e.target.closest && e.target.closest('.stats-card'))) {
    statsDismissedKey = lastStatsKey; sp.style.display = 'none';
  }
  const wp = $('winnerPopup');
  if (wp && wp.style.display !== 'none' && lastWinnerKey && !(e.target.closest && e.target.closest('.winner-card'))) {
    winnerDismissedKey = lastWinnerKey; wp.style.display = 'none';
  }
  const mp = $('milestonePopup');
  if (mp && mp.style.display !== 'none' && lastMilestoneKey) {
    milestoneDismissed = lastMilestoneKey; mp.style.display = 'none';
  }
  const el = $('loserPopup');
  if (!el || el.style.display === 'none' || !lastLoserKey) return;
  if (e.target.closest && e.target.closest('.loser-card')) return; // 點到卡片本身不關
  loserDismissedKey = lastLoserKey;
  el.style.display = 'none';
});

// 話胚牌型大小:收進 ℹ️ 按鈕,點了才彈出(不佔版面、不擠棋盤)
const POKER_RANK_HTML = `<div class="rank-card">
  <h3>🃏 牌型大小(大 → 小)</h3>
  <ol class="rank-list">
    <li><b>豹子</b> 五顆同點 <span class="muted">(1&gt;6&gt;5&gt;4&gt;3&gt;2)</span></li>
    <li><b>鐵支</b> 四顆同點</li>
    <li><b>順子</b> 12345 / 23456 <span class="muted">(12345&gt;23456)</span></li>
    <li><b>葫蘆</b> 三顆同點 + 一對</li>
    <li><b>三條</b> 三顆同點</li>
    <li><b>兩對</b> 兩組對子</li>
    <li><b>一對</b> 一組對子</li>
    <li><b>散牌</b> 比最大單點 <span class="muted">(1&gt;6&gt;5&gt;4&gt;3&gt;2)</span></li>
  </ol></div>`;
let pokerRankOpen = false;
function setPokerRankPopup(open) {
  pokerRankOpen = open;
  const pop = $('pokerRankPopup');
  if (!pop) return;
  if (open && !pop.innerHTML) pop.innerHTML = POKER_RANK_HTML;
  pop.style.display = open ? 'flex' : 'none';
}
function renderPokerGuide() {
  const el = $('pokerGuide');
  const show = !!(state.game && state.game.subGame === 'poker');
  el.style.display = show ? '' : 'none';
  if (show) {
    if (!el.innerHTML) el.innerHTML = '<button id="pokerRankBtn" class="chip">🃏 牌型大小 ℹ️</button>';
    const btn = $('pokerRankBtn');
    if (btn) btn.onclick = () => setPokerRankPopup(!pokerRankOpen);
  } else {
    setPokerRankPopup(false); // 離開話胚 → 自動關閉
  }
}
// 點牌型表以外的地方 → 關閉
$('pokerRankPopup')?.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('.rank-card')) setPokerRankPopup(false);
});

// 各模式規則說明:左下角 info icon → 點了彈出 popup(僅這幾個模式有)
const MODE_RULES = {
  roulette: `<div class="rank-card">
    <h3>💣 驚爆骰</h3>
    <p>輪流行動的<b>淘汰制</b>骰子遊戲。每回合會隨機產生一個隱藏的「爆掉門檻」,你只看得到可能範圍。</p>
    <p>輪到你時擲骰,點數會累加進總和。總和一旦超過門檻就<b>爆掉</b>,當回合你輸、扣一條命。</p>
    <p>門檻範圍依存活人數決定(最小 = 人數×5,最大 = 人數×10),爆掉後才揭曉實際門檻。</p>
    <p>累計點數尚在<b>安全區</b>時(加上最大骰面仍不可能碰到門檻下限),系統會自動快速骰過。</p>
    <p class="muted">生命數由房主設定(預設 3);設為 0 為單局模式、不淘汰。命歸零者被淘汰,最後存活者獲勝。</p>
  </div>`,
  blackjack21: `<div class="rank-card">
    <h3>🎲 21 點骰</h3>
    <p>輪流行動的<b>淘汰制</b>遊戲,目標是讓骰子點數總和<b>接近但不超過 21</b>。</p>
    <p>開局自動骰 3 顆起手,之後輪到你時可選擇<b>要 1~3 顆</b>骰或「停牌」。</p>
    <p><b>暗骰</b>:別人只看得到你骰了幾顆、看不到點數;爆掉的外觀和停牌一樣(可虛張聲勢)。</p>
    <p>全員結束後開牌:爆掉者輸;全沒爆則最低分者輸(同分時骰子數多者贏);全爆則超過最多者輸。</p>
    <p class="muted">生命數由房主設定(預設 3);設為 0 為單局模式、不淘汰。最後存活者為最終勝利者。</p>
  </div>`,
  speed: `<div class="rank-card">
    <h3>⚡ 手速骰</h3>
    <p>即時競速模式,每人 5 顆骰。倒數 3 秒後揭題,指定一個<b>撲克牌型</b>(須剛好湊到該牌型,不是「以上」)。</p>
    <p>揭題後各自按「搖骰」開始,可無限重骰、各自獨立鎖骰。連續擲骰有 1 秒冷卻。</p>
    <p>搶先湊到指定牌型即<b>安全</b>。只剩 1 人未達標就立刻結束、該人輸;時間到仍有 2 人以上未達標,則未達標者全輸。</p>
    <p class="muted">生命數由房主設定(預設 3);設為 0 為單局模式、不淘汰。最後存活者為最終勝利者。秒數預設 30,範圍 10~60。</p>
  </div>`,
};
let modeInfoOpen = false;
function setModeInfoPopup(open) {
  modeInfoOpen = open;
  const pop = $('modeInfoPopup');
  if (!pop) return;
  if (open) pop.innerHTML = MODE_RULES[state.modeId] || '';
  pop.style.display = open ? 'flex' : 'none';
}
function renderModeInfo() {
  const btn = $('modeInfoBtn');
  if (!btn) return;
  const show = !!MODE_RULES[state.modeId];
  btn.style.display = show ? '' : 'none';
  if (!show && modeInfoOpen) setModeInfoPopup(false);
}
$('modeInfoBtn')?.addEventListener('click', () => setModeInfoPopup(!modeInfoOpen));
$('modeInfoPopup')?.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('.rank-card')) setModeInfoPopup(false);
});

let rosterHtmlCache = null;   // roster 最終 html 簽章:沒變就跳過 innerHTML 與重綁
let draggingRoster = false;   // 拖曳排序進行中:暫停 roster 重建,避免中途 render 打斷拖曳
function renderRoster() {
  if (draggingRoster) return; // 拖曳中不重建 DOM
  const el = $('rosterBody');
  const canReorderGlobal = !roundEndAnim && state.you.isHost && state.status === 'lobby' && state.players.length > 1;
  const ob = $('rosterOrderBtns');
  if (ob) {
    ob.innerHTML = canReorderGlobal
      ? '<button class="mini secondary" id="rosterShuffle" type="button" title="打亂玩家順序">🔀</button>'
        + '<button class="mini secondary" id="rosterReverse" type="button" title="顛倒玩家順序">🔄</button>'
      : '';
    ob.querySelector('#rosterShuffle')?.addEventListener('click', () => act('shufflePlayers', {}));
    ob.querySelector('#rosterReverse')?.addEventListener('click', () => act('reversePlayers', {}));
  }
  const playerRow = (p, extra = '', opts = {}) => {
    const isHost = p.id === state.hostId;
    const me = p.id === myId ? ' (你)' : '';
    const dot = p.connected ? 'on' : 'off';
    // 房主用皇冠取代綠點(不重複);其他玩家顯示連線狀態圓點
    const lead = isHost ? '<span class="crown">👑</span>' : `<span class="dot ${dot}"></span>`;
    const hostCtrl = state.you.isHost && p.id !== myId;
    const benchItem = (hostCtrl && opts.bench)
      ? `<button class="rm-item bench" data-bench="${p.id}">💤 丟入暫離</button>` : '';
    const actions = hostCtrl
      ? `<span class="row-actions"><span class="row-menu">`
        + `<button class="row-more" data-more="${p.id}" title="房主操作" aria-label="房主操作">⋯</button>`
        + `<div class="row-pop" data-pop="${p.id}" hidden>`
        + benchItem
        + `<button class="rm-item mkhost" data-host="${p.id}">👑 轉讓房主</button>`
        + `<button class="rm-item kick" data-kick="${p.id}">✕ 踢出房間</button>`
        + `</div></span></span>`
      : '';
    const handle = opts.reorder ? `<span class="drag-h" title="拖曳排序">⠿</span>` : '';
    const liAttr = opts.reorder ? ` class="reorderable" data-pid="${p.id}"` : '';
    return `<li${liAttr}>${handle}${lead}<span class="pname">${esc(p.name)}${me}</span>${extra}${actions}</li>`;
  };
  // 房主在大廳可手動調整玩家順序(▲▼);開局後順序鎖定,不顯示
  const canReorder = !roundEndAnim && state.you.isHost && state.status === 'lobby' && state.players.length > 1;
  let html = `<h3>玩家 (${state.players.length})</h3><ul class="roster" id="rosterPlayers">`;
  // 玩家列表固定用加入順序(state.players 原始順序:房主先、之後依加入先後)
  html += state.players.map((p, i) => {
    const serverLosses = (state.losses && state.losses[p.id]) || 0;
    if (lossSettled[p.id] === undefined) lossSettled[p.id] = serverLosses;
    const lossSig = String(serverLosses);
    if (lossSettled[p.id] !== serverLosses && lossPending[p.id] !== lossSig) {
      lossPending[p.id] = lossSig;
      setTimeout(() => { lossSettled[p.id] = serverLosses; lossPending[p.id] = null; if (state) scheduleRender(); }, 1500);
    }
    const losses = lossSettled[p.id];
    const extra = ` <span class="muted">輸 ${losses} 次</span>`;
    return playerRow(p, extra, { bench: true, reorder: canReorder });
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
  // 內容沒變 → 跳過 innerHTML 重建與重綁(事件 handler 都在點擊時讀最新 state,跳過安全)
  if (html === rosterHtmlCache) return;
  el.innerHTML = html;
  rosterHtmlCache = html;

  // 房主操作 ⋯ 選單:點開/關,點到動作或選單外自動關
  const closeRowPops = (except) => el.querySelectorAll('.row-pop').forEach((p) => { if (p !== except) p.hidden = true; });
  el.querySelectorAll('[data-more]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = el.querySelector(`.row-pop[data-pop="${b.dataset.more}"]`);
      const willOpen = pop && pop.hidden;
      closeRowPops(willOpen ? pop : null);
      if (pop) pop.hidden = !willOpen;
    })
  );
  if (!renderRoster._popOutside) {
    renderRoster._popOutside = true;
    document.addEventListener('click', () => { document.querySelectorAll('.row-pop').forEach((p) => (p.hidden = true)); });
  }
  // 房主:丟入暫離觀戰區
  el.querySelectorAll('[data-bench]').forEach((b) =>
    b.addEventListener('click', () => act('benchPlayer', { targetId: b.dataset.bench }))
  );
  // 房主:踢人按鈕
  el.querySelectorAll('[data-kick]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await uiConfirm('確定要將此玩家移出房間嗎?')) act('kickPlayer', { targetId: b.dataset.kick });
    })
  );
  // 房主:指定為房主
  el.querySelectorAll('[data-host]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await uiConfirm('確定把房主轉移給此玩家嗎?')) act('transferHost', { targetId: b.dataset.host });
    })
  );
  // 房主:拖曳手柄調整玩家順序(pointer 事件,鼠標/觸控通用;放開送出完整新順序陣列)
  const pul = el.querySelector('#rosterPlayers');
  if (canReorder && pul) {
    pul.querySelectorAll('.drag-h').forEach((h) =>
      h.addEventListener('pointerdown', (e) => startRosterDrag(e, pul, h))
    );
  }
}

// 拖曳排序:按住手柄後跟著手指/游標移動,依 Y 座標即時插入到對應位置,放開才送伺服器
function startRosterDrag(e, ul, handle) {
  const li = handle.closest('li.reorderable');
  if (!li) return;
  e.preventDefault();
  // capture 綁在 ul(拖曳中不會被搬動),否則 li 一被 insertBefore 就會丟失 capture、pointermove 斷掉卡住
  try { ul.setPointerCapture(e.pointerId); } catch {}
  draggingRoster = true;
  li.classList.add('dragging');
  const move = (ev) => {
    const y = ev.clientY;
    const others = [...ul.querySelectorAll('li.reorderable:not(.dragging)')];
    let placed = false;
    for (const it of others) {
      const r = it.getBoundingClientRect();
      if (y < r.top + r.height / 2) { ul.insertBefore(li, it); placed = true; break; }
    }
    if (!placed) ul.appendChild(li);
  };
  const up = () => {
    ul.removeEventListener('pointermove', move);
    ul.removeEventListener('pointerup', up);
    ul.removeEventListener('pointercancel', up);
    try { ul.releasePointerCapture(e.pointerId); } catch {}
    li.classList.remove('dragging');
    draggingRoster = false;
    const order = [...ul.querySelectorAll('li.reorderable')].map((n) => n.dataset.pid);
    const cur = state.players.map((p) => p.id);
    if (order.length === cur.length && order.some((id, i) => id !== cur[i])) {
      rosterHtmlCache = null; // 順序變了,強制下次 render 重建並綁定
      act('reorderPlayers', { order });
    }
  };
  ul.addEventListener('pointermove', move);
  ul.addEventListener('pointerup', up);
  ul.addEventListener('pointercancel', up);
}

// 各模式的圖示與一行簡介(前端展示用;新增模式在這裡補一筆即可)
const MODE_META = {
  roll:        { icon: '🎲', desc: '比點數大小，最快分勝負' },
  liars:       { icon: '🤥', desc: '蓋牌喊點數，抓對方吹牛' },
  mixed:       { icon: '🎰', desc: '紅黑單雙／吹牛／話胚' },
  roulette:    { icon: '💣', desc: '輪流累加，爆掉那個輸' },
  blackjack21: { icon: '🃏', desc: '骰子加總逼近 21 不爆' },
  speed:       { icon: '⚡', desc: '限時搶湊出指定牌型' },
};

// 依模式回傳該模式的設定項(data-driven;新增設定只改這裡)
// num: 數值步進器  tog: 開關
function lobbySettings(modeId) {
  const num = (id, label, val, min, max, action, param, hint) =>
    ({ type: 'num', id, label, val: val ?? min, min, max, action, param, hint });
  const tog = (id, label, on, action) => ({ type: 'tog', id, label, on, action });
  switch (modeId) {
    case 'roll':  return [num('diceCount', '每人骰子數', state.diceCount, 1, 100, 'setDiceCount', 'count')];
    case 'liars': return [num('diceCount', '每人起始骰子數', state.diceCount, 1, 100, 'setDiceCount', 'count')];
    case 'roulette': return [
      num('rouletteLives', '每人生命', state.rouletteLives, 0, 10, 'setRouletteLives', 'value', '0 = 單局模式（不淘汰）'),
      num('rouletteAbility', '特殊功能次數', state.rouletteAbility, 0, 5, 'setRouletteAbility', 'value', '每輪可分配至「跳過」與「迴轉」'),
    ];
    case 'blackjack21': return [
      num('blackjackLives', '每人生命', state.blackjackLives, 0, 10, 'setBlackjackLives', 'value', '0 = 單局模式（不淘汰）'),
    ];
    case 'speed': return [
      num('speedSeconds', '每局秒數', state.speedSeconds, 10, 60, 'setSpeedSeconds', 'value'),
      num('speedLives', '每人生命', state.speedLives, 0, 10, 'setSpeedLives', 'value', '0 = 單局模式（不淘汰）'),
    ];
    case 'mixed': return [
      tog('loserDecides', '由輸家決定玩法', state.loserDecides, 'setLoserDecides'),
      tog('autoRotate', '自動順位（紅黑單雙）', state.autoRotate, 'setAutoRotate'),
    ];
    default: return [];
  }
}

// 步進器 / 手動輸入共用:讀 input 的 min/max/action/param,夾範圍後送出
function fireNumSetting(inp) {
  const min = Number(inp.min), max = Number(inp.max);
  let v = Math.round(Number(inp.value) || min);
  v = Math.max(min, Math.min(max, v));
  inp.value = v;
  act(inp.dataset.action, { [inp.dataset.param]: v });
}

function renderLobby() {
  const el = $('lobby');
  const isHost = state.you.isHost;
  const inLobby = state.status === 'lobby';

  // 只有房主、且在大廳時才顯示 lobby panel;非房主完全不顯示
  if (!inLobby || !isHost) { el.style.display = 'none'; el.innerHTML = ''; el.classList.remove('lobby-compact'); return; }
  el.style.display = '';

  // 已玩過一局且尚未展開 → 精簡視圖:只顯示「再來一場/下一輪」+「換模式」,畫面乾淨
  if (state.game && !lobbyExpanded) {
    el.classList.add('lobby-compact'); // 高度對齊 controls panel
    el.innerHTML = `<div class="lobby-row">`
      + `<button id="start" class="start-btn" ${state.modeId ? '' : 'disabled'}>${startButtonLabel()}</button>`
      + `<button id="changeMode" class="secondary">🔧 換模式</button>`
      + `</div>`;
    $('start')?.addEventListener('click', startRoundOnce);
    $('changeMode')?.addEventListener('click', () => { lobbyExpanded = true; render(); });
    return;
  }

  el.classList.remove('lobby-compact'); // 完整面板 → 取消精簡高度

  // 模式選擇:卡片網格(只顯示開放的模式,未開放的隱藏)
  let html = '<div class="lobby-modes">';
  for (const m of state.modes) {
    if (!m.available) continue;
    const active = m.id === state.modeId ? 'active' : '';
    const meta = MODE_META[m.id] || { icon: '🎲', desc: '' };
    html += `<button class="mode-card ${active}" data-mode="${m.id}">`
      + `<span class="mc-icon">${meta.icon}</span>`
      + `<span class="mc-name">${esc(m.name)}</span>`
      + `<span class="mc-desc">${esc(meta.desc)}</span>`
      + `</button>`;
  }
  html += '</div>';

  // 該模式的設定卡
  const settings = lobbySettings(state.modeId);
  if (settings.length) {
    html += '<div class="lobby-settings"><div class="ls-title">⚙️ 遊戲設定</div>';
    for (const s of settings) {
      if (s.type === 'num') {
        html += `<div class="setting"><div class="s-main"><span class="s-label">${esc(s.label)}</span>`
          + `<span class="stepper">`
          + `<button type="button" class="st-btn" data-step="-1" aria-label="減少">−</button>`
          + `<input id="${s.id}" type="number" min="${s.min}" max="${s.max}" value="${s.val}" data-action="${s.action}" data-param="${s.param}" />`
          + `<button type="button" class="st-btn" data-step="1" aria-label="增加">+</button>`
          + `</span></div>`
          + (s.hint ? `<div class="s-hint">${esc(s.hint)}</div>` : '')
          + `</div>`;
      } else {
        html += `<label class="setting toggle"><span class="s-label">${esc(s.label)}</span>`
          + `<span class="switch"><input id="${s.id}" type="checkbox" data-action="${s.action}" ${s.on ? 'checked' : ''}/><span class="slider"></span></span>`
          + `</label>`;
      }
    }
    html += '</div>';
  }

  html += `<button id="start" class="start-btn" ${state.modeId ? '' : 'disabled'}>${startButtonLabel()}</button>`;
  el.innerHTML = html;

  el.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => act('setMode', { modeId: b.dataset.mode }))
  );
  el.querySelectorAll('.st-btn').forEach((btn) => btn.addEventListener('click', () => {
    const inp = btn.parentElement.querySelector('input');
    const min = Number(inp.min), max = Number(inp.max);
    let v = Math.round(Number(inp.value) || min) + Number(btn.dataset.step);
    v = Math.max(min, Math.min(max, v));
    if (String(v) !== inp.value) { inp.value = v; fireNumSetting(inp); }
  }));
  el.querySelectorAll('input[type="number"][data-action]').forEach((inp) =>
    inp.addEventListener('change', () => fireNumSetting(inp)));
  el.querySelectorAll('input[type="checkbox"][data-action]').forEach((cb) =>
    cb.addEventListener('change', () => act(cb.dataset.action, { on: cb.checked })));
  $('start')?.addEventListener('click', startRoundOnce);
}

// 開始遊戲:點擊即 disabled 防連點;ack 回來後恢復(成功時按鈕多半已被 render 重建)
async function startRoundOnce(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try { await act('startRound', {}); }
  finally { btn.disabled = false; }
}

// 吹牛玩法不自動下一場(一定要房主手動按):吹牛骰模式、或混合模式上一局是吹牛子玩法
function isBluffPlay() {
  if (state.modeId === 'liars') return true;
  if (state.modeId === 'mixed' && state.game && state.game.subGame === 'bluff') return true;
  return false;
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
  const should = state.you.isHost && autoNext && state.modeId && state.game && !isBluffPlay();
  if (!should) {
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
    return;
  }
  if (autoNextArmed || autoNextTimer) return; // 本次大廳已排程過
  autoNextArmed = true;
  autoNextTimer = setTimeout(async () => {
    autoNextTimer = null;
    if (!(state.you.isHost && autoNext && state.status === 'lobby' && state.game && !isBluffPlay())) return;
    const res = await emit('startRound', {});
    if (res.error) toast('自動下一場:' + res.error); // 只提示,不關閉勾選
  }, 6000);
}

function startButtonLabel() {
  if (state.modeId === 'liars' || state.modeId === 'mixed' || state.modeId === 'roulette' || state.modeId === 'speed') {
    if (state.matchOver) return '再來一場';
    if (state.game) return '下一局';
    return '開始遊戲';
  }
  if (state.modeId === 'roll') return state.game ? '再搖一輪' : '開始搖骰';
  return '開始';
}

// 手速骰:依 server 的 targetAt/deadlineAt + 時鐘偏移,本地高頻更新倒數/計時 DOM
// (只改文字節點,不整頁 render,避免骰子被重建打斷動畫)
function setupSpeedClock() {
  const g = state && state.game;
  const active = g && g.mode === 'speed' && state.status === 'playing'
    && (g.phase === 'countdown' || g.phase === 'racing');
  if (speedClockTimer) { clearInterval(speedClockTimer); speedClockTimer = null; }
  if (!active) { speedLastCountN = null; return; }
  speedSkew = Date.now() - (g.serverNow || Date.now());
  const tick = () => {
    const gg = state && state.game;
    if (!gg || gg.mode !== 'speed' || state.status !== 'playing') {
      clearInterval(speedClockTimer); speedClockTimer = null; return;
    }
    const serverNow = Date.now() - speedSkew;
    if (gg.phase === 'countdown') {
      const n = Math.ceil((gg.targetAt - serverNow) / 1000);
      const cd = document.getElementById('speedCount');
      if (cd) cd.textContent = n > 0 ? String(n) : 'GO!';
      if (n !== speedLastCountN && n >= 0 && n <= 3) { speedLastCountN = n; playCountdownTick(); }
    } else if (gg.phase === 'racing') {
      const sec = Math.max(0, Math.ceil((gg.deadlineAt - serverNow) / 1000));
      const ck = document.getElementById('speedClock');
      if (ck) {
        ck.textContent = `⏱️ ${sec}s`;
        ck.classList.toggle('danger', sec <= 5);
      }
    }
  };
  speedClockTimer = setInterval(tick, 100);
  tick();
}

// 手速骰冷卻:倒數期間直改搖骰鈕的文字/禁用(不整頁 render,避免打斷骰子動畫);
// 冷卻結束的最後一 tick 還原成 renderControls 產出的初始文案並解鎖
function scheduleSpeedCooldownRender() {
  if (speedCooldownTimer) return;
  const tick = () => {
    const btn = $('speedReroll'); // 按鈕可能被 render 重建,每次重查
    const wait = speedRollReadyAt - Date.now();
    if (wait <= 0) {
      clearInterval(speedCooldownTimer); speedCooldownTimer = null;
      if (btn) {
        const g = state && state.game;
        const first = !(((g && g.myDice) || []).length);
        btn.textContent = `🎲 ${first ? '搖骰!' : '重骰(未鎖的)'}`;
        btn.disabled = false;
      }
      return;
    }
    if (btn) {
      btn.textContent = `⏳ ${(wait / 1000).toFixed(1)}s`;
      btn.disabled = true;
    }
  };
  speedCooldownTimer = setInterval(tick, 100);
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
    if (state.status === 'playing' && g.phase === 'pickLoser') {
      const grabber = g.reveal && g.reveal.grabberId ? (() => { const p = state.players.find((x) => x.id === g.reveal.grabberId); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; })() : '';
      const grabMsg = grabber ? ` (${grabber} 抓的)` : '';
      return show(state.you.isHost ? `👇 請選出本輪輸家${grabMsg}` : `⏳ 等待房主選出輸家…${grabMsg}`);
    }
    if (g.reveal && !g.reveal.pending) {
      const r = g.reveal;
      if (r.subGame === 'bluff') {
        const nm2 = (id) => { const p = state.players.find((x) => x.id === id); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; };
        const grabber = r.grabberId ? nm2(r.grabberId) : '';
        return show(`✊ ${grabber ? `${grabber} 開盅!` : '開盅!'} ・ 💀 ${nm2(r.loserId)} 輸了! ・ 房主可按「再來一場」`);
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
    if (g.reveal && g.reveal.pending && g.phase !== 'pickLoser') return show('規則建置中…');
  }

  if (g && g.mode === 'roulette') {
    if (state.winnerId) {
      const w = state.players.find((p) => p.id === state.winnerId);
      return show(`🏆 <strong>${esc(w ? w.name : '')}</strong> 獲勝!`);
    }
    if (state.status === 'playing' && g.phase === 'allocating') {
      const readyCount = g.order ? g.order.filter((id) => g.allocReady && g.allocReady[id]).length : 0;
      return show(`🎯 分配特殊功能中… (${readyCount}/${(g.order || []).length} 已確認)`);
    }
    if (state.status === 'playing' && g.phase === 'playing') {
      const curId = (g.order || [])[g.turnIndex];
      const isMy = curId === myId;
      const range = g.bustRange || {};
      const danger = g.total >= (range.max || 99) ? ' danger'
        : g.total >= (range.min || 99) ? ' warn' : '';
      const rangeHint = range.min ? ` <small>(${range.min}~${range.max})</small>` : '';
      const lastInfo = g.lastRoll ? ` ・ ⚡ <span class="hl">${nm(g.lastRoll.playerId)}</span> 自動骰 ${g.lastRoll.value}` : '';
      const dirIcon = g.direction === -1 ? ' 🔄' : '';
      return show(
        `<span class="roulette-total${danger}">累計 <strong>${g.total}</strong> / ???${rangeHint}</span>${dirIcon}`
        + (g.autoRolling ? lastInfo : (isMy ? ' ・ 👉 <strong>輪到你!</strong>' : ` ・ ⏳ 等待 <span class="hl">${nm(curId)}</span> 行動…`)),
      );
    }
    if (g.bustPlayer) {
      return show(`💥 <span class="hl">${nm(g.bustPlayer)}</span> 爆了!(累計 ${g.total} > ${g.bustThreshold})`);
    }
    el.style.display = 'none'; el.innerHTML = '';
    return;
  }

  if (g && g.mode === 'blackjack21') {
    if (state.winnerId) {
      const w = state.players.find((p) => p.id === state.winnerId);
      return show(`🏆 <strong>${esc(w ? w.name : '')}</strong> 獲勝!`);
    }
    if (state.status === 'playing' && g.phase === 'rolling') {
      const curId = (g.order || [])[g.turnIndex];
      const isMy = curId === myId;
      const myTotal = g.myTotal ?? 0;
      const pct = Math.min(100, Math.round((myTotal / 21) * 100));
      const danger = pct >= 80 ? ' danger' : pct >= 60 ? ' warn' : '';
      const totalHtml = g.myDice && g.myDice.length
        ? `<span class="roulette-total${danger}">你的點數 <strong>${myTotal}</strong> / 21</span> ・ `
        : '';
      return show(
        totalHtml
        + (isMy ? '👉 <strong>輪到你!</strong> 要牌或停牌' : `⏳ 等待 <span class="hl">${nm(curId)}</span> 行動…`),
      );
    }
    if (g.reveal && g.reveal.losers) {
      const loserNames = g.reveal.losers.map((id) => `<span class="hl">${nm(id)}</span>`).join('、');
      return show(`💀 ${loserNames} 輸了!`);
    }
    if (g.phase === 'reveal') return show('🃏 <strong>開牌!</strong> 比較各家點數中…');
    el.style.display = 'none'; el.innerHTML = '';
    return;
  }

  if (state.winnerId) {
    const w = state.players.find((p) => p.id === state.winnerId);
    el.innerHTML = `🏆 <strong>${esc(w ? w.name : '')}</strong> 獲勝!`;
    el.style.display = '';
    return;
  }
  if (g && g.mode === 'speed') {
    if (g.phase === 'countdown') {
      return show('<span class="speed-count" id="speedCount">準備…</span>');
    }
    if (g.phase === 'racing') {
      const done = (g.done || []).includes(myId);
      return show(`🎯 湊出剛好 <strong>${esc(g.targetLabel || '')}</strong> `
        + `・ <span class="speed-clock" id="speedClock">⏱️ --</span>`
        + (done ? ' ・ <span class="hl">✅ 你已安全</span>' : ''));
    }
    if (g.reveal) {
      const nmL = (id) => { const p = state.players.find((x) => x.id === id); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; };
      const losers = (g.reveal.losers || []).map(nmL).join('、');
      return show(losers ? `⏱️ 結束! ・ 💀 ${losers} 輸了!` : '⏱️ 結束!無人落敗');
    }
    el.style.display = 'none'; el.innerHTML = '';
    return;
  }

  // 純搖骰:擲骰進度(全搖完 / 結果階段維持原行為 → 隱藏)
  if (g && g.mode === 'roll') {
    if (state.status === 'playing' && g.phase === 'rolling') {
      const done = (g.rolled || []).length;
      const total = state.players.length;
      if (done < total) return show(`🎲 擲骰中… (<strong>${done}/${total}</strong> 已搖完)`);
    }
    el.style.display = 'none'; el.innerHTML = '';
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
      const grabber = g.reveal.grabberId ? (() => { const p = state.players.find((x) => x.id === g.reveal.grabberId); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; })() : '';
      if (g.phase === 'pickLoser') {
        const grabMsg = grabber ? ` (${grabber} 抓的)` : '';
        return show(state.you.isHost ? `👇 請選出本輪輸家${grabMsg}` : `⏳ 等待房主選出輸家…${grabMsg}`);
      }
      const nmL = (id) => { const p = state.players.find((x) => x.id === id); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; };
      if ((g.reveal.losers || []).length) return show(`✊ ${grabber ? `${grabber} 開盅!` : '開盅!'} ・ 💀 ${nmL(g.reveal.losers[0])} 輸了!`);
      return show(grabber ? `✊ ${grabber} 開盅!` : '✊ 開盅!');
    }
  }
  el.style.display = 'none';
  el.innerHTML = '';
}

// 把一手骰子整理成各點數統計字串(只列出現的點數),例:⚀×2 ⚂×1 ⚄×2
const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
function pipCountSummary(dice) {
  const cnt = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) if (d >= 1 && d <= 6) cnt[d]++;
  const parts = [];
  for (let v = 1; v <= 6; v++) {
    if (cnt[v]) parts.push(`<span class="pip-stat"><b>${DIE_FACES[v]}</b>×${cnt[v]}</span>`);
  }
  return parts.join('');
}

function renderBoard() {
  const board = $('board');
  const g = state.game;
  if (!g) { board.innerHTML = '<p class="muted center-pad">選擇模式後開始遊戲 🎲</p>'; return; }

  // 按住搖骰:放開後結果已回 → 停止轉動,讓正常渲染收尾(滾到最終點數)
  if (rollSpin.committing) {
    if (rollSpin.kind === 'reroll') {
      // 話胚重骰:server 帶回新的 lastRoll(我這手、序號變了)就算完成
      const lr = g.reveal && g.reveal.lastRoll;
      if (lr && lr.id === myId && lr.seq !== lastRollSeq) stopRollSpin();
    } else if (myRollRegistered()) {
      stopRollSpin();
    }
  }

  // 話胚:初次一次開全部牌 → 靜態(不轉動);之後(重骰)點數變動才滾動
  const pokerReveal = !!(g.reveal && g.reveal.subGame === 'poker');
  const pokerInitial = pokerReveal && !pokerStaticDone;
  // 我是否為可重骰者(最小者)→ 可鎖定自己的骰子
  const iCanReroll = pokerReveal && g.phase === 'pokerCompare'
    && (g.reveal.lowestIds || []).includes(myId);
  // 剛輪到我(成為最小者)→ 播提示音(重骰動畫期間先不切換/不響,等動畫後)
  if (!pokerRerollAnim) {
    if (iCanReroll && !wasLowest) playAlert();
    wasLowest = iCanReroll;
  }
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

  // 純搖骰:算出目前最高總和(用來標記領先者)
  let rollMaxSum = -1;
  if (g.mode === 'roll' && g.rolls) {
    for (const p of ordered) {
      const d = g.rolls[p.id];
      if (d) rollMaxSum = Math.max(rollMaxSum, d.reduce((a, b) => a + b, 0));
    }
  }

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

    // 話胚:牌型最小者加外框(重骰動畫期間先不切換,維持前一個最小者)
    const lowPoker = g.mode === 'mixed' && g.reveal && g.reveal.subGame === 'poker'
      && (g.reveal.lowestIds || []).includes(p.id);
    if (!pokerRerollAnim) cell.classList.toggle('lowest', !!lowPoker);
    cell.classList.toggle('deciding', p.id === decidingId); // 正在等他決定 → 外框

    if (g.mode === 'roll') {
      const dice = g.rolls[p.id];
      if (dice) {
        const sig = dice.join(',');
        showDice(stage, 'cell-' + p.id, dice);
        const sum = dice.reduce((a, b) => a + b, 0);
        const lead = sum === rollMaxSum && rollMaxSum > 0;
        const settled = rollSettled[p.id] === sig;
        // 一律放入總和膠囊(保留空間,框框大小不變);動畫未停前用 visibility 隱形
        const hide = settled ? '' : ' style="visibility:hidden"';
        info.innerHTML = `<span class="sum-pill${lead ? ' lead' : ''}"${hide}>${lead ? '🥇 ' : ''}總和 ${sum}</span>`;
        if (!settled && rollPending[p.id] !== sig) {
          rollPending[p.id] = sig;
          setTimeout(() => { rollSettled[p.id] = sig; if (state) scheduleRender(); }, 1500);
        }
      } else {
        stage.innerHTML = '<div class="waiting">尚未搖骰</div>';
        info.textContent = '';
        diceCache.delete('cell-' + p.id);
        delete rollSettled[p.id];
        delete rollPending[p.id];
      }
    } else if (g.mode === 'liars') {
      const reveal = g.reveal;
      if (reveal) {
        // 開盅:所有人靜態亮點數(CSS3D,無動畫)
        if (reveal.hands[p.id]) {
          showDice(stage, 'cell-' + p.id, reveal.hands[p.id], false, true);
          info.innerHTML = pipCountSummary(reveal.hands[p.id]);             // 開盅後:各家點數統計
        } else {
          stage.innerHTML = '<div class="waiting">未搖骰</div>';
          diceCache.delete('cell-' + p.id);
          info.textContent = '';
        }
      } else {
        // 抓之前:只有自己這格,用骰盅(蓋著待命 → 搖完掀蓋亮自己的點)
        const count = (g.myDice && g.myDice.length) ? g.myDice.length : (g.diceLeft ? (g.diceLeft[p.id] || 0) : 0);
        const cup = getCup(stage, 'cell-' + p.id, count);
        if (g.myDice && g.myDice.length) {
          const sig = g.myDice.join(',');
          if (cup.handSig !== sig) {                 // 新的一手:首次掀蓋動畫
            cup.handSig = sig; cup.peeked = false;
            cup.renderer.reveal(g.myDice);
          } else if (cup.peeked) {                   // 使用者把盅蓋回去了
            cup.renderer.cover();
          } else {
            cup.renderer.setStatic(g.myDice);        // 純重繪 / 再打開:不重播翻滾
          }
          // 統計區跟著盅的開合:蓋著時隱形(保留高度避免版面跳動),打開時才顯示
          info.innerHTML = pipCountSummary(g.myDice);
          const syncInfo = () => { info.style.visibility = cup.peeked ? 'hidden' : 'visible'; };
          syncInfo();
          // 開盅後:點骰子區域可暫時蓋回 / 再打開(反覆),純前端視覺
          stage.style.cursor = 'pointer';
          stage.title = '點一下蓋回 / 打開';
          stage.onclick = () => {
            cup.peeked = !cup.peeked;
            if (cup.peeked) cup.renderer.cover(); else cup.renderer.setStatic(g.myDice);
            syncInfo();
          };
        } else {
          cup.renderer.cover();        // 尚未搖:盅蓋著待命
          cup.handSig = null; cup.peeked = false;
          stage.onclick = null; stage.style.cursor = ''; stage.title = '';
          info.textContent = ''; info.style.visibility = 'visible';
        }
      }
    } else if (g.mode === 'roulette') {
      const curId = (g.order || [])[g.turnIndex];
      cell.classList.toggle('deciding', p.id === curId && g.phase === 'playing');
      // 生命顯示（單局模式 startLives=0 不顯示生命、不灰掉）
      const singleRound = state.rouletteLives === 0;
      const lives = (g.lives && g.lives[p.id]) || 0;
      const hearts = singleRound ? '' : (lives > 0 ? '❤️'.repeat(lives) : '💀');
      cell.querySelector('.cell-name').innerHTML =
        (p.id === state.hostId ? '👑 ' : '') + esc(p.name) + (p.id === myId ? ' (你)' : '') + (hearts ? ` <span class="roulette-lives">${hearts}</span>` : '');
      cell.classList.toggle('eliminated', !singleRound && lives <= 0);

      if (g.lastRoll && g.lastRoll.playerId === p.id) {
        showDice(stage, 'cell-' + p.id, [g.lastRoll.value]);
      } else {
        stage.innerHTML = '';
        diceCache.delete('cell-' + p.id);
      }
      // 最近動作
      if (g.phase === 'allocating') {
        info.textContent = g.allocReady && g.allocReady[p.id] ? '✅ 已確認' : '⏳ 分配中…';
      } else {
        const last = [...(g.history || [])].reverse().find((h) => h.playerId === p.id);
        info.textContent = '';
      }
    } else if (g.mode === 'blackjack21') {
      const curId = (g.order || [])[g.turnIndex];
      cell.classList.toggle('deciding', p.id === curId && g.phase === 'rolling');
      // 生命顯示（單局模式 startLives=0 不顯示生命、不灰掉）
      const singleRound = state.blackjackLives === 0;
      const lives = (g.lives && g.lives[p.id]) || 0;
      const hearts = singleRound ? '' : (lives > 0 ? '❤️'.repeat(lives) : '💀');
      cell.querySelector('.cell-name').innerHTML =
        (p.id === state.hostId ? '👑 ' : '') + esc(p.name) + (p.id === myId ? ' (你)' : '') + (hearts ? ` <span class="roulette-lives">${hearts}</span>` : '');
      cell.classList.toggle('eliminated', !singleRound && lives <= 0);

      const hand = g.hands && g.hands[p.id];
      if (!hand) { stage.innerHTML = ''; info.textContent = ''; }
      else if (g.phase === 'rolling') {
        if (p.id === myId && g.myDice && g.myDice.length) {
          const newCount = g.myDice.length;
          if (bjMyDiceCount > 0 && newCount > bjMyDiceCount) {
            const rollIdx = Array.from({ length: newCount - bjMyDiceCount }, (_, i) => bjMyDiceCount + i);
            showDice(stage, 'cell-' + p.id, g.myDice, false, false, rollIdx);
          } else {
            showDice(stage, 'cell-' + p.id, g.myDice);
          }
          bjMyDiceCount = newCount;
          info.textContent = `點數 ${g.myTotal}`;
        } else if (hand.diceCount > 0) {
          showDice(stage, 'cell-' + p.id, Array(hand.diceCount).fill(0), true);
          info.textContent = hand.done ? '已停牌' : `${hand.diceCount} 顆骰`;
        } else {
          stage.innerHTML = '';
          diceCache.delete('cell-' + p.id);
          info.textContent = '';
        }
      } else {
        // reveal / roundEnd: 全部翻開
        bjMyDiceCount = 0;
        if (hand.dice && hand.dice.length) {
          showDice(stage, 'cell-' + p.id, hand.dice, false, true);
          info.textContent = (hand.bust ? '💥 爆了! ' : '') + `點數 ${hand.total} ・ ${hand.dice.length} 顆`;
        } else {
          stage.innerHTML = '';
          info.textContent = '';
        }
      }
    } else if (g.mode === 'speed') {
      const done = g.done || [];
      const isDone = done.includes(p.id);
      const rank = isDone ? done.indexOf(p.id) + 1 : 0;
      const ended = g.phase === 'roundEnd';
      const isLoser = ended && g.reveal && (g.reveal.losers || []).includes(p.id);
      cell.classList.toggle('done-safe', isDone && !ended && !(p.id === myId && speedRolling));
      const singleRound = state.speedLives === 0;
      const lives = (g.lives && g.lives[p.id]) || 0;
      const hearts = singleRound ? '' : (lives > 0 ? '❤️'.repeat(lives) : '💀');
      cell.querySelector('.cell-name').innerHTML =
        (p.id === state.hostId ? '👑 ' : '') + esc(p.name) + (p.id === myId ? ' (你)' : '') + (hearts ? ` <span class="roulette-lives">${hearts}</span>` : '');
      cell.classList.toggle('eliminated', isLoser || (!singleRound && lives <= 0));

      if (g.phase === 'countdown') {
        stage.innerHTML = '<div class="waiting">準備…</div>';
        diceCache.delete('cell-' + p.id);
        info.textContent = '';
        if (p.id === myId) { speedLastMyRolls = 0; speedLastRolls = {}; speedRollReadyAt = 0; speedRolling = false; clearTimeout(speedRollingTimer); } // 新一局:重置
      } else if (p.id === myId) {
        // 自己:活骰 / 結束攤開;偵測「剛搖完」播動畫 + 延遲達標顯示
        const dice = g.myDice || [];
        if (dice.length) {
          const myRolls = (g.rolls && g.rolls[myId]) || 0;
          if (myRolls !== speedLastMyRolls) {
            const lockedSet = new Set(g.myLocked || []);
            const rollIdx = dice.map((_, i) => i).filter((i) => !lockedSet.has(i));
            showDice(stage, 'cell-' + p.id, dice, false, false, rollIdx);
            speedLastMyRolls = myRolls;
            speedRolling = true;
            clearTimeout(speedRollingTimer);
            speedRollingTimer = setTimeout(() => { speedRolling = false; scheduleRender(); }, 1500);
          } else {
            showDice(stage, 'cell-' + p.id, dice, false, true);
          }
          applyLockUI(stage, g.myLocked || [], g.phase === 'racing' && !isDone);
        }
        const showDone = isDone && !speedRolling;
        cell.classList.toggle('done-safe', showDone && !ended);
        if (ended && !speedRolling) {
          info.innerHTML = isDone
            ? `<span class="speed-badge ok">✅ 已達標 #${rank}</span>`
            : (isLoser ? '<span class="speed-badge lose">💀 沒達標</span>'
              : '<span class="speed-badge go">⏳ 搶骰中</span>');
        } else {
          info.innerHTML = showDone
            ? `<span class="speed-badge ok">✅ 安全 #${rank}</span>`
            : '<span class="speed-badge go">⏳ 搶骰中</span>';
        }
      } else {
        // 他人:racing 即時顯示其骰子(他人剛搖完時播滾動動畫);結束後全員攤開
        const dice = (g.dice && g.dice[p.id]) || [];
        if (dice.length) {
          const theirRolls = (g.rolls && g.rolls[p.id]) || 0;
          if (!ended && theirRolls !== (speedLastRolls[p.id] || 0)) {
            const lockedSet = new Set((g.locked && g.locked[p.id]) || []);
            const rollIdx = dice.map((_, i) => i).filter((i) => !lockedSet.has(i));
            showDice(stage, 'cell-' + p.id, dice, false, false, rollIdx);
            speedLastRolls[p.id] = theirRolls;
          } else {
            showDice(stage, 'cell-' + p.id, dice, false, true);
          }
        } else {
          stage.innerHTML = '';
          diceCache.delete('cell-' + p.id);
        }
        info.innerHTML = isDone
          ? `<span class="speed-badge ok">✅ 已達標 #${rank}</span>`
          : (isLoser ? '<span class="speed-badge lose">💀 沒達標</span>'
            : '<span class="speed-badge go">⏳ 搶骰中</span>');
      }
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
        markRemovedDice(stage, reveal.removedIdx && reveal.removedIdx[p.id]); // 要被拿掉的畫叉叉(索引來自後端)
        // 話胚:鎖定顯示給所有人看;只有「輪到我」時我的骰子可點選切換(重骰動畫期間先不更新)
        if (reveal.subGame === 'poker' && !pokerRerollAnim) {
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
        // 重骰動畫期間維持前一個牌型/最小標記,等動畫停了再更新
        if (!pokerRerollAnim) info.textContent = (reveal.ranks[p.id] || '') + (lowPoker ? ' ⚠️ 最小' : '');
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

  // 話胚開牌:偵測鐵支/豹子 → 播特效(只在初次開牌或重骰者自己骰出時播一次)
  if (pokerReveal && g.reveal.ranks && !pokerRerollAnim) {
    const rerollerId = lastRoll && lastRoll.id;
    const isAfterReroll = !pokerInitial && !isNewRoll && rerollerId;
    let bestRank = '';
    let bestLabel = '';
    for (const id of Object.keys(g.reveal.ranks)) {
      if (isAfterReroll && id !== rerollerId) continue;
      const r = g.reveal.ranks[id];
      if (r && r.endsWith('豹子')) { bestRank = 'leopard'; bestLabel = r; break; }
      if (r === '鐵支' && bestRank !== 'leopard') { bestRank = 'iron'; bestLabel = r; }
    }
    const fxKey = bestRank + ':' + (isAfterReroll ? rerollerId : 'init');
    if (bestRank && fxKey !== lastHandFxKey) {
      lastHandFxKey = fxKey;
      if (bestRank === 'leopard') playLeopardFx(bestLabel);
      else playIronFx();
    }
    if (!bestRank && !isAfterReroll) lastHandFxKey = '';
  } else if (!pokerReveal) {
    lastHandFxKey = '';
  }

  // 初次靜態開牌完成後,後續話胚點數變動(重骰)就改用滾動;離開話胚則重置
  pokerStaticDone = pokerReveal;
  if (isNewRoll) lastRollSeq = lastRoll.seq; // 標記本次重骰動畫已播放
}

let controlsHtmlCache = null; // controls 最終 html 簽章:沒變就跳過 innerHTML 與重綁
function renderControls() {
  const el = $('controls');
  const g = state.game;
  // 內容沒變 → 跳過 innerHTML 重建與重綁(回傳 false);有變才寫入並更新快取
  const setControls = (html) => {
    if (html === controlsHtmlCache) return false;
    el.innerHTML = html;
    controlsHtmlCache = html;
    return true;
  };
  // 預設視為「有動作條內容」(手機直向會把 #controls 固定到底部);房主大廳分支會關掉
  document.body.classList.add('has-bottom-controls');
  if (state.you.isAway) {
    el.style.display = '';
    if (setControls('<p class="muted">💤 你被移到暫離觀戰區</p>'
      + '<button id="imback">🙋 我回來了</button>')) {
      $('imback')?.addEventListener('click', () => act('imBack', {}));
    }
    return;
  }
  if (state.you.isSpectator) {
    el.style.display = '';
    setControls('<p class="muted">👀 觀戰中,下一輪開始時自動加入</p>');
    return;
  }
  // 非進行中(大廳/回合結束):房主用 lobby panel;非房主在 controls 顯示等待字樣
  if (!g || state.status !== 'playing') {
    if (state.you.isHost) {
      el.style.display = 'none';
      setControls('');
      document.body.classList.remove('has-bottom-controls'); // 房主大廳:無動作條
    } else {
      const h = state.players.find((p) => p.id === state.hostId);
      el.style.display = '';
      setControls(`<p class="muted">等待房主 ${esc(h ? h.name : '')} 選擇模式並開始…</p>`);
    }
    return;
  }
  el.style.display = '';

  if (g.mode === 'roll' && state.status === 'playing') {
    const rolled = g.rolls[myId];
    setControls(rolled
      ? '<p class="muted">已搖骰,等待其他玩家…</p>'
      : rollBtn('🎲 搖骰!'));
    return; // 搖骰改由「按住→放開」處理(見 pressRoll/releaseRoll)
  }

  if (g.mode === 'roulette' && state.status === 'playing') {
    if (g.phase === 'allocating') {
      const pts = g.abilityPoints || 0;
      const myAlloc = (g.alloc && g.alloc[myId]) || { passes: 0, reverses: 0 };
      const ready = g.allocReady && g.allocReady[myId];
      const readyCount = g.order ? g.order.filter((id) => g.allocReady && g.allocReady[id]).length : 0;
      if (ready) {
        setControls(`<p class="muted">已分配(⏭️${myAlloc.passes} / 🔄${myAlloc.reverses}),等待其他玩家… (${readyCount}/${(g.order || []).length})</p>`);
      } else {
        const p = myAlloc.passes;
        const r = myAlloc.reverses;
        const html = '<div class="alloc-panel">'
          + `<div class="alloc-title">分配特殊功能 (共 ${pts} 點)</div>`
          + '<div class="alloc-row">'
          + `<span>⏭️ 跳過</span>`
          + `<button class="alloc-btn" data-adj="pass-1"${p <= 0 ? ' disabled' : ''}>−</button>`
          + `<span class="alloc-num" id="allocPass">${p}</span>`
          + `<button class="alloc-btn" data-adj="pass+1"${p + r >= pts ? ' disabled' : ''}>+</button>`
          + '</div>'
          + '<div class="alloc-row">'
          + `<span>🔄 迴轉</span>`
          + `<button class="alloc-btn" data-adj="rev-1"${r <= 0 ? ' disabled' : ''}>−</button>`
          + `<span class="alloc-num" id="allocRev">${r}</span>`
          + `<button class="alloc-btn" data-adj="rev+1"${p + r >= pts ? ' disabled' : ''}>+</button>`
          + '</div>'
          + `<button id="allocConfirm"${p + r !== pts ? ' disabled' : ''}>✅ 確認 (${p + r}/${pts})</button>`
          + '</div>';
        if (setControls(html)) {
          el.querySelectorAll('[data-adj]').forEach((btn) => btn.addEventListener('click', () => {
            const a = btn.dataset.adj;
            const gg = state.game;
            const cur = (gg && gg.alloc && gg.alloc[myId]) || { passes: 0, reverses: 0 };
            let np = cur.passes, nr = cur.reverses;
            if (a === 'pass+1' && np + nr < pts) np++;
            else if (a === 'pass-1' && np > 0) np--;
            else if (a === 'rev+1' && np + nr < pts) nr++;
            else if (a === 'rev-1' && nr > 0) nr--;
            else return;
            act('action', { type: 'allocate', passes: np, reverses: nr });
          }));
          $('allocConfirm')?.addEventListener('click', () => {
            const gg = state.game;
            const cur = (gg && gg.alloc && gg.alloc[myId]) || { passes: 0, reverses: 0 };
            act('action', { type: 'allocate', passes: cur.passes, reverses: cur.reverses, confirm: true });
          });
        }
      }
      return;
    }
    if (g.phase === 'playing') {
      if (g.autoRolling) {
        setControls('<p class="muted">⚡ 安全區快速骰…</p>');
      } else {
        const curId = (g.order || [])[g.turnIndex];
        if (curId === myId) {
          const myAlloc = (g.alloc && g.alloc[myId]) || { passes: 0, reverses: 0 };
          const passLeft = myAlloc.passes - ((g.passes && g.passes[myId]) || 0);
          const revLeft = myAlloc.reverses - ((g.reverses && g.reverses[myId]) || 0);
          const passDisabled = passLeft <= 0 ? ' disabled' : '';
          const revDisabled = revLeft <= 0 ? ' disabled' : '';
          const html = '<div class="bid-row roulette-actions">'
            + rollBtn('🎲 搖骰!')
            + `<button id="rouletteReverse" class="secondary"${revDisabled}>🔄迴轉(${Math.max(0, revLeft)})</button>`
            + `<button id="roulettePass" class="secondary"${passDisabled}>⏭️跳過(${Math.max(0, passLeft)})</button>`
            + '</div>';
          if (setControls(html)) {
            $('rouletteReverse')?.addEventListener('click', () => act('action', { type: 'reverse' }));
            $('roulettePass')?.addEventListener('click', () => act('action', { type: 'pass' }));
          }
        } else {
          const nm = state.players.find((x) => x.id === curId);
          setControls(`<p class="muted">等待 <span class="hl">${esc(nm ? nm.name : '')}</span> 搖骰…</p>`);
        }
      }
    } else {
      setControls('<p class="muted">本輪結束,等待房主開下一輪…</p>');
    }
    return;
  }

  if (g.mode === 'blackjack21' && state.status === 'playing') {
    if (g.phase === 'rolling') {
      const curId = (g.order || [])[g.turnIndex];
      const myStood = !!(g.hands && g.hands[myId] && g.hands[myId].done);
      if (curId === myId) {
        const html = '<div class="bid-row">'
          + [1, 2, 3].map(n =>
            `<button class="bj-hit" data-n="${n}">🎲 要${n}顆</button>`
          ).join('')
          + '<button id="bjStand" class="secondary">✋ 停牌</button>'
          + '</div>';
        if (setControls(html)) {
          el.querySelectorAll('.bj-hit').forEach(b => b.addEventListener('click', () => {
            act('action', { type: 'roll', count: Number(b.dataset.n) });
          }));
          $('bjStand')?.addEventListener('click', () => act('action', { type: 'stand' }));
        }
      } else if (myStood) {
        const nm = state.players.find((x) => x.id === curId);
        setControls(`<p class="muted">你已停牌 ・ 等待 <span class="hl">${esc(nm ? nm.name : '')}</span> 行動…</p>`);
      } else if ((g.order || []).includes(myId)) {
        const nm = state.players.find((x) => x.id === curId);
        const html = `<p class="muted">等待 <span class="hl">${esc(nm ? nm.name : '')}</span> 行動…</p>`
          + '<div class="bid-row"><button id="bjStand" class="secondary">✋ 提前停牌</button></div>';
        if (setControls(html)) {
          $('bjStand')?.addEventListener('click', () => act('action', { type: 'stand' }));
        }
      } else {
        const nm = state.players.find((x) => x.id === curId);
        setControls(`<p class="muted">等待 <span class="hl">${esc(nm ? nm.name : '')}</span> 行動…</p>`);
      }
    } else {
      setControls('<p class="muted">本輪結束,等待房主開下一輪…</p>');
    }
    return;
  }

  if (g.mode === 'speed' && state.status === 'playing') {
    if (g.phase === 'countdown') {
      setControls('<p class="muted">⏳ 倒數中…準備搶骰!</p>');
      return;
    }
    if (g.phase === 'racing' || speedRolling) {
      if ((g.done || []).includes(myId) && !speedRolling) {
        setControls('<p class="muted">✅ 你已達標安全!等待其他人…</p>');
      } else if (!(g.done || []).includes(myId) || speedRolling) {
        const first = !((g.myDice || []).length);
        const wait = Math.max(0, speedRollReadyAt - Date.now());
        const onCd = wait > 0;
        const label = onCd ? `⏳ ${(wait / 1000).toFixed(1)}s` : `🎲 ${first ? '搖骰!' : '重骰(未鎖的)'}`;
        const html = '<div class="bid-row">'
          + `<button id="speedReroll"${onCd ? ' disabled' : ''}>${label}</button>`
          + '</div>' + `<p class="hint muted"${first ? ' style="visibility:hidden"' : ''}>點骰子可鎖定不重骰</p>`;
        if (setControls(html)) {
          $('speedReroll')?.addEventListener('click', () => {
            if (Date.now() < speedRollReadyAt) return;
            speedRollReadyAt = Date.now() + 1000;            // 樂觀冷卻;以伺服器回應為準
            act('action', { type: 'reroll' }).then((res) => {
              // 伺服器拒絕(冷卻未到)→ 以伺服器剩餘時間校正
              if (res && res.cooldown && res.retryMs) speedRollReadyAt = Date.now() + res.retryMs;
            });
            scheduleSpeedCooldownRender();
          });
        }
      }
    } else {
      setControls('<p class="muted">本局結束,等待房主開下一局…</p>');
    }
    return;
  }

  if (g.mode === 'liars' && state.status === 'playing' && g.phase === 'pickLoser') {
    if (state.you.isHost) {
      const btns = (g.order || []).map((id) => {
        const p = state.players.find((x) => x.id === id);
        return `<button class="chip pick-loser-btn" data-pid="${id}">${esc(p ? p.name : id)}</button>`;
      }).join('');
      if (setControls(`<div class="mode-btns">${btns}</div>`)) {
        el.querySelectorAll('.pick-loser-btn').forEach((b) =>
          b.addEventListener('click', () => act('action', { type: 'pickLoser', targetId: b.dataset.pid }))
        );
      }
    } else {
      setControls('<p class="muted">等待房主選出輸家…</p>');
    }
    return;
  }

  if (g.mode === 'liars' && state.status === 'playing' && g.phase === 'rolling') {
    const rolled = (g.rolled || []).includes(myId);
    const allRolled = (g.order || []).length > 0 && (g.rolled || []).length === g.order.length;
    const html = '<div class="bid-row">'
      + (rolled
        ? `<span class="muted">${allRolled ? '全員已搖完' : '已搖骰,等待其他人…'}</span>`
        : '<button id="roll" title="按住搖、放開定">🎲 搖骰!</button>')
      + (allRolled ? '<button id="grab" class="secondary">✊ 抓(開盅)!</button>' : '')
      + '</div>';
    if (setControls(html)) {
      $('grab')?.addEventListener('click', () => act('action', { type: 'grab' }));
    }
    return;
  }

  if (g.mode === 'mixed' && state.status === 'playing') {
    if (g.phase === 'rolling' || g.phase === 'reveal') {
      const rolled = g.phase === 'rolling' && (g.rolled || []).includes(myId);
      const label = g.phase === 'reveal' ? '🎲 搖下一骰!' : '🎲 搖骰!';
      setControls(rolled
        ? '<p class="muted">已搖骰,等待其他人…</p>'
        : rollBtn(label));
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
        const html = '<div class="bid-row">'
          + `<button id="reroll"${canAfford ? '' : ' disabled'} title="按住不放,放開才重骰">🎲 重骰 (剩 ${left}${costNote})</button>`
          + '<button id="concede" class="secondary">🏳️ 認輸</button>'
          + '</div>';
        // 重骰改由「按住→放開」處理(見 pressRoll/releaseRoll),與一般搖骰一致;次數不足時按鈕 disabled
        if (setControls(html)) {
          $('concede')?.addEventListener('click', () => act('action', { type: 'concede' }));
        }
      } else {
        const names = low.map((id) => { const p = state.players.find((x) => x.id === id); return p ? `<span class="hl">${esc(p.name)}</span>` : ''; }).join('、');
        setControls(`<p class="muted">等待 ${names} 重骰或認輸…</p>`);
      }
      return;
    }
    if (g.phase === 'pickLoser') {
      if (state.you.isHost) {
        const btns = (g.order || []).map((id) => {
          const p = state.players.find((x) => x.id === id);
          return `<button class="chip pick-loser-btn" data-pid="${id}">${esc(p ? p.name : id)}</button>`;
        }).join('');
        if (setControls(`<div class="mode-btns">${btns}</div>`)) {
          el.querySelectorAll('.pick-loser-btn').forEach((b) =>
            b.addEventListener('click', () => act('action', { type: 'pickLoser', targetId: b.dataset.pid }))
          );
        }
      } else {
        setControls('<p class="muted">等待房主選出輸家…</p>');
      }
      return;
    }
    if (g.phase === 'bluffReady') {
      const allRolled = (g.order || []).length > 0 && (g.rolled || []).length === g.order.length;
      const html = '<div class="bid-row"><span class="muted">全員已搖完</span>'
        + (allRolled ? '<button id="grab" class="secondary">✊ 抓(開盅)!</button>' : '')
        + '</div>';
      if (setControls(html)) {
        $('grab')?.addEventListener('click', () => act('action', { type: 'grab' }));
      }
      return;
    }
    if (g.phase === 'choosing') {
      // 提示文字已在 banner 顯示;這裡只放按鈕,不是決定者則留空
      if (g.decider && g.decider !== myId) { setControls(''); return; }
      const html = `<div class="mode-btns">`
        + (g.subGames || []).map((s) => `<button class="chip" data-sub="${s.id}">${esc(s.name)}</button>`).join('')
        + `</div>`;
      if (setControls(html)) {
        el.querySelectorAll('[data-sub]').forEach((b) =>
          b.addEventListener('click', () => act('action', { type: 'chooseSubGame', subGame: b.dataset.sub }))
        );
      }
      return;
    }
    if (g.phase === 'condition') {
      // 提示/等待文字已在 banner 顯示;這裡只放按鈕,不是決定者則留空
      const canPick = g.openPick || g.chooserId === myId;
      if (!canPick) { setControls(''); return; }
      const opts = [['red', '紅的拿掉'], ['black', '黑的拿掉'], ['odd', '單數拿掉'], ['even', '雙數拿掉'], ['big', '大的拿掉'], ['small', '小的拿掉']];
      const html = `<div class="mode-btns">`
        + opts.map(([id, label]) => `<button class="chip" data-cond="${id}">${label}</button>`).join('')
        + `</div>`;
      if (setControls(html)) {
        el.querySelectorAll('[data-cond]').forEach((b) =>
          b.addEventListener('click', () => act('action', { type: 'chooseCondition', condition: b.dataset.cond }))
        );
      }
      return;
    }
  }

  setControls('<p class="muted">等待中…</p>');
}

// ---- helpers ----
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- 21 點骰:玩家選擇要牌顆數 ----
let bjHitCount = 1;
let bjMyDiceCount = 0;
let bj21Shown = false; // 21 點骰:本局開牌時是否已為「剛好 21 點」播過特效(每局一次)

// ---- 按住搖骰:按住時骰子一直轉,放開才送出搖骰並停在結果 ----
const rollSpin = { active: false, committing: false, timer: null, seqAtPress: -1 };
function rollDiceCount() {
  const g = state && state.game; if (!g) return 0;
  if (g.mode === 'roll') return g.diceCount || 3;
  if (g.mode === 'roulette') return 1;
  if (g.mode === 'blackjack21') return bjHitCount || 1;
  return (g.diceLeft && g.diceLeft[myId]) || 0;
}
function myRollRegistered() {
  const g = state && state.game; if (!g) return true;
  if (g.mode === 'roll') return !!(g.rolls && g.rolls[myId]);
  if (g.mode === 'roulette') return g.autoRolling || g.phase !== 'playing' || (g.order || [])[g.turnIndex] !== myId;
  if (g.mode === 'blackjack21') return g.phase !== 'rolling' || (g.actionSeq || 0) !== rollSpin.seqAtPress;
  return (g.rolled || []).includes(myId);
}
function canRollNow() {
  const btn = document.getElementById('roll'); // 各模式的搖骰/搖下一骰按鈕
  return !!(btn && !btn.disabled);
}
function canRerollNow() {
  const btn = document.getElementById('reroll'); // 話胚重骰(次數不足時 disabled)
  return !!(btn && !btn.disabled);
}
function pressRoll(kind = 'roll') {
  if (rollSpin.active) return;
  if (kind === 'reroll' ? !canRerollNow() : !canRollNow()) return;
  rollSpin.active = true; rollSpin.committing = false; rollSpin.kind = kind;
  const g0 = state && state.game;
  rollSpin.seqAtPress = (g0 && g0.actionSeq) || 0;
  document.getElementById(kind === 'reroll' ? 'reroll' : 'roll')?.classList.add('charging'); // 蓄力視覺
  const cell = document.querySelector(`#board [data-pid="${myId}"]`);
  const stage = cell && cell.querySelector('.dice-stage');

  if (kind === 'reroll') {
    // 話胚重骰:只轉「沒被鎖定」的骰子,鎖定的保留原點數(與 server 重骰一致)
    const g = state && state.game;
    const cur = (g && g.reveal && g.reveal.hands && g.reveal.hands[myId]) || [];
    const locked = new Set((g && g.reveal && g.reveal.lockBy === myId) ? (g.reveal.locked || []) : []);
    if (!stage || !cur.length) return; // 找不到也沒關係,放開時仍會送出
    const spin = () => {
      const idx = [];
      const vals = cur.map((v, i) => { if (locked.has(i)) return v; idx.push(i); return 1 + Math.floor(Math.random() * 6); });
      if (idx.length) showDice(stage, 'cell-' + myId, vals, false, false, idx); // 強制滾動非鎖定骰
      playRattle(400);
    };
    spin();
    rollSpin.timer = setInterval(spin, 360);
    return;
  }

  const count = rollDiceCount();
  if (!stage || !count) return; // 找不到也沒關係,放開時仍會送出

  // 吹牛骰「抓」之前:用骰盅蓋著抖(放開後 renderBoard 收到 myDice 才掀蓋亮點)
  if (isLiarsSolo()) {
    const cup = getCup(stage, 'cell-' + myId, count);
    cup.handSig = null; cup.peeked = false;
    cup.renderer.shake();
    playRattle(400);
    rollSpin.timer = setInterval(() => playRattle(400), 360);
    return;
  }

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
  const isReroll = rollSpin.kind === 'reroll';
  if (isReroll ? !canRerollNow() : !canRollNow()) { stopRollSpin(); render(); return; }
  const actionPayload = { type: isReroll ? 'reroll' : 'roll' };
  if (state?.game?.mode === 'blackjack21') actionPayload.count = bjHitCount || 1;
  emit('action', actionPayload).then((res) => {
    if (res && res.error) { toast(res.error); stopRollSpin(); render(); }
    // 成功 → 等 roomState 廣播,在 renderBoard 收尾停住
  });
}
function stopRollSpin() {
  if (rollSpin.timer) { clearInterval(rollSpin.timer); rollSpin.timer = null; }
  rollSpin.active = false; rollSpin.committing = false;
  document.getElementById('roll')?.classList.remove('charging');
  document.getElementById('reroll')?.classList.remove('charging');
}

// 滑鼠/觸控按住搖骰鈕(一般搖骰 + 話胚重骰)
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('#roll')) { e.preventDefault(); pressRoll('roll'); }
  else if (e.target.closest('#reroll')) { e.preventDefault(); pressRoll('reroll'); }
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
  if (canRollNow()) { e.preventDefault(); pressRoll('roll'); }
  else if (canRerollNow()) { e.preventDefault(); pressRoll('reroll'); }
});
document.addEventListener('keyup', (e) => { if (isSpace(e)) releaseRoll(); });

// ---- 頂部按鈕 ----
// 手機直向:☰ 切換 room-top 動作下拉選單;點選單外自動收起
$('menuToggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.querySelector('.room-top')?.classList.toggle('menu-open');
});
document.addEventListener('click', (e) => {
  const rt = document.querySelector('.room-top');
  if (rt && rt.classList.contains('menu-open') && !e.target.closest('.room-top')) rt.classList.remove('menu-open');
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(code); toast('已複製房號 ' + code, 'success'); }
  catch { toast('房號:' + code, 'info'); }
});
// 分享房間 QR Code:把「首頁帶房號」網址畫成 QR,他人掃描後自動填好房號,只需輸入暱稱
function drawQr(text) {
  const canvas = $('qrCanvas');
  const matrix = makeQrMatrix(text);
  const n = matrix.length;
  const quiet = 4;                       // QR 規格建議的留白邊框
  const total = n + quiet * 2;
  const px = Math.max(1, Math.floor(canvas.width / total));
  const size = (total) * px;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (matrix[y][x]) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
}
function openQr() {
  const url = `${location.origin}/?code=${encodeURIComponent(code)}`;
  $('qrCode').textContent = code;
  $('qrUrl').textContent = url;
  try { drawQr(url); }
  catch { toast('產生 QR 失敗', 'error'); return; }
  $('qrOverlay').style.display = 'flex';
}
function closeQr() { $('qrOverlay').style.display = 'none'; }
$('shareQr').addEventListener('click', () => {
  document.querySelector('.room-top')?.classList.remove('menu-open'); // 收起手機選單
  openQr();
});
$('qrClose').addEventListener('click', closeQr);
$('qrOverlay').addEventListener('click', (e) => { if (e.target === $('qrOverlay')) closeQr(); });

$('leave').addEventListener('click', async () => {
  // 遊戲進行中 → 先確認才離開;非遊戲中維持直接離開
  if (state?.status === 'playing' && !(await uiConfirm('遊戲進行中,確定要離開房間嗎?'))) return;
  await emit('leaveRoom', {});
  clearSession();
  location.href = '/';
});
$('forceReset').addEventListener('click', async () => {
  if (await uiConfirm('確定強制重來?目前這場將中止,回到大廳重新開始。')) act('forceReset', {});
});
$('benchSelf').addEventListener('click', async () => {
  const msg = state.you.isHost
    ? '確定暫離?房主會自動轉給下一位,按「我回來了」才會以觀戰身分回歸。'
    : '確定暫離?你會移到暫離觀戰區,按「我回來了」才回歸。';
  if (await uiConfirm(msg)) act('benchSelf', {});
});

// Esc 關閉彈窗:由上往下關閉「目前開著」的第一個(確認框視同取消)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const cf = document.querySelector('.confirm-overlay');
  if (cf) { cf._close(false); return; }
  const qr = $('qrOverlay');
  if (qr && qr.style.display !== 'none') { closeQr(); return; }
  if (pokerRankOpen) { setPokerRankPopup(false); return; }
  if (modeInfoOpen) { setModeInfoPopup(false); return; }
  const sp = $('statsPopup');
  if (sp && sp.style.display !== 'none' && lastStatsKey) { statsDismissedKey = lastStatsKey; sp.style.display = 'none'; return; }
  const wp = $('winnerPopup');
  if (wp && wp.style.display !== 'none' && lastWinnerKey) { winnerDismissedKey = lastWinnerKey; wp.style.display = 'none'; return; }
  const mp = $('milestonePopup');
  if (mp && mp.style.display !== 'none' && lastMilestoneKey) { milestoneDismissed = lastMilestoneKey; mp.style.display = 'none'; return; }
  const lp = $('loserPopup');
  if (lp && lp.style.display !== 'none' && lastLoserKey) { loserDismissedKey = lastLoserKey; lp.style.display = 'none'; return; }
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
// 初始:有偏好就尊重;沒偏好時,手機預設收合(避免懸浮列表遮住骰子格),桌機維持展開
const savedRoster = localStorage.getItem('dice.rosterCollapsed');
const isMobileViewport = window.matchMedia('(max-width: 600px)').matches;
setRosterCollapsed(savedRoster === '1' || (savedRoster === null && isMobileViewport));

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

// ---- 搖手機擲骰(手機):偵測搖晃 → 等同按住搖骰,停下即放開定骰 ----
let shakeRoll = localStorage.getItem('dice.shakeRoll') === '1';
const shakeState = { last: null, idleTimer: null };
const SHAKE_THRESHOLD = 15;   // 相鄰取樣的加速度變化量門檻(越大越需用力)
const SHAKE_STOP_MS = 450;    // 停止搖晃多久後放開定骰
function supportsDeviceMotion() {
  return typeof window.DeviceMotionEvent !== 'undefined' && 'ontouchstart' in window;
}
function onDeviceMotion(e) {
  if (!shakeRoll) return;
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;
  const cur = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
  const prev = shakeState.last;
  shakeState.last = cur;
  if (!prev) return;
  const delta = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) + Math.abs(cur.z - prev.z);
  if (delta < SHAKE_THRESHOLD) return; // 不夠用力,不算搖
  const kind = canRollNow() ? 'roll' : (canRerollNow() ? 'reroll' : null);
  if (!rollSpin.active) { if (!kind) return; pressRoll(kind); } // 開始搖
  if (shakeState.idleTimer) clearTimeout(shakeState.idleTimer);
  shakeState.idleTimer = setTimeout(() => releaseRoll(), SHAKE_STOP_MS); // 停手 → 定骰
}
function addMotionListener() { window.addEventListener('devicemotion', onDeviceMotion); }
function removeMotionListener() { window.removeEventListener('devicemotion', onDeviceMotion); shakeState.last = null; }
if (shakeRoll) addMotionListener();
// iOS 13+ 需在使用者手勢中向 DeviceMotionEvent 申請動作感測權限
async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') { toast('未取得動作感測權限'); return false; }
    } catch { toast('此裝置無法啟用搖晃偵測'); return false; }
  }
  return true;
}
if (supportsDeviceMotion()) $('shakeRollWrap').style.display = '';
$('shakeRoll').checked = shakeRoll;
$('shakeRoll').addEventListener('change', async (e) => {
  if (e.target.checked) {
    const ok = await requestMotionPermission();
    if (!ok) { e.target.checked = false; return; }
    addMotionListener();
  } else {
    removeMotionListener();
  }
  shakeRoll = e.target.checked;
  localStorage.setItem('dice.shakeRoll', shakeRoll ? '1' : '0');
});

