// 混合模式 — 從 5 顆暗骰開始的對局
// 流程(每一輪迴圈):
//   rolling   各自搖暗骰(只看得到自己)
//   choosing  任何人先按就決定這局子玩法(目前:紅黑單雙)
//   condition 由「先按的人」選一個條件
//   roundEnd  全部開牌,符合條件的骰子被拿掉(diceLeft 減少)
// 重複迴圈(按「下一輪」重搖剩餘骰子),直到有一人/多人失去所有骰子 = 輸,本場結束。
import { rollDice } from '../util/rng.js';

const START_DICE = 5;

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
  name: '混合模式',
  minPlayers: 2,
  implemented: true,
  startDice: START_DICE,

  // 可選子玩法清單(逐步擴充)
  subGames: [
    { id: 'redblack', name: '紅黑單雙', implemented: true },
    { id: 'bluff', name: '吹牛', implemented: true },
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

  handleAction(round, match, player, action, players) {
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };

    // 各自搖暗骰(rolling;或在 reveal 階段按「搖下一骰」接續同場下一骰)
    if (action.type === 'roll') {
      if (round.phase === 'reveal') {
        // 開牌看完 → 開始同一場的下一骰
        round.phase = 'rolling';
        round.hands = {};
        round.rolled = [];
        round.reveal = null;
        round.condition = null;
      }
      if (round.phase !== 'rolling') return { error: '現在不是搖骰階段' };
      if (round.rolled.includes(player.id)) return { error: '你已經搖過了' };
      round.hands[player.id] = rollDice(match.diceLeft[player.id]);
      round.rolled.push(player.id);
      if (round.order.every((id) => round.rolled.includes(id))) {
        if (round.subGame) {
          // 第二骰起:直接選條件,且開放任何人先按先決定
          round.phase = 'condition';
          round.openPick = true;
          round.chooserId = null;
        } else {
          round.phase = 'choosing';
        }
      }
      return { ok: true };
    }

    // 選玩法:任何人先按先決定(整場只在開頭一次)→ 由他選第一次條件
    if (action.type === 'chooseSubGame') {
      if (round.phase !== 'choosing') return { error: '現在不能選玩法' };
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
      round.chooserId = player.id; // 第一次條件由選玩法的人決定
      round.openPick = false;
      round.phase = 'condition';
      return { ok: true, chosen: sg.id };
    }

    // 吹牛:抓(開盅)→ 公開所有人骰子 + 各點數統計,開盅即結束本場
    if (action.type === 'grab') {
      if (round.phase !== 'bluffReady') return { error: '現在不能開盅' };
      if (!round.order.every((id) => round.rolled.includes(id))) {
        return { error: '還有人沒搖骰' };
      }
      resolveBluff(round, match);
      return { ok: true, revealed: true };
    }

    // 選條件 → 開牌結算
    if (action.type === 'chooseCondition') {
      if (round.phase !== 'condition') return { error: '現在不能選條件' };
      // 第一次:只有選玩法的人能決定;第二骰起:任何人先按先決定
      if (!round.openPick && player.id !== round.chooserId) {
        return { error: '只有選玩法的人能決定' };
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
    if (match.bluffOver) return true; // 吹牛開盅即結束本場
    const counts = players.map((p) => match.diceLeft[p.id] ?? 0);
    if (counts.some((c) => c === 0)) return true;
    return counts.filter((c) => c > 0).length <= 1;
  },

  // 僅剩一位有骰子 → 該位獲勝;否則無單一贏家(由 reveal.losers 呈現輸家)
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
      subGame: round.subGame,
      chooserId: round.chooserId,
      condition: round.condition,
      openPick: round.openPick,
      subGames: this.subGames,
      reveal: round.reveal,
    };
  },

  privateView(round, player) {
    const hand = (round.hands && round.hands[player.id]) || [];
    // 只剩 1 顆 → 盲骰:開牌前連自己也看不到點數
    const blind = hand.length === 1 && round.phase !== 'reveal' && round.phase !== 'roundEnd';
    return { myDice: blind ? [] : hand, blind };
  },
};

// 吹牛開盅:統計各點數數量,公開所有骰子;開盅即本場結束 → 回大廳「再來一場」
function resolveBluff(round, match) {
  const stats = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const id of round.order) {
    for (const d of round.hands[id] || []) stats[d] = (stats[d] || 0) + 1;
  }
  round.condition = null;
  round.phase = 'roundEnd';  // 結束本場(不像紅黑會繼續搖下一骰)
  match.bluffOver = true;    // 讓 isMatchOver 判定本場已結束
  round.reveal = {
    subGame: 'bluff',
    stats,
    hands: round.hands, // 開盅:公開所有骰子
    removed: {},        // 吹牛不拿骰、不淘汰
    losers: [],
    pending: false,
  };
}

function resolveRedBlack(round, match, condId, cond) {
  const removed = {};
  for (const id of round.order) {
    const hand = round.hands[id] || [];
    const cnt = hand.filter(cond.match).length;
    removed[id] = cnt;
    match.diceLeft[id] = Math.max(0, (match.diceLeft[id] || 0) - cnt);
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
    losers,             // 失去所有骰子者(輸)
    pending: false,
  };
}
