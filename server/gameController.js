// 遊戲流程控制 — 設定模式、開始一輪、分派動作、管理輪次/整場生命週期
import { MODES, MODE_LIST } from './games/index.js';
import { mergeSpectators, ensurePlayers } from './roomManager.js';

export function setMode(room, playerId, modeId) {
  if (room.hostId !== playerId) return { error: '只有房主能設定模式' };
  if (room.status === 'playing') return { error: '遊戲進行中無法更改模式' };
  const mode = MODES[modeId];
  if (!mode) return { error: '未知的模式' };
  const listed = MODE_LIST.find((m) => m.id === modeId);
  if (!listed || !listed.available) return { error: `${mode.name} 尚未開放` };
  room.modeId = modeId;
  // 切換模式重置整場狀態
  room.match = null;
  room.matchOver = false;
  room.round = null;
  room.winnerId = null;
  room.lastLosers = [];      // 清掉上一場輸家,避免「由輸家決定」沿用已中止那場
  room.lastChooserId = null;
  // 吹牛骰起始骰子數預設 5
  if (modeId === 'liars') room.diceCount = 5;
  return { ok: true };
}

export function setDiceCount(room, playerId, n) {
  if (room.hostId !== playerId) return { error: '只有房主能設定' };
  room.diceCount = Math.max(1, Math.min(100, parseInt(n) || 3));
  return { ok: true };
}

// 房主強制重來:中止當前這場,清空回到大廳(防任何環節卡死)
export function forceReset(room, playerId) {
  if (room.hostId !== playerId) return { error: '只有房主能強制重來' };
  room.round = null;
  room.match = null;
  room.matchOver = false;
  room.winnerId = null;
  room.lastLosers = [];      // 強制重來 → 一併清掉上一場輸家/決定者起點
  room.lastChooserId = null;
  room.status = 'lobby';
  return { ok: true };
}

export function startRound(room, playerId) {
  if (room.hostId !== playerId) return { error: '只有房主能開始' };
  if (!room.modeId) return { error: '請先選擇遊戲模式' };
  const mode = MODES[room.modeId];

  // 先確認「正式玩家 + 觀戰者」合計達標,才把觀戰者併入;
  // 否則人數不足時 mergeSpectators 已清空 spectators 卻又回 error,會把觀戰者誤轉為正式玩家。
  if (room.players.length + room.spectators.length < mode.minPlayers) {
    return { error: `此模式至少需要 ${mode.minPlayers} 人` };
  }
  // 觀戰者於每輪開始時併入
  mergeSpectators(room);

  if (mode.id === 'roulette' || mode.id === 'blackjack21') {
    if (!room.match || room.matchOver) {
      const opts = mode.id === 'roulette'
        ? { lives: room.rouletteLives ?? 3, maxPasses: room.roulettePasses ?? 1 }
        : { lives: room.blackjackLives ?? 3 };
      room.match = mode.initMatch(room.players, opts);
      room.matchOver = false;
      room.winnerId = null;
    } else {
      for (const p of room.players) {
        if (room.match.lives[p.id] == null) room.match.lives[p.id] = room.match.startLives;
      }
    }
    room.round = mode.startRound(room.match, room.players);
  } else if (mode.id === 'liars') {
    // 吹牛骰每局獨立(無淘汰)→ 每次開始都用「當前設定」重新發骰,改數量即時生效
    room.match = mode.initMatch(room.players, room.diceCount);
    room.matchOver = false;
    room.winnerId = null;
    room.round = mode.startRound(room.match, room.players);
  } else if (mode.id === 'speed') {
    // 手速骰每局獨立(單局制,不存累計)→ 每次用當前秒數重建,計時器由 index.js 排程
    room.match = mode.initMatch(room.players, { seconds: room.speedSeconds ?? 30 });
    room.matchOver = false;
    room.winnerId = null;
    room.round = mode.startRound(room.match, room.players, Date.now());
  } else if (isMatchMode(mode)) {
    // 混合模式:整場狀態持續(會淘汰失骰),固定從 5 顆開始
    const startDice = mode.startDice || 5;
    if (!room.match || room.matchOver) {
      room.match = mode.initMatch(room.players, startDice);
      room.matchOver = false;
      room.winnerId = null;
    } else {
      // 中途併入的新玩家補發骰子(用本場的起始骰子數)
      const sd = room.match.startDice ?? mode.startDice;
      for (const p of room.players) {
        if (room.match.diceLeft[p.id] == null) room.match.diceLeft[p.id] = sd;
      }
    }
    room.round = mode.startRound(room.match, room.players);
    if (mode.id === 'mixed') {
      room.round.decider = computeDecider(room); // 由輸家決定玩法
      room.round.autoRotate = !!room.autoRotate; // 自動順位(紅黑單雙條件輪流)
    }
  } else if (mode.id === 'roll') {
    room.round = mode.startRound(room.players, { diceCount: room.diceCount });
    room.match = null;
  } else {
    room.round = mode.startRound();
  }

  room.round.hostId = room.hostId; // 供各模式的 pickLoser 驗證
  room.status = 'playing';
  room.lossMilestone = null;
  return { ok: true };
}

export function handleAction(room, player, action) {
  if (room.status !== 'playing' || !room.round) return { error: '現在沒有進行中的回合' };
  const mode = MODES[room.modeId];
  if (room.players.every((p) => p.id !== player.id)) return { error: '觀戰中,下一輪才能參與' };

  let res;
  if (isMatchMode(mode)) {
    res = mode.handleAction(room.round, room.match, player, action, room.players);
  } else {
    res = mode.handleAction(room.round, player, action);
  }
  if (res.error) return res;

  // 回合 / 整場結束判定
  if (mode.id === 'roll') {
    if (mode.isRoundOver(room.round, room.players)) {
      mode.finishRound(room.round, room.players);
      room.status = 'lobby';
    }
  } else if (isMatchMode(mode)) {
    if (room.round.phase === 'roundEnd') {
      // 吹牛骰/輪盤骰:每一輪就計一次「輸的次數」(非整場結束才算)
      if (mode.id === 'liars' || mode.id === 'roulette' || mode.id === 'blackjack21' || mode.id === 'speed') recordRoundLosers(room);
      if (mode.isMatchOver(room.match, room.players)) {
        room.matchOver = true;
        const w = mode.winner(room.match, room.players);
        room.winnerId = w ? w.id : null;
        if (mode.id !== 'liars' && mode.id !== 'roulette' && mode.id !== 'blackjack21') recordLosses(room);
      }
      room.status = 'lobby'; // 等房主開下一輪 / 或整場已結束
    }
  }

  return { ...res, ok: true };
}

// 手速骰計時器回呼(由 index.js 排程):揭題 / 截止;進入 roundEnd 則收尾回大廳
export function speedReveal(room) {
  if (room.modeId !== 'speed' || !room.round) return;
  MODES.speed.reveal(room.round, Date.now());
  if (room.round.phase === 'roundEnd') { recordRoundLosers(room); room.status = 'lobby'; }
}
export function speedConfirmAchieve(room, playerId, rollSeq, speedId) {
  if (room.modeId !== 'speed' || !room.round) return false;
  if (room.round.speedId !== speedId) return false;
  const changed = MODES.speed.confirmAchieve(room.round, playerId, rollSeq);
  if (changed && room.round.phase === 'roundEnd') { recordRoundLosers(room); room.status = 'lobby'; }
  return changed;
}
export function speedTimeout(room) {
  if (room.modeId !== 'speed' || !room.round) return;
  MODES.speed.resolveTimeout(room.round);
  if (room.round.phase === 'roundEnd') { recordRoundLosers(room); room.status = 'lobby'; }
}

// 驚爆骰:安全區自動骰(由 index.js 計時器逐步驅動)
export function rouletteNeedsAutoRoll(room) {
  if (room.modeId !== 'roulette' || !room.round) return false;
  return MODES.roulette.isSafeZone(room.round);
}
export function rouletteAutoRollOnce(room) {
  if (room.modeId !== 'roulette' || !room.round) return false;
  return MODES.roulette.autoRollOnce(room.round);
}

// 具備整場狀態(initMatch)的模式 → 吹牛骰 / 混合模式
function isMatchMode(mode) {
  return mode && typeof mode.initMatch === 'function';
}

// 累計各玩家「輸的次數」+ 記錄本場輸家(供「由輸家決定」);每場僅計一次
function recordLosses(room) {
  if (!room.match || room.match.lossCounted) return;
  room.match.lossCounted = true;
  const rv = room.round && room.round.reveal;
  const losers = [];
  if (rv) {
    if (rv.loserId) losers.push(rv.loserId);
    if (Array.isArray(rv.losers)) losers.push(...rv.losers);
  }
  const uniq = [...new Set(losers)];
  room.lastLosers = uniq; // 上一場輸家(可能為空,如吹牛)
  // 記住本場「選條件/玩法的人」,作為下一場順位決定者的起點
  room.lastChooserId = (room.round && room.round.chooserId) || null;
  if (!room.losses) room.losses = {};
  for (const id of uniq) room.losses[id] = (room.losses[id] || 0) + 1;
  checkLossMilestone(room, uniq);
}

// 吹牛骰:本輪房主選出的輸家計一次「輸的次數」(每輪僅計一次)
function recordRoundLosers(room) {
  const r = room.round;
  if (!r || r.lossCounted) return;
  const rv = r.reveal;
  const losers = [];
  if (rv) {
    if (rv.loserId) losers.push(rv.loserId);
    if (Array.isArray(rv.losers)) losers.push(...rv.losers);
  }
  const uniq = [...new Set(losers)];
  if (!uniq.length) return;
  r.lossCounted = true;
  room.lastLosers = uniq;
  if (!room.losses) room.losses = {};
  for (const id of uniq) room.losses[id] = (room.losses[id] || 0) + 1;
  checkLossMilestone(room, uniq);
}

// 輸到 10 的倍數次 → 存 lossMilestone 供前端彈嘲諷 popup
const TAUNT_TEMPLATES = [
  (n, c) => `${n} 已經輸 ${c} 次了，加油好嗎？`,
  (n, c) => `${n} 輸了 ${c} 次！是在練習輸嗎？`,
  (n, c) => `恭喜 ${n} 達成 ${c} 敗的里程碑！`,
  (n, c) => `${n} ${c} 連敗！要不要考慮改行？`,
  (n, c) => `${n} 已經輸 ${c} 次了，骰子都替你哭了`,
  (n, c) => `${n} 第 ${c} 敗！穩定輸出，從不讓人失望`,
  (n, c) => `輸神降臨！${n} ${c} 敗達成 🫡`,
  (n, c) => `${n} 輸 ${c} 次了，要頒個獎給你嗎？`,
  (n, c) => `${n} ${c} 敗！這個手氣建議去買刮刮樂反著刮`,
  (n, c) => `${n} 輸到 ${c} 次了⋯⋯是不是該換個暱稱重新做人？`,
  (n, c) => `${n} 再接再厲！離 ${c + 10} 敗只差一點點了 💪`,
  (n, c) => `${n} ${c} 敗！你的運氣大概都給隔壁了`,
  (n, c) => `${n}，輸 ${c} 次不可恥，可恥的是還不認輸`,
  (n, c) => `${n} ${c} 敗成就解鎖！🏅 敗者為王`,
  (n, c) => `${n} 穩穩地輸了 ${c} 次，堪稱輸界傳奇`,
];
const TAUNT_ICONS = ['🤡', '💀', '😂', '😭', '🎉', '👏', '🫣', '😈', '🥲'];
function checkLossMilestone(room, loserIds) {
  const milestones = [];
  for (const id of loserIds) {
    const cnt = room.losses[id];
    if (cnt && cnt >= 10 && cnt % 10 === 0) {
      const p = [...room.players, ...room.spectators, ...(room.away || [])]
        .find((x) => x.id === id);
      if (p) {
        const tmpl = TAUNT_TEMPLATES[Math.floor(Math.random() * TAUNT_TEMPLATES.length)];
        const icon = TAUNT_ICONS[Math.floor(Math.random() * TAUNT_ICONS.length)];
        milestones.push({ id, name: p.name, count: cnt, text: tmpl(p.name, cnt), icon });
      }
    }
  }
  room.lossMilestone = milestones.length ? milestones : null;
}

// 「由輸家決定」(順位制):從上一場「選條件的人」往下順位,
// 碰到的第一個輸家來決定本場玩法(例:#4 選黑使 #2、#6 輸 → 從 #4 往下先遇到 #6)。
function computeDecider(room) {
  if (!room.loserDecides) return null;
  const losers = room.lastLosers || [];
  if (!losers.length) return null; // 首場或無輸家 → 不限制
  const order = room.players.map((p) => p.id); // 座位(加入)順序
  if (!order.length) return null;
  const seed = room.lastChooserId;
  // 選條件的人自己也輸 → 仍由他自己決定下一場
  if (seed && losers.includes(seed)) return seed;
  const startIdx = (seed && order.includes(seed)) ? order.indexOf(seed) : -1;
  // 否則從 chooser 的「下一位」開始往下繞一圈,找第一個輸家
  for (let k = 1; k <= order.length; k++) {
    const id = order[(startIdx + k + order.length) % order.length];
    if (losers.includes(id)) return id;
  }
  return null;
}

// 玩家離開房間後,重新判定進行中的回合是否該結束(避免卡在等待離開者)
export function onPlayerLeft(room, leftId) {
  if (room.status === 'playing' && room.round && room.modeId) {
    const mode = MODES[room.modeId];

    if (mode.id === 'roll') {
      if (room.round.rolls) delete room.round.rolls[leftId];
      if (room.players.length > 0 && mode.isRoundOver(room.round, room.players)) {
        mode.finishRound(room.round, room.players);
        room.status = 'lobby';
      }
    } else if (mode.id === 'liars') {
      const r = room.round;
      if (pruneRoundMember(r, leftId) && r.order.length === 0) room.status = 'lobby';
      finishIfMatchOver(room, mode);
    } else if (mode.id === 'roulette' || mode.id === 'blackjack21') {
      const r = room.round;
      if (pruneRoundMember(r, leftId)) {
        if (r.order.length === 0) {
          room.status = 'lobby';
        } else {
          if (r.turnIndex >= r.order.length) r.turnIndex = r.turnIndex % r.order.length;
        }
      }
      finishIfMatchOver(room, mode);
    } else if (mode.id === 'mixed') {
      const r = room.round;
      if (pruneRoundMember(r, leftId)) {
        if (r.order.length === 0) {
          room.status = 'lobby';
        } else {
          // 離開者是最後一個未搖的 → 進入下一階段(rolling 本骰,或 reveal 的「搖下一骰」)
          if ((r.phase === 'rolling' || r.phase === 'reveal')
            && r.order.every((id) => r.rolled.includes(id))) {
            mode.afterAllRolled(r);
          }
          // 選條件的人離開 → 交給場上第一位接手決定
          if (r.phase === 'condition' && r.chooserId === leftId) {
            r.chooserId = r.order[0];
          }
          // 話胚比較中 → 重新評定最小者
          mode.refreshPoker?.(r, room.match);
        }
      }
      finishIfMatchOver(room, mode);
    } else if (mode.id === 'speed') {
      const r = room.round;
      if (mode.prune(r, leftId)) {
        if (r.order.length <= 1) {
          room.status = 'lobby'; // 全走光或只剩 1 人 → 本局作廢回大廳(不判輸)
        } else if (r.phase === 'racing') {
          // 離開者可能讓「剩 1 人未達標」成立 → 重判提前結束
          mode.checkEarlyEnd(r);
          if (r.phase === 'roundEnd') { recordRoundLosers(room); room.status = 'lobby'; }
        }
      }
    }
  }

  // 場上玩家全部離開 → 中止當前回合/整場,回到大廳(清乾淨,等同 forceReset)
  if (room.status === 'playing' && room.players.length === 0) {
    room.round = null;
    room.match = null;
    room.matchOver = false;
    room.winnerId = null;
    room.status = 'lobby';
  }

  // 回合結算後:若場上已無正式玩家但仍有觀戰者,自動把觀戰者轉正並補房主
  ensurePlayers(room);

  // 房主離開後 hostId 可能已換人 → 同步 round.hostId(供 pickLoser 驗證)
  if (room.round && room.round.phase === 'pickLoser') {
    room.round.hostId = room.hostId;
  }
}

// 把離場者從一輪的 order/rolled/hands 清掉;回傳此人原本是否在局內(供後續判定)
function pruneRoundMember(round, leftId) {
  if (!round || !round.order || !round.order.includes(leftId)) return false;
  round.order = round.order.filter((id) => id !== leftId);
  if (round.rolled) round.rolled = round.rolled.filter((id) => id !== leftId);
  if (round.hands) delete round.hands[leftId];
  return true;
}

// 整場結束判定(吹牛骰 / 混合模式共用):結束則記勝者、回大廳
function finishIfMatchOver(room, mode) {
  if (!mode.isMatchOver(room.match, room.players)) return;
  room.matchOver = true;
  const w = mode.winner(room.match, room.players);
  room.winnerId = w ? w.id : null;
  room.status = 'lobby';
}
