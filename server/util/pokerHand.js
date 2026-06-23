// 撲克骰牌型評估(話胚 / 手速骰共用)
// 點數強弱:1 > 6 > 5 > 4 > 3 > 2(數字越大代表越強,用於同牌型內比較)
export const FS = { 1: 6, 6: 5, 5: 4, 4: 3, 3: 2, 2: 1 };

// 評估一手骰子 → { arr, label }
// arr[0] 為牌型大分類(越大越好),其後為同型內的比較鍵(逐項比,越大越好)
// 牌型(高→低):豹子(五同) > 鐵支(四同) > 順子 > 葫蘆 > 三條 > 兩對 > 一對 > 散牌
// arr[0]:散牌1 / 一對2 / 兩對3 / 三條4 / 葫蘆5 / 順子6 / 鐵支7 / 豹子9
export function evalHand(dice) {
  const count = {};
  for (const v of dice) count[v] = (count[v] || 0) + 1;
  const faces = Object.keys(count).map(Number);
  // 依「數量多→少、強弱大→小」排序的點數
  const byRank = faces.slice().sort((a, b) => count[b] - count[a] || FS[b] - FS[a]);
  const allDesc = dice.slice().sort((a, b) => FS[b] - FS[a]).map((v) => FS[v]); // 全部點數強弱(大→小)

  // 豹子(五個同點)→ 最大;同為豹子比點數 1>6>5>4>3>2(例:五個4 → 「4豹子」)
  const five = byRank.find((f) => count[f] === 5);
  if (five != null) return { arr: [9, FS[five]], label: `${five}豹子` };

  // 鐵支(四條)
  const quad = byRank.find((f) => count[f] === 4);
  if (quad != null) {
    const kicker = byRank.find((f) => f !== quad);
    return { arr: [7, FS[quad], kicker != null ? FS[kicker] : 0], label: '鐵支' };
  }

  const triple = byRank.find((f) => count[f] === 3);
  const pairs = byRank.filter((f) => count[f] === 2);

  // 順子(5 顆且為 12345 或 23456;12345 > 23456)— 大於葫蘆
  if (dice.length === 5 && faces.length === 5) {
    const s = new Set(faces);
    const low = [1, 2, 3, 4, 5].every((x) => s.has(x));
    const high = [2, 3, 4, 5, 6].every((x) => s.has(x));
    if (low || high) return { arr: [6, low ? 1 : 0], label: '順子' };
  }

  // 葫蘆(3 + 2)
  if (triple != null && pairs.length >= 1) {
    return { arr: [5, FS[triple], FS[pairs[0]]], label: '葫蘆' };
  }

  // 三條
  if (triple != null) {
    const k = byRank.filter((f) => f !== triple).map((f) => FS[f]).sort((a, b) => b - a);
    return { arr: [4, FS[triple], ...k], label: '三條' };
  }

  // 兩對
  if (pairs.length >= 2) {
    const pv = pairs.map((f) => FS[f]).sort((a, b) => b - a);
    const k = byRank.filter((f) => count[f] === 1).map((f) => FS[f]).sort((a, b) => b - a);
    return { arr: [3, pv[0], pv[1], ...k], label: '兩對' };
  }

  // 一對
  if (pairs.length === 1) {
    const k = byRank.filter((f) => count[f] === 1).map((f) => FS[f]).sort((a, b) => b - a);
    return { arr: [2, FS[pairs[0]], ...k], label: '一對' };
  }

  // 散牌(比最大單點)
  return { arr: [1, ...allDesc], label: '散牌' };
}

// 比較兩個 arr(逐項,大者勝);回傳 >0 代表 a 較大
export function cmpHand(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
