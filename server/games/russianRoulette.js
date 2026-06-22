// 俄羅斯輪盤骰:輪流搖 1 顆骰,累加總和,超過門檻就爆掉扣命,最後活著的贏
import { rollDice } from '../util/rng.js';

export const russianRoulette = {
  id: 'roulette',
  name: '俄羅斯輪盤骰',
  minPlayers: 2,

  initMatch(players, { lives = 3, bustThreshold = 21, maxPasses = 1 } = {}) {
    const l = {};
    for (const p of players) l[p.id] = lives;
    return {
      lives: l,
      eliminated: [],
      startLives: lives,
      bustThreshold,
      maxPasses,
      nextStarter: null,
    };
  },

  startRound(match, players) {
    const alive = players.filter(
      (p) => (match.lives[p.id] || 0) > 0 && !match.eliminated.includes(p.id),
    );
    const order = alive.map((p) => p.id);

    let turnIndex = 0;
    if (match.nextStarter && order.includes(match.nextStarter)) {
      turnIndex = order.indexOf(match.nextStarter);
    }

    const passes = {};
    for (const id of order) passes[id] = 0;

    return {
      phase: 'playing',
      order,
      turnIndex,
      total: 0,
      passes,
      lastRoll: null,
      history: [],
      bustPlayer: null,
      reveal: null,
    };
  },

  handleAction(round, match, player, action, _players) {
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };
    if (round.phase !== 'playing') return { error: '本輪已結束' };

    const currentId = round.order[round.turnIndex];
    if (player.id !== currentId) return { error: '還沒輪到你' };

    if (action.type === 'roll') {
      const value = rollDice(1)[0];
      round.total += value;
      round.lastRoll = { playerId: player.id, value };
      round.history.push({ playerId: player.id, action: 'roll', value, total: round.total });

      if (round.total > match.bustThreshold) {
        round.bustPlayer = player.id;
        match.lives[player.id] = Math.max(0, (match.lives[player.id] || 0) - 1);
        if (match.lives[player.id] <= 0 && !match.eliminated.includes(player.id)) {
          match.eliminated.push(player.id);
        }
        match.nextStarter = player.id;
        round.reveal = { loserId: player.id };
        round.phase = 'roundEnd';
      } else {
        advanceTurn(round);
      }
      return { ok: true };
    }

    if (action.type === 'pass') {
      if ((round.passes[player.id] || 0) >= match.maxPasses) {
        return { error: `每輪最多跳過 ${match.maxPasses} 次` };
      }
      if (match.maxPasses <= 0) return { error: '本場不允許跳過' };
      round.passes[player.id] = (round.passes[player.id] || 0) + 1;
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
    return players.filter((p) => (match.lives[p.id] || 0) > 0).length <= 1;
  },

  winner(match, players) {
    const alive = players.filter((p) => (match.lives[p.id] || 0) > 0);
    return alive.length === 1 ? alive[0] : null;
  },

  publicView(round, match, _players) {
    return {
      phase: round.phase,
      order: round.order,
      turnIndex: round.turnIndex,
      total: round.total,
      bustThreshold: match.bustThreshold,
      maxPasses: match.maxPasses,
      passes: round.passes,
      lastRoll: round.lastRoll,
      history: round.history,
      bustPlayer: round.bustPlayer,
      lives: match.lives,
    };
  },

  privateView() {
    return {};
  },
};

function advanceTurn(round) {
  round.turnIndex = (round.turnIndex + 1) % round.order.length;
}
