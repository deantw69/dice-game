// 吹牛骰(Liar's Dice)標準規則
// - 每人 5 顆骰子,藏在自己骰盅內(僅自己可見)
// - 1 點(幺)為萬能,計入任何點數的數量
// - 輪流喊牌:必須提高數量,或同數量提高點數;或開盅質疑
// - 開盅後統計全場(含萬能)該點數實際數量,輸家失去 1 顆骰子
// - 骰子歸零淘汰,剩最後一人獲勝
import { rollDice } from '../util/rng.js';

const START_DICE = 5;

export const liarsDice = {
  id: 'liars',
  name: '吹牛骰',
  minPlayers: 2,
  startDice: START_DICE,

  // 整場遊戲初始化(一次):給每人 5 顆骰子的「持有數」
  initMatch(players) {
    const diceLeft = {};
    for (const p of players) diceLeft[p.id] = START_DICE;
    return { diceLeft, eliminated: [], starterIdx: 0 };
  },

  // 開始一輪:暗骰、設定輪序
  startRound(match, players) {
    const alive = players.filter((p) => (match.diceLeft[p.id] || 0) > 0 && !match.eliminated.includes(p.id));
    const order = alive.map((p) => p.id);
    const hands = {};
    for (const id of order) hands[id] = rollDice(match.diceLeft[id]);
    // 起手玩家(沿用上一輪輸家或輪轉)
    const starter = match.nextStarter && order.includes(match.nextStarter)
      ? order.indexOf(match.nextStarter)
      : 0;
    return {
      phase: 'bidding',          // bidding -> reveal -> roundEnd
      order,
      hands,                     // playerId -> [dice] (秘密)
      turnIdx: starter,
      currentBid: null,          // { playerId, quantity, face }
      reveal: null,              // 開盅結果
    };
  },

  currentPlayerId(round) {
    return round.order[round.turnIdx];
  },

  handleAction(round, match, player, action, players) {
    if (round.phase !== 'bidding') return { error: '現在不能動作' };
    if (this.currentPlayerId(round) !== player.id) return { error: '還沒輪到你' };

    if (action.type === 'bid') {
      const q = parseInt(action.quantity);
      const f = parseInt(action.face);
      if (!(f >= 1 && f <= 6) || !(q >= 1)) return { error: '喊牌格式錯誤' };
      if (!isHigherBid(round.currentBid, q, f)) {
        return { error: '必須提高數量,或同數量提高點數' };
      }
      round.currentBid = { playerId: player.id, quantity: q, face: f };
      advanceTurn(round);
      return { ok: true };
    }

    if (action.type === 'challenge') {
      if (!round.currentBid) return { error: '尚無喊牌可質疑' };
      return resolveChallenge(round, match, player, players);
    }

    return { error: '無效動作' };
  },

  isRoundOver(round) {
    return round.phase === 'roundEnd';
  },

  // 整場是否結束(僅剩一人)
  isMatchOver(match, players) {
    const alive = players.filter((p) => (match.diceLeft[p.id] || 0) > 0);
    return alive.length <= 1;
  },

  winner(match, players) {
    const alive = players.filter((p) => (match.diceLeft[p.id] || 0) > 0);
    return alive[0] || null;
  },

  publicView(round, match, players) {
    return {
      phase: round.phase,
      order: round.order,
      currentPlayerId: round.phase === 'bidding' ? this.currentPlayerId(round) : null,
      currentBid: round.currentBid,
      diceLeft: match.diceLeft,
      reveal: round.reveal, // 開盅後公開所有骰子
    };
  },

  privateView(round, player) {
    return { myDice: (round.hands && round.hands[player.id]) || [] };
  },
};

function isHigherBid(prev, q, f) {
  if (!prev) return true;
  if (q > prev.quantity) return true;
  if (q === prev.quantity && f > prev.face) return true;
  return false;
}

function advanceTurn(round) {
  round.turnIdx = (round.turnIdx + 1) % round.order.length;
}

// 統計某點數實際數量(1 為萬能,計入,但若被喊的就是 1 則不重複加)
function countFace(hands, face) {
  let n = 0;
  for (const id of Object.keys(hands)) {
    for (const d of hands[id]) {
      if (d === face) n++;
      else if (d === 1 && face !== 1) n++; // 幺當萬能
    }
  }
  return n;
}

function resolveChallenge(round, match, challenger, players) {
  const bid = round.currentBid;
  const actual = countFace(round.hands, bid.face);
  const bidStands = actual >= bid.quantity; // 實際 >= 宣告 → 喊牌成立,質疑者輸
  const loserId = bidStands ? challenger.id : bid.playerId;

  match.diceLeft[loserId] = Math.max(0, (match.diceLeft[loserId] || 0) - 1);
  const eliminated = match.diceLeft[loserId] === 0;
  if (eliminated && !match.eliminated.includes(loserId)) match.eliminated.push(loserId);

  // 下一輪由輸家起手(若被淘汰則順延)
  match.nextStarter = eliminated ? bid.playerId : loserId;

  round.phase = 'roundEnd';
  round.reveal = {
    bid,
    actual,
    bidStands,
    challengerId: challenger.id,
    loserId,
    loserName: (players.find((p) => p.id === loserId) || {}).name,
    eliminated,
    hands: round.hands, // 公開全部骰子
  };
  return { ok: true, revealed: true };
}
