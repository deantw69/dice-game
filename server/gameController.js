// 遊戲流程控制 — 設定模式、開始一輪、分派動作、管理輪次/整場生命週期
import { MODES, MODE_LIST } from './games/index.js';
import { mergeSpectators } from './roomManager.js';

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
  return { ok: true };
}

export function setDiceCount(room, playerId, n) {
  if (room.hostId !== playerId) return { error: '只有房主能設定' };
  room.diceCount = Math.max(1, Math.min(5, parseInt(n) || 3));
  return { ok: true };
}

// 房主強制重來:中止當前這場,清空回到大廳(防任何環節卡死)
export function forceReset(room, playerId) {
  if (room.hostId !== playerId) return { error: '只有房主能強制重來' };
  room.round = null;
  room.match = null;
  room.matchOver = false;
  room.winnerId = null;
  room.status = 'lobby';
  return { ok: true };
}

export function startRound(room, playerId) {
  if (room.hostId !== playerId) return { error: '只有房主能開始' };
  if (!room.modeId) return { error: '請先選擇遊戲模式' };
  const mode = MODES[room.modeId];

  // 觀戰者於每輪開始時併入
  mergeSpectators(room);

  if (room.players.length < mode.minPlayers) {
    return { error: `此模式至少需要 ${mode.minPlayers} 人` };
  }

  if (isMatchMode(mode)) {
    if (!room.match || room.matchOver) {
      room.match = mode.initMatch(room.players);
      room.matchOver = false;
      room.winnerId = null;
    } else {
      // 中途併入的新玩家補發骰子
      for (const p of room.players) {
        if (room.match.diceLeft[p.id] == null) room.match.diceLeft[p.id] = mode.startDice;
      }
    }
    room.round = mode.startRound(room.match, room.players);
  } else if (mode.id === 'roll') {
    room.round = mode.startRound(room.players, { diceCount: room.diceCount });
    room.match = null;
  } else {
    room.round = mode.startRound();
  }

  room.status = 'playing';
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
      if (mode.isMatchOver(room.match, room.players)) {
        room.matchOver = true;
        const w = mode.winner(room.match, room.players);
        room.winnerId = w ? w.id : null;
      }
      room.status = 'lobby'; // 等房主開下一輪 / 或整場已結束
    }
  }

  return { ...res, ok: true };
}

// 具備整場狀態(initMatch)的模式 → 吹牛骰 / 混合模式
function isMatchMode(mode) {
  return mode && typeof mode.initMatch === 'function';
}

// 玩家離開房間後,重新判定進行中的回合是否該結束(避免卡在等待離開者)
export function onPlayerLeft(room, leftId) {
  if (room.status !== 'playing' || !room.round || !room.modeId) return;
  const mode = MODES[room.modeId];

  if (mode.id === 'roll') {
    if (room.round.rolls) delete room.round.rolls[leftId];
    if (room.players.length > 0 && mode.isRoundOver(room.round, room.players)) {
      mode.finishRound(room.round, room.players);
      room.status = 'lobby';
    }
  } else if (mode.id === 'liars') {
    const r = room.round;
    if (r.order && r.order.includes(leftId)) {
      const idx = r.order.indexOf(leftId);
      r.order.splice(idx, 1);
      if (r.hands) delete r.hands[leftId];
      // 修正輪到誰
      if (idx < r.turnIdx) r.turnIdx -= 1;
      if (r.order.length === 0) { room.status = 'lobby'; }
      else if (r.turnIdx >= r.order.length) { r.turnIdx = 0; }
    }
    // 整場是否只剩一人 → 結束本場
    if (mode.isMatchOver(room.match, room.players)) {
      room.matchOver = true;
      const w = mode.winner(room.match, room.players);
      room.winnerId = w ? w.id : null;
      room.status = 'lobby';
    }
  } else if (mode.id === 'mixed') {
    const r = room.round;
    if (r.order && r.order.includes(leftId)) {
      r.order = r.order.filter((id) => id !== leftId);
      if (r.rolled) r.rolled = r.rolled.filter((id) => id !== leftId);
      if (r.hands) delete r.hands[leftId];
      if (r.order.length === 0) {
        room.status = 'lobby';
      } else {
        // 離開者是最後一個未搖的 → 進入下一階段(已選玩法則直接選條件)
        if (r.phase === 'rolling' && r.order.every((id) => r.rolled.includes(id))) {
          r.phase = r.subGame ? 'condition' : 'choosing';
        }
        // 選條件的人離開 → 交給場上第一位接手決定
        if (r.phase === 'condition' && r.chooserId === leftId) {
          r.chooserId = r.order[0];
        }
      }
    }
    if (mode.isMatchOver(room.match, room.players)) {
      room.matchOver = true;
      const w = mode.winner(room.match, room.players);
      room.winnerId = w ? w.id : null;
      room.status = 'lobby';
    }
  }
}
