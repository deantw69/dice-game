// 吹牛骰(改版)
// 流程:rolling(每人各自搖暗骰,只看得到自己) → 任何人隨時可按「抓(開盅)」
//       → 直接公開所有人骰子 + 統計各點數數量。
// 註:喊牌/質疑/勝負邏輯已移除,之後再重做。
import { rollDice } from '../util/rng.js';

const START_DICE = 5;

export const liarsDice = {
  id: 'liars',
  name: '吹牛骰',
  minPlayers: 2,
  startDice: START_DICE,

  // 整場初始化:每人起始骰子數(可由房主設定,預設 5)
  initMatch(players, startDice = START_DICE) {
    const n = Math.max(1, Math.min(100, startDice || START_DICE));
    const diceLeft = {};
    for (const p of players) diceLeft[p.id] = n;
    return { diceLeft, eliminated: [], startDice: n };
  },

  // 開始一輪:進入搖骰階段(由玩家各自搖)
  startRound(match, players) {
    const alive = players.filter(
      (p) => (match.diceLeft[p.id] || 0) > 0 && !match.eliminated.includes(p.id)
    );
    return {
      phase: 'rolling',   // rolling -> roundEnd(抓開盅)
      order: alive.map((p) => p.id),
      hands: {},          // playerId -> [dice](搖完才有,秘密)
      rolled: [],         // 已搖骰的 playerId
      reveal: null,       // 開盅後:{ hands, stats }
    };
  },

  handleAction(round, match, player, action, players) {
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };

    // 各自搖暗骰
    if (action.type === 'roll') {
      if (round.phase !== 'rolling') return { error: '現在不是搖骰階段' };
      if (round.rolled.includes(player.id)) return { error: '你已經搖過了' };
      round.hands[player.id] = rollDice(match.diceLeft[player.id]);
      round.rolled.push(player.id);
      return { ok: true };
    }

    // 抓(開盅):需全員搖完後,任何人才可按 → 直接公開所有人 + 統計
    if (action.type === 'grab') {
      if (round.phase !== 'rolling') return { error: '已經開盅了' };
      if (!round.order.every((id) => round.rolled.includes(id))) {
        return { error: '還有人沒搖骰' };
      }
      doReveal(round);
      return { ok: true, revealed: true };
    }

    return { error: '無效動作' };
  },

  isRoundOver(round) {
    return round.phase === 'roundEnd';
  },

  // 目前無淘汰邏輯(待重做):僅剩一人時才算整場結束
  isMatchOver(match, players) {
    return players.filter((p) => (match.diceLeft[p.id] || 0) > 0).length <= 1;
  },
  winner(match, players) {
    const alive = players.filter((p) => (match.diceLeft[p.id] || 0) > 0);
    return alive.length === 1 ? alive[0] : null;
  },

  publicView(round, match, players) {
    return {
      phase: round.phase,
      order: round.order,
      rolled: round.rolled,
      diceLeft: match.diceLeft,
      reveal: round.reveal,
    };
  },
  privateView(round, player) {
    return { myDice: (round.hands && round.hands[player.id]) || [] };
  },
};

function doReveal(round) {
  const stats = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const id of round.order) {
    for (const d of round.hands[id] || []) stats[d] = (stats[d] || 0) + 1;
  }
  round.phase = 'roundEnd';
  round.reveal = { hands: round.hands, stats };
}
