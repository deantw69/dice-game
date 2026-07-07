// 21 點骰:輪流要牌(擲骰),點數加總盡量接近 21 但不能爆;暗骰對他人隱藏
import { rollDie } from '../util/rng.js';

const DEFAULT_LIVES = 0;

let revealSeq = 0; // 過期 settle 計時器自我失效用的 nonce 來源

export const blackjack21 = {
  id: 'blackjack21',
  name: '21 點骰',
  minPlayers: 2,

  initMatch(players, { lives = DEFAULT_LIVES } = {}) {
    const l = {};
    for (const p of players) l[p.id] = lives;
    return {
      lives: l,
      eliminated: [],
      startLives: lives,
    };
  },

  startRound(match, players) {
    const alive = match.startLives === 0
      ? players
      : players.filter(
          (p) => (match.lives[p.id] || 0) > 0 && !match.eliminated.includes(p.id),
        );
    const order = alive.map((p) => p.id);
    const hands = {};
    for (const id of order) {
      const dice = [rollDie(), rollDie(), rollDie()];
      const total = dice.reduce((s, v) => s + v, 0);
      hands[id] = { dice, total, bust: false, stood: false };
    }
    return {
      phase: 'rolling',
      order,
      turnIndex: 0,
      hands,
      reveal: null,
      actionSeq: 0,
    };
  },

  handleAction(round, match, player, action, _players) {
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };
    if (round.phase !== 'rolling') return { error: '目前不能行動' };

    const hand = round.hands[player.id];

    // 停牌可在任何時機按(即使還沒輪到自己),先預先停牌;輪到時會自動被跳過
    if (action.type === 'stand') {
      if (hand.stood) return { error: '你已停牌' };
      hand.stood = true;
      round.actionSeq = (round.actionSeq || 0) + 1;
      if (round.order[round.turnIndex] === player.id) advanceTurn(round);
      checkAllDone(round, match);
      return { ok: true };
    }

    const currentId = round.order[round.turnIndex];
    if (player.id !== currentId) return { error: '還沒輪到你' };

    if (action.type === 'hit' || action.type === 'roll') {
      const count = Math.max(1, Math.min(3, Math.floor(Number(action.count) || 1)));
      const rolled = [];
      for (let i = 0; i < count; i++) {
        const value = rollDie();
        hand.dice.push(value);
        hand.total += value;
        rolled.push(value);
      }
      if (hand.total > 21) {
        hand.bust = true;
        hand.stood = true;
      }
      round.actionSeq = (round.actionSeq || 0) + 1;
      advanceTurn(round);
      checkAllDone(round, match);
      return { ok: true, rolled };
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
    const hands = {};
    for (const [id, h] of Object.entries(round.hands)) {
      if (round.phase === 'reveal' || round.phase === 'roundEnd') {
        hands[id] = { dice: h.dice, total: h.total, bust: h.bust, done: h.stood, diceCount: h.dice.length };
      } else {
        hands[id] = { diceCount: h.dice.length, done: h.stood };
      }
    }
    return {
      phase: round.phase,
      order: round.order,
      turnIndex: round.turnIndex,
      hands,
      lives: match.lives,
      eliminated: match.eliminated,
      reveal: round.reveal,
      actionSeq: round.actionSeq || 0,
    };
  },

  privateView(round, viewer) {
    const hand = round.hands[viewer.id];
    if (!hand) return {};
    return {
      myDice: hand.dice,
      myTotal: hand.total,
      myBust: hand.bust,
    };
  },

  // reveal 階段停留一段時間(先展示各家點數/骰子數)後,由 index.js 計時器呼叫此函式才決出輸家
  settle(round, match, revealId) {
    if (round.phase !== 'reveal') return false;
    if (revealId != null && round.revealId !== revealId) return false;
    settleReveal(round, match);
    return true;
  },
};

function advanceTurn(round) {
  const n = round.order.length;
  for (let i = 1; i <= n; i++) {
    const idx = (round.turnIndex + i) % n;
    const h = round.hands[round.order[idx]];
    if (!h.stood) {
      round.turnIndex = idx;
      return;
    }
  }
}

function checkAllDone(round, match) {
  const allDone = round.order.every((id) => round.hands[id].stood);
  if (!allDone) return;

  // 先進 reveal 階段(僅翻開骰子/顯示點數,尚未決定輸家);由計時器延遲後再 settle
  round.phase = 'reveal';
  round.revealId = ++revealSeq;
}

function settleReveal(round, match) {
  const busted = round.order.filter((id) => round.hands[id].bust);
  const notBusted = round.order.filter((id) => !round.hands[id].bust);
  let losers;

  if (busted.length > 0 && notBusted.length > 0) {
    losers = busted;
  } else if (notBusted.length > 0) {
    const minTotal = Math.min(...notBusted.map((id) => round.hands[id].total));
    const tied = notBusted.filter((id) => round.hands[id].total === minTotal);
    if (tied.length > 1) {
      const minDice = Math.min(...tied.map((id) => round.hands[id].dice.length));
      losers = tied.filter((id) => round.hands[id].dice.length === minDice);
    } else {
      losers = tied;
    }
  } else {
    const maxTotal = Math.max(...round.order.map((id) => round.hands[id].total));
    losers = round.order.filter((id) => round.hands[id].total === maxTotal);
  }

  if (match.startLives > 0) {
    for (const id of losers) {
      match.lives[id] = Math.max(0, (match.lives[id] || 0) - 1);
      if (match.lives[id] <= 0 && !match.eliminated.includes(id)) {
        match.eliminated.push(id);
      }
    }
  }

  round.reveal = { losers };
  round.phase = 'roundEnd';
}
