// 混合模式 — 從 5 顆暗骰開始的對局
// 流程(每一輪迴圈):
//   rolling   各自搖暗骰(只看得到自己)
//   choosing  任何人先按就決定這局子玩法(目前:紅黑單雙)
//   condition 由「先按的人」選一個條件
//   roundEnd  全部開牌,符合條件的骰子被拿掉(diceLeft 減少)
// 重複迴圈(按「下一輪」重搖剩餘骰子),直到有一人/多人失去所有骰子 = 輸,本場結束。
import { rollDice } from '../util/rng.js';
import { evalHand, cmpHand } from '../util/pokerHand.js';

const START_DICE = 5;
const START_REROLLS = 3; // 話胚:每人重骰次數(成為最小者時補滿)

// 紅黑單雙的四個條件(紅=1與4、黑=2356、單=135、雙=246)
const CONDITIONS = {
  red: { name: '紅', match: (d) => d === 1 || d === 4 },
  black: { name: '黑', match: (d) => !(d === 1 || d === 4) },
  odd: { name: '單數', match: (d) => d % 2 === 1 },
  even: { name: '雙數', match: (d) => d % 2 === 0 },
  big: { name: '大', match: (d) => d >= 4 },   // 4~6
  small: { name: '小', match: (d) => d <= 3 },  // 1~3
};

export const mixedMode = {
  id: 'mixed',
  name: '三合一',
  minPlayers: 2,
  implemented: true,
  startDice: START_DICE,

  // 可選子玩法清單(逐步擴充)
  subGames: [
    { id: 'redblack', name: '紅黑單雙', implemented: true },
    { id: 'bluff', name: '吹牛', implemented: true },
    { id: 'poker', name: '話胚', implemented: true },
  ],

  initMatch(players, startDice = START_DICE) {
    const n = Math.max(1, Math.min(100, startDice || START_DICE));
    const diceLeft = {};
    for (const p of players) diceLeft[p.id] = n;
    return { diceLeft, eliminated: [], startDice: n };
  },

  startRound(match, players) {
    const alive = players.filter(
      (p) => (match.diceLeft[p.id] || 0) > 0 && !match.eliminated.includes(p.id)
    );
    return {
      phase: 'rolling',   // rolling -> choosing -> condition -> roundEnd
      order: alive.map((p) => p.id),
      hands: {},          // playerId -> [dice](搖完才有,秘密)
      rolled: [],         // 已搖骰的 playerId
      subGame: null,      // 這局選定的子玩法
      chooserId: null,    // 這骰決定條件的人
      condition: null,    // 選定的條件
      openPick: false,    // 條件是否開放任何人先按(第二骰起為 true)
      reveal: null,       // 結算結果
    };
  },

  // 全員搖完(本骰,或紅黑單雙開牌後的「下一骰」)→ 清掉上一骰開牌並進入後續階段
  afterAllRolled(round) {
    round.reveal = null;
    round.condition = null;
    if (round.subGame === 'redblack' && round.autoRotate) {
      // 自動順位:由玩家列表順序的「下一位」決定要拿掉哪一種
      const i = round.order.indexOf(round.chooserId);
      round.chooserId = round.order[(i + 1) % round.order.length];
      round.openPick = false;
      round.phase = 'condition';
    } else if (round.subGame) {
      // 未開自動順位:任何人先按先決定
      round.phase = 'condition';
      round.openPick = true;
      round.chooserId = null;
    } else {
      round.phase = 'choosing';
    }
  },

  handleAction(round, match, player, action, players) {
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };

    // 各自搖暗骰(rolling;或紅黑單雙開牌後在 reveal 階段按「搖下一骰」接續同場下一骰)
    if (action.type === 'roll') {
      // reveal 階段的「搖下一骰」:每位玩家各自獨立搖,搖之前仍看著上一骰開牌結果,
      // 不會因別人先搖就被切走畫面(per-player view 由 privateView 控制)。
      if (round.phase !== 'rolling' && round.phase !== 'reveal') {
        return { error: '現在不是搖骰階段' };
      }
      if (round.rolled.includes(player.id)) return { error: '你已經搖過了' };
      round.hands[player.id] = rollDice(match.diceLeft[player.id]);
      round.rolled.push(player.id);
      // 全員都搖完(本骰或下一骰)→ 清掉上一骰開牌、進入後續階段
      if (round.order.every((id) => round.rolled.includes(id))) this.afterAllRolled(round);
      return { ok: true };
    }

    // 選玩法:任何人先按先決定(整場只在開頭一次)→ 由他選第一次條件
    if (action.type === 'chooseSubGame') {
      if (round.phase !== 'choosing') return { error: '現在不能選玩法' };
      // 「由輸家決定」:只有指定決定者能選(決定者已離場則不限制)
      if (round.decider && round.order.includes(round.decider) && player.id !== round.decider) {
        return { error: '本局由上一局輸家決定玩法' };
      }
      const sg = this.subGames.find((s) => s.id === action.subGame);
      if (!sg) return { error: '未知的玩法' };
      round.subGame = sg.id;
      if (sg.id === 'bluff') {
        // 吹牛:不選條件,全員已搖完 → 直接進入可開盅狀態(任何人可抓)
        round.phase = 'bluffReady';
        round.openPick = true;
        round.chooserId = null;
        return { ok: true, chosen: sg.id };
      }
      if (sg.id === 'poker') {
        // 話胚:選了立刻全部開牌,用撲克牌型比大小
        round.openPick = false;
        round.chooserId = player.id;
        resolvePoker(round, match);
        return { ok: true, chosen: sg.id };
      }
      round.chooserId = player.id; // 第一次條件由選玩法的人決定
      round.openPick = false;
      round.phase = 'condition';
      return { ok: true, chosen: sg.id };
    }

    // 吹牛:抓(開盅)→ 公開所有人骰子 + 各點數統計,進入房主選輸家
    if (action.type === 'grab') {
      if (round.phase !== 'bluffReady') return { error: '現在不能開盅' };
      if (!round.order.every((id) => round.rolled.includes(id))) {
        return { error: '還有人沒搖骰' };
      }
      resolveBluff(round, match);
      return { ok: true, revealed: true };
    }

    // 吹牛:房主選輸家,結束本場
    if (action.type === 'pickLoser') {
      if (round.phase !== 'pickLoser') return { error: '現在不能選輸家' };
      if (player.id !== round.hostId) return { error: '只有房主能選輸家' };
      const targetId = action.targetId;
      if (!round.order.includes(targetId)) return { error: '無效的目標玩家' };
      match.diceLeft[targetId] = Math.max(0, (match.diceLeft[targetId] || 0) - 1);
      round.reveal.losers = [targetId];
      round.reveal.loserId = targetId;
      round.reveal.pending = false;
      round.phase = 'roundEnd';
      match.over = true;
      return { ok: true };
    }

    // 話胚:最小的玩家重骰 → 重新比較
    if (action.type === 'reroll') {
      if (round.phase !== 'pokerCompare') return { error: '現在不能重骰' };
      if (!round.reveal || !round.reveal.lowestIds.includes(player.id)) {
        return { error: '只有牌型最小的玩家能重骰' };
      }
      // 鎖定的骰子位置保留原點數,其餘重骰;記錄實際重骰的索引供前端播動畫
      const locked = (round.pokerLocked || []).filter((x) => Number.isInteger(x));
      const usedLock = locked.length > 0;
      if (!round.rerolls) round.rerolls = {};
      if (!round.lockUsed) round.lockUsed = {};
      // 一般扣 1;同一段「當最小期間」第一次使用鎖定才多扣 1(扣 2),之後即使鎖定也只扣 1
      const firstLock = usedLock && !round.lockUsed[player.id];
      const cost = firstLock ? 2 : 1;
      const left = round.rerolls[player.id] || 0;
      if (left < cost) return { error: '重骰次數不足' };
      round.rerolls[player.id] = left - cost;
      if (usedLock) round.lockUsed[player.id] = true;

      const cur = round.hands[player.id] || [];
      const fresh = rollDice(match.diceLeft[player.id]);
      const rolledIdx = [];
      round.hands[player.id] = cur.map((v, i) => {
        if (locked.includes(i)) return v;
        rolledIdx.push(i);
        return fresh[i] ?? v;
      });
      resolvePoker(round, match);
      round.rollSeq = (round.rollSeq || 0) + 1;
      round.reveal.lastRoll = { id: player.id, idx: rolledIdx, seq: round.rollSeq };

      // 次數用完且自己仍是最小 → 直接輸
      if (round.rerolls[player.id] <= 0 && round.reveal.lowestIds.includes(player.id)) {
        round.reveal.loserId = player.id;
        round.reveal.loseBy = 'exhausted';
        round.phase = 'roundEnd';
        match.over = true;
      }
      return { ok: true };
    }

    // 話胚:最小的玩家設定鎖定哪幾顆(廣播給所有人看)
    if (action.type === 'setLock') {
      if (round.phase !== 'pokerCompare') return { error: '現在不能鎖定' };
      if (!round.reveal || !round.reveal.lowestIds.includes(player.id)) {
        return { error: '只有牌型最小的玩家能鎖定' };
      }
      const n = (round.hands[player.id] || []).length;
      const locked = (Array.isArray(action.locked) ? action.locked : [])
        .filter((x) => Number.isInteger(x) && x >= 0 && x < n);
      round.pokerLocked = locked;
      round.pokerLockBy = player.id;
      // 直接更新現有 reveal,讓這次廣播就帶上鎖定狀態
      round.reveal.locked = locked;
      round.reveal.lockBy = player.id;
      return { ok: true };
    }

    // 話胚:最小的玩家認輸 → 本場結束
    if (action.type === 'concede') {
      if (round.phase !== 'pokerCompare') return { error: '現在不能認輸' };
      if (!round.reveal || !round.reveal.lowestIds.includes(player.id)) {
        return { error: '只有牌型最小的玩家能認輸' };
      }
      round.reveal.loserId = player.id;
      round.reveal.loseBy = 'concede';
      round.phase = 'roundEnd';
      match.over = true; // 本場結束 → 回大廳「再來一場」
      return { ok: true };
    }

    // 選條件 → 開牌結算
    if (action.type === 'chooseCondition') {
      if (round.phase !== 'condition') return { error: '現在不能選條件' };
      // 第一骰由選玩法的人;之後輪到玩家列表順序的下一位(openPick 時才任何人可)
      if (!round.openPick && player.id !== round.chooserId) {
        return { error: '還沒輪到你決定' };
      }
      const cond = CONDITIONS[action.condition];
      if (!cond) return { error: '未知的條件' };
      if (round.openPick) round.chooserId = player.id; // 記錄先按的人
      resolveRedBlack(round, match, action.condition, cond);
      return { ok: true };
    }

    return { error: '無效動作' };
  },

  isRoundOver(round) {
    return round.phase === 'roundEnd';
  },

  // 任一玩家失去所有骰子 → 本場結束;或場上只剩 ≤1 人
  isMatchOver(match, players) {
    if (match.over) return true; // 吹牛開盅 / 話胚認輸 → 本場結束
    const counts = players.map((p) => match.diceLeft[p.id] ?? 0);
    if (counts.some((c) => c === 0)) return true;
    return counts.filter((c) => c > 0).length <= 1;
  },

  // 三合一三種子玩法都是「決定出輸家就結束」,沒有最終勝利者概念 → 一律不回傳贏家
  winner() {
    return null;
  },

  publicView(round, match, players) {
    return {
      phase: round.phase,
      order: round.order,
      rolled: round.rolled,
      diceLeft: match.diceLeft,
      subGame: round.subGame,
      chooserId: round.chooserId,
      condition: round.condition,
      openPick: round.openPick,
      subGames: this.subGames,
      // 由輸家決定:指定決定者(已離場則視為不限制)
      decider: (round.decider && round.order.includes(round.decider)) ? round.decider : null,
      reveal: round.reveal,
    };
  },

  privateView(round, player) {
    const hand = (round.hands && round.hands[player.id]) || [];
    // 紅黑單雙開牌後「搖下一骰」:已自行搖了下一骰的玩家,個人視角前進到 rolling
    // (看不到上一骰開牌),其餘玩家仍停在 reveal 看點數,直到自己按下才前進。
    const advanced = round.phase === 'reveal'
      && round.subGame === 'redblack'
      && round.rolled.includes(player.id);
    const effPhase = advanced ? 'rolling' : round.phase;
    // 只剩 1 顆 → 盲骰:開牌前連自己也看不到點數
    const blind = hand.length === 1 && effPhase !== 'reveal' && effPhase !== 'roundEnd';
    const out = { myDice: blind ? [] : hand, blind };
    if (advanced) { out.phase = 'rolling'; out.reveal = null; }
    return out;
  },

  // 有玩家離開時:話胚比較中需重新評定最小者
  refreshPoker(round, match) {
    if (round.subGame === 'poker' && round.phase === 'pokerCompare') resolvePoker(round, match);
  },
};

// 吹牛開盅:統計各點數數量,公開所有骰子;等房主選輸家後才結束本場
function resolveBluff(round, match) {
  const stats = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const id of round.order) {
    for (const d of round.hands[id] || []) stats[d] = (stats[d] || 0) + 1;
  }
  round.condition = null;
  round.phase = 'pickLoser'; // 等房主選輸家後才進 roundEnd
  round.reveal = {
    subGame: 'bluff',
    stats,
    hands: round.hands,
    removed: {},
    losers: [],
    pending: true, // 等房主選輸家
  };
}

// 話胚開牌/重比:評定每人牌型,標出最小者(可重骰或認輸)
function resolvePoker(round, match) {
  const evals = {};
  for (const id of round.order) evals[id] = evalHand(round.hands[id] || []);
  let minArr = null;
  for (const id of round.order) {
    if (minArr === null || cmpHand(evals[id].arr, minArr) < 0) minArr = evals[id].arr;
  }
  const lowestIds = round.order.filter((id) => cmpHand(evals[id].arr, minArr) === 0);
  const ranks = {};
  for (const id of round.order) ranks[id] = evals[id].label;

  // 重骰次數:剛「進入最小」的玩家補滿(換人又換回來會重置);續留最小者沿用剩餘
  const prevLowest = (round.reveal && round.reveal.lowestIds) || [];
  if (!round.rerolls) round.rerolls = {};
  if (!round.lockUsed) round.lockUsed = {};
  for (const id of lowestIds) {
    if (!prevLowest.includes(id)) {
      round.rerolls[id] = START_REROLLS;
      round.lockUsed[id] = false; // 新的一段最小期間 → 鎖定罰則重置
    }
  }
  // 鎖定狀態:最小者(集合)有變 → 清空(換人重置);續留則保留
  const sameLowest = lowestIds.length === prevLowest.length && lowestIds.every((id) => prevLowest.includes(id));
  if (!sameLowest) { round.pokerLocked = []; round.pokerLockBy = null; }

  round.condition = null;
  round.phase = 'pokerCompare';
  round.reveal = {
    subGame: 'poker',
    hands: round.hands,  // 公開所有骰子
    ranks,               // playerId -> 牌型名稱
    lowestIds,           // 牌型最小者(顯示外框 + 可重骰/認輸)
    rerolls: round.rerolls, // playerId -> 剩餘重骰次數
    lockUsed: round.lockUsed, // playerId -> 本段是否已用過鎖定(已付過罰則)
    locked: round.pokerLocked || [],   // 鎖定的骰子索引(所有人可見)
    lockBy: round.pokerLockBy || null, // 鎖定者
    loserId: (round.reveal && round.reveal.loserId) || null,
    loseBy: (round.reveal && round.reveal.loseBy) || null,
    lastRoll: null,      // 最近一次重骰 { id, idx, seq };重骰動作會覆寫
    removed: {},
    losers: [],
    pending: false,
  };
}

function resolveRedBlack(round, match, condId, cond) {
  const removed = {};
  const removedIdx = {}; // 每人「要被拿掉」的骰子索引(前端據此畫叉,不必自行重算條件)
  for (const id of round.order) {
    const hand = round.hands[id] || [];
    const idxs = [];
    hand.forEach((d, i) => { if (cond.match(d)) idxs.push(i); });
    removedIdx[id] = idxs;
    removed[id] = idxs.length;
    match.diceLeft[id] = Math.max(0, (match.diceLeft[id] || 0) - idxs.length);
  }
  const losers = round.order.filter((id) => (match.diceLeft[id] || 0) === 0);
  const aliveCount = round.order.filter((id) => (match.diceLeft[id] || 0) > 0).length;
  round.condition = condId;
  // 有人歸零(或只剩一人)→ 整場結束;否則進入 reveal 等玩家搖下一骰
  round.phase = (losers.length > 0 || aliveCount <= 1) ? 'roundEnd' : 'reveal';
  round.reveal = {
    subGame: 'redblack',
    condition: condId,
    conditionName: cond.name,
    hands: round.hands, // 開牌:公開本骰所有骰子
    removed,            // 每人被拿掉幾顆
    removedIdx,         // 每人被拿掉的骰子索引(前端畫叉用)
    losers,             // 失去所有骰子者(輸)
    pending: false,
  };
  if (round.phase === 'reveal') {
    // 進入「搖下一骰」:清空當前手牌與搖骰紀錄,讓每位玩家各自獨立搖下一骰。
    // (reveal.hands 已指向舊的 hands 物件,重新指派 round.hands 不影響開牌顯示。)
    round.hands = {};
    round.rolled = [];
  }
}
