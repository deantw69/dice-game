// 純搖骰模式 — 每位玩家各搖 N 顆骰子,點數公開,無勝負(顯示總和排行)
import { rollDice } from '../util/rng.js';

export const rollMode = {
  id: 'roll',
  name: '純搖骰',
  minPlayers: 1,

  // 建立一輪的狀態
  startRound(players, opts = {}) {
    return {
      diceCount: Math.max(1, Math.min(100, opts.diceCount || 3)),
      rolls: {},        // playerId -> [dice]
      phase: 'rolling', // rolling -> roundEnd
    };
  },

  handleAction(game, player, action) {
    if (action.type !== 'roll') return { error: '無效動作' };
    if (game.rolls[player.id]) return { error: '你已經搖過了' };
    game.rolls[player.id] = rollDice(game.diceCount);
    return { ok: true };
  },

  isRoundOver(game, players) {
    return players.every((p) => game.rolls[p.id]);
  },

  finishRound(game, players) {
    game.phase = 'roundEnd';
    // 計算排行(總和)
    game.ranking = players
      .map((p) => ({ id: p.id, name: p.name, sum: (game.rolls[p.id] || []).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.sum - a.sum);
  },

  // 公開視圖(所有人可見,點數公開)
  publicView(game, players) {
    return {
      diceCount: game.diceCount,
      phase: game.phase,
      rolls: game.rolls,
      rolled: players.filter((p) => game.rolls[p.id]).map((p) => p.id),
      ranking: game.ranking || null,
    };
  },

  // 此模式無秘密資訊
  privateView() {
    return {};
  },
};
