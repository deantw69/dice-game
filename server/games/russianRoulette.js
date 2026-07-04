// 驚爆骰:輪流搖 1 顆骰,累加總和,超過隱藏門檻就爆掉扣命,最後活著的贏
import { rollDice } from '../util/rng.js';

// 依存活人數動態產生爆掉門檻範圍,每回合隨機取值
// min = playerCount * 5, max = playerCount * 10
function bustRange(playerCount) {
  const min = playerCount * 5;
  const max = playerCount * 10;
  return { min, max };
}

function randomBust(playerCount) {
  const { min, max } = bustRange(playerCount);
  return min + Math.floor(Math.random() * (max - min + 1));
}

export const russianRoulette = {
  id: 'roulette',
  name: '驚爆骰',
  minPlayers: 2,

  initMatch(players, { lives = 3, abilityPoints = 2 } = {}) {
    const l = {};
    for (const p of players) l[p.id] = lives;
    return {
      lives: l,
      eliminated: [],
      startLives: lives,
      abilityPoints,
      nextStarter: null,
    };
  },

  startRound(match, players) {
    const alive = match.startLives === 0
      ? players
      : players.filter(
          (p) => (match.lives[p.id] || 0) > 0 && !match.eliminated.includes(p.id),
        );
    const order = alive.map((p) => p.id);
    const range = bustRange(order.length);
    const bustThreshold = randomBust(order.length);

    let turnIndex = 0;
    if (match.nextStarter && order.includes(match.nextStarter)) {
      turnIndex = order.indexOf(match.nextStarter);
    }

    const needAllocate = match.abilityPoints > 0;
    const alloc = {};
    const allocReady = {};
    const prev = match.lastAlloc || {};
    for (const id of order) {
      const p = prev[id];
      if (p && (p.passes + p.reverses) === match.abilityPoints) {
        alloc[id] = { passes: p.passes, reverses: p.reverses };
      } else {
        alloc[id] = { passes: 0, reverses: 0 };
      }
      allocReady[id] = false;
    }

    return {
      phase: needAllocate ? 'allocating' : 'playing',
      order,
      turnIndex,
      direction: 1,
      total: 0,
      bustThreshold,
      bustRange: range,
      alloc,
      allocReady,
      passes: {},
      reverses: {},
      lastRoll: null,
      history: [],
      bustPlayer: null,
      reveal: null,
    };
  },

  handleAction(round, match, player, action, _players) {
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };

    if (round.phase === 'allocating') {
      if (action.type === 'allocate') {
        const pts = match.abilityPoints;
        const p = parseInt(action.passes) || 0;
        const r = parseInt(action.reverses) || 0;
        if (p < 0 || r < 0) return { error: '次數不能為負' };
        if (p + r > pts) return { error: `總和不能超過 ${pts}` };
        round.alloc[player.id] = { passes: p, reverses: r };
        round.allocReady[player.id] = (p + r === pts) && !!action.confirm;
        if (round.order.every((id) => round.allocReady[id])) {
          round.phase = 'playing';
          match.lastAlloc = {};
          for (const id of round.order) {
            round.passes[id] = 0;
            round.reverses[id] = 0;
            match.lastAlloc[id] = { ...round.alloc[id] };
          }
        }
        return { ok: true };
      }
      return { error: '請先分配特殊功能次數' };
    }

    if (round.phase !== 'playing') return { error: '本輪已結束' };

    const currentId = round.order[round.turnIndex];
    if (player.id !== currentId) return { error: '還沒輪到你' };

    if (action.type === 'roll') {
      const value = rollDice(1)[0];
      round.total += value;
      round.lastRoll = { playerId: player.id, value };
      round.history.push({ playerId: player.id, action: 'roll', value, total: round.total });

      if (round.total > round.bustThreshold) {
        round.bustPlayer = player.id;
        if (match.startLives > 0) {
          match.lives[player.id] = Math.max(0, (match.lives[player.id] || 0) - 1);
          if (match.lives[player.id] <= 0 && !match.eliminated.includes(player.id)) {
            match.eliminated.push(player.id);
          }
        }
        match.nextStarter = player.id;
        round.reveal = { loserId: player.id };
        round.phase = 'roundEnd';
      } else {
        advanceTurn(round);
      }
      return { ok: true };
    }

    if (action.type === 'reverse') {
      const maxR = (round.alloc[player.id] || {}).reverses || 0;
      const used = round.reverses[player.id] || 0;
      if (used >= maxR) return { error: '迴轉次數已用完' };
      round.reverses[player.id] = used + 1;
      round.direction *= -1;
      round.history.push({ playerId: player.id, action: 'reverse', total: round.total });
      advanceTurn(round);
      return { ok: true };
    }

    if (action.type === 'pass') {
      const maxP = (round.alloc[player.id] || {}).passes || 0;
      const used = round.passes[player.id] || 0;
      if (maxP <= 0) return { error: '沒有分配跳過次數' };
      if (used >= maxP) return { error: '跳過次數已用完' };
      round.passes[player.id] = used + 1;
      round.history.push({ playerId: player.id, action: 'pass', total: round.total });
      advanceTurn(round);
      return { ok: true };
    }

    return { error: '無效動作' };
  },

  isRoundOver(round) {
    return round.phase === 'roundEnd';
  },

  finishRound(_round, _players) {},

  isMatchOver(match, players) {
    if (match.startLives === 0) return true;
    return players.filter((p) => (match.lives[p.id] || 0) > 0).length <= 1;
  },

  winner(match, players) {
    if (match.startLives === 0) return null;
    const alive = players.filter((p) => (match.lives[p.id] || 0) > 0);
    return alive.length === 1 ? alive[0] : null;
  },

  publicView(round, match, _players) {
    return {
      phase: round.phase,
      order: round.order,
      turnIndex: round.turnIndex,
      direction: round.direction,
      total: round.total,
      bustRange: round.bustRange,
      bustThreshold: round.bustPlayer ? round.bustThreshold : null,
      abilityPoints: match.abilityPoints,
      alloc: round.alloc,
      allocReady: round.allocReady,
      passes: round.passes,
      reverses: round.reverses,
      lastRoll: round.lastRoll,
      history: round.history,
      bustPlayer: round.bustPlayer,
      lives: match.lives,
      reveal: round.reveal || null,
      autoRolling: isSafeZone(round),
    };
  },

  privateView() {
    return {};
  },

  isSafeZone(round) { return isSafeZone(round); },
  autoRollOnce(round) { return autoRollOnce(round); },
};

function advanceTurn(round) {
  const len = round.order.length;
  round.turnIndex = ((round.turnIndex + (round.direction || 1)) % len + len) % len;
}

// 累計 + 最大骰面(6) 仍不會碰到門檻下限 → 還在安全區
function isSafeZone(round) {
  return round.phase === 'playing' && round.total + 6 <= round.bustRange.min;
}

// 自動骰一步(由 index.js 計時器逐步驅動,每步 broadcast 讓前端播動畫)
function autoRollOnce(round) {
  if (!isSafeZone(round)) return false;
  const playerId = round.order[round.turnIndex];
  const value = rollDice(1)[0];
  round.total += value;
  round.lastRoll = { playerId, value };
  round.history.push({ playerId, action: 'roll', value, total: round.total, auto: true });
  advanceTurn(round);
  return true;
}
