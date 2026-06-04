// 伺服器端骰子亂數 — 遊戲結果的唯一真實來源
import { randomInt } from 'node:crypto';

/** 擲一顆骰子,回傳 1~6 */
export function rollDie() {
  return randomInt(1, 7);
}

/** 擲 n 顆骰子,回傳長度 n 的陣列 */
export function rollDice(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(rollDie());
  return out;
}
