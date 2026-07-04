// 手速骰(speed)— 即時同步競速模式(專案第一個用伺服器計時器的模式)
// 流程:countdown(倒數 3-2-1) → racing(揭題,全員同時各搖各的骰、無限重骰、可鎖骰)
//       揭題後不自動發骰,玩家自己按「搖骰」開始;搶先湊出「剛好指定撲克牌型」即達標安全。
// 輸家判定:當只剩 1 人未達標(N-1 人達標)→ 立刻結束、該人輸;
//           時間到仍有 ≥2 人未達標 → 未達標者全部輸。
// 淘汰制:生命數由房主設定(預設 3);設為 0 為單局模式、不淘汰。最後存活者為最終勝利者。
import { randomInt } from 'node:crypto';
import { rollDice } from '../util/rng.js';
import { evalHand } from '../util/pokerHand.js';

const REVEAL_DELAY_MS = 3000;        // 倒數 3-2-1
const ROLL_COOLDOWN_MS = 1000;       // 連續擲骰最小間隔(限制快速連按;伺服器權威)
const ACHIEVE_DELAY_MS = 1500;       // 達標判定延遲(等前端骰子動畫跑完再廣播)
const DEFAULT_SECONDS = 30;
const MIN_SECONDS = 10;
const MAX_SECONDS = 60;

// 題型 → arr[0] 牌型等級(散牌1/一對2/兩對3/三條4/葫蘆5/順子6/鐵支7/豹子9)
const RANK_LABEL = { 2: '一對', 3: '兩對', 4: '三條', 5: '葫蘆', 6: '順子', 7: '鐵支', 9: '豹子' };
// 預設隨機題池(排除散牌——達標無意義;也排除豹子——競速下過難。可微調)
const TARGET_POOL = [2, 3, 4, 5, 6, 7];

let speedSeq = 0; // 計時器失效用的 nonce 來源(每局遞增)

export const speedMode = {
  id: 'speed',
  name: '手速骰',
  minPlayers: 2,
  startSeconds: DEFAULT_SECONDS,

  initMatch(players, { seconds = DEFAULT_SECONDS, lives = 0 } = {}) {
    const l = {};
    for (const p of players) l[p.id] = lives;
    return {
      seconds: clampSeconds(seconds),
      lives: l,
      eliminated: [],
      startLives: lives,
    };
  },

  startRound(match, players, now) {
    const alive = match.startLives === 0
      ? players
      : players.filter(
          (p) => (match.lives[p.id] || 0) > 0 && !match.eliminated.includes(p.id),
        );
    const order = alive.map((p) => p.id);
    const targetRank = TARGET_POOL[randomInt(0, TARGET_POOL.length)];
    return {
      phase: 'countdown',             // countdown -> racing -> roundEnd
      order,
      targetRank,
      targetLabel: RANK_LABEL[targetRank],
      dice: {},                       // playerId -> [5 顆]
      locked: {},                     // playerId -> [鎖定索引]
      done: [],                       // 已達標的 playerId(順序即達標名次)
      doneAt: {},                     // playerId -> 達標時間
      lastRollAt: {},                 // playerId -> 上次擲骰時間(連續擲骰冷卻用)
      reveal: null,                   // roundEnd 後:{ losers }
      rolls: {},                      // playerId -> 已搖次數(前端據此觸發骰子動畫)
      speedId: ++speedSeq,            // 過期計時器自我失效用
      startAt: now,
      targetAt: now + REVEAL_DELAY_MS,
      deadlineAt: now + REVEAL_DELAY_MS + match.seconds * 1000,
    };
  },

  // T1:揭題。不自動發骰——玩家各自按「搖骰」開始(第一次 reroll 即首擲)
  reveal(round) {
    if (round.phase !== 'countdown') return;
    round.phase = 'racing';
  },

  handleAction(round, _match, player, action) {
    if (round.phase !== 'racing') return { error: '現在不能行動' };
    if (!round.order.includes(player.id)) return { error: '你不在本局中' };
    if (round.done.includes(player.id)) return { error: '你已達標' };

    if (action.type === 'setLock') {
      const n = (round.dice[player.id] || []).length;
      round.locked[player.id] = (Array.isArray(action.locked) ? action.locked : [])
        .filter((x) => Number.isInteger(x) && x >= 0 && x < n);
      return { ok: true };
    }

    if (action.type === 'reroll') {
      // 連續擲骰冷卻:距上次擲骰未滿 1.5 秒則拒絕(伺服器權威,防快速連按)
      const now = Date.now();
      const since = now - (round.lastRollAt[player.id] || 0);
      if (since < ROLL_COOLDOWN_MS) {
        return { ok: true, cooldown: true, retryMs: ROLL_COOLDOWN_MS - since };
      }
      round.lastRollAt[player.id] = now;
      const locked = (round.locked[player.id] || []).filter((x) => Number.isInteger(x));
      const cur = round.dice[player.id] || rollDice(5);
      const fresh = rollDice(5);
      round.dice[player.id] = cur.map((v, i) => (locked.includes(i) ? v : (fresh[i] ?? v)));
      round.rolls[player.id] = (round.rolls[player.id] || 0) + 1;
      const rollSeq = round.rolls[player.id];
      // 「剛好」指定牌型才算達標(非該牌型以上)
      // 不立刻 markDone — 回傳 pendingAchieve 讓 index.js 延遲 1.5s 再廣播,
      // 所有玩家都等骰子動畫跑完才看到達標結果
      if (evalHand(round.dice[player.id]).arr[0] === round.targetRank) {
        return { ok: true, pendingAchieve: player.id, rollSeq, speedId: round.speedId };
      }
      return { ok: true };
    }

    return { error: '無效動作' };
  },

  // N-1 人達標 → 只剩 1 人未達標即立刻結束、該人輸(不等截止)
  checkEarlyEnd(round, match) {
    if (round.phase !== 'racing' || round.order.length < 2) return;
    const remaining = round.order.filter((id) => !round.done.includes(id));
    if (remaining.length <= 1) {
      round.reveal = { losers: remaining };
      round.phase = 'roundEnd';
      if (match) deductLives(match, remaining);
    }
  },

  // T2:時間到,未達標者全部判輸
  resolveTimeout(round, match) {
    if (round.phase !== 'racing') return;
    const losers = round.order.filter((id) => !round.done.includes(id));
    round.reveal = { losers };
    round.phase = 'roundEnd';
    if (match) deductLives(match, losers);
  },

  // 玩家離開:清掉其在本局的所有痕跡;回傳此人原本是否在局內
  prune(round, leftId) {
    if (!round.order.includes(leftId)) return false;
    round.order = round.order.filter((id) => id !== leftId);
    round.done = round.done.filter((id) => id !== leftId);
    delete round.doneAt[leftId];
    delete round.dice[leftId];
    delete round.locked[leftId];
    delete round.rolls[leftId];
    delete round.lastRollAt[leftId];
    return true;
  },

  isRoundOver(round) {
    return round.phase === 'roundEnd';
  },
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
    const racing = round.phase !== 'countdown'; // 倒數時不洩題、不發骰
    return {
      phase: round.phase,
      order: round.order,
      targetRank: round.targetRank,
      targetLabel: racing ? round.targetLabel : null,
      dice: racing ? round.dice : {},
      locked: round.locked,
      done: round.done,
      doneAt: round.doneAt,
      reveal: round.reveal,
      rolls: round.rolls,
      startAt: round.startAt,
      targetAt: round.targetAt,
      deadlineAt: round.deadlineAt,
      serverNow: Date.now(),
      lives: match.lives,
      eliminated: match.eliminated,
    };
  },
  // 本模式無隱藏資訊,myDice/myLocked 只是方便前端取用
  privateView(round, player) {
    return {
      myDice: (round.dice && round.dice[player.id]) || [],
      myLocked: (round.locked && round.locked[player.id]) || [],
    };
  },
  // 延遲達標確認:由 index.js 在 ACHIEVE_DELAY_MS 後呼叫
  confirmAchieve(round, match, playerId, rollSeq) {
    if (round.phase !== 'racing') return false;
    if (round.done.includes(playerId)) return false;
    if ((round.rolls[playerId] || 0) !== rollSeq) return false;
    markDone(round, playerId, Date.now());
    this.checkEarlyEnd(round, match);
    return true;
  },

  achieveDelayMs: ACHIEVE_DELAY_MS,
};

function markDone(round, id, now) {
  if (round.done.includes(id)) return;
  round.done.push(id);
  round.doneAt[id] = now;
  delete round.locked[id];
}

function deductLives(match, losers) {
  if (match.startLives <= 0) return;
  for (const id of losers) {
    match.lives[id] = Math.max(0, (match.lives[id] || 0) - 1);
    if (match.lives[id] <= 0 && !match.eliminated.includes(id)) {
      match.eliminated.push(id);
    }
  }
}

function clampSeconds(s) {
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, parseInt(s) || DEFAULT_SECONDS));
}
