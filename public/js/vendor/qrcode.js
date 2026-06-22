// 極簡 QR Code 產生器(byte 模式,公有領域演算法 port 自 Nayuki qrcodegen)。
// 只對外提供 makeQrMatrix(text) → 回傳布林二維陣列(true 為深色),供 canvas 繪製。
// 自動選版本(1~40)與錯誤更正等級(優先 Q,放不下退到 M、L),足夠房間分享網址使用。

// ---- Galois field GF(256) 乘法(QR 多項式) ----
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// 產生 Reed-Solomon 除數多項式
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// 規格表:每塊 EC 碼字數,以 [eccLevel][version-1] 取值(index = version 1..40)
const ECC_CODEWORDS = {
  L: [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
};
const NUM_EC_BLOCKS = {
  L: [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
};

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver, ecl) {
  return Math.floor(numRawDataModules(ver) / 8)
    - ECC_CODEWORDS[ecl][ver - 1] * NUM_EC_BLOCKS[ecl][ver - 1];
}

function bytesOf(str) {
  return new TextEncoder().encode(str);
}

// 將資料以 byte 模式編成位元陣列,並加上模式/長度/結束符與 padding
function encodeData(dataBytes, ver, ecl) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); // byte 模式
  const ccBits = ver <= 9 ? 8 : 16;
  push(dataBytes.length, ccBits);
  for (const b of dataBytes) push(b, 8);

  const capacityBits = numDataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // 結束符
  while (bits.length % 8 !== 0) bits.push(0);
  // padding 位元組
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const dataCodewords = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) dataCodewords[i >>> 3] |= bits[i] << (7 - (i & 7));
  return dataCodewords;
}

// 交錯資料碼字與 EC 碼字
function addEcAndInterleave(data, ver, ecl) {
  const numBlocks = NUM_EC_BLOCKS[ecl][ver - 1];
  const blockEcLen = ECC_CODEWORDS[ecl][ver - 1];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = rsDivisor(blockEcLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEcLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    const block = Array.from(dat);
    if (i < numShortBlocks) block.push(0); // 短塊補位,交錯時略過
    block.push(...ecc);
    blocks.push(block);
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // 短塊在資料段末多一個佔位,交錯到資料尾欄時略過
      if (i !== shortBlockLen - blockEcLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return Uint8Array.from(result);
}

// ---- 矩陣繪製 ----
function makeMatrix(ver, ecl, codewords) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark; isFunction[y][x] = true;
  };

  // timing(先畫,finder 之後會覆蓋重疊處)
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // 找正方形(finder)
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3); drawFinder(size - 4, 3); drawFinder(3, size - 4);

  // 對齊圖樣
  const alignPos = (() => {
    if (ver === 1) return [];
    const num = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < num; p -= step) pos.splice(1, 0, p);
    return pos;
  })();
  for (const ay of alignPos) {
    for (const ax of alignPos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  // 預留格式/版本資訊區(先標記為功能區,稍後填值)
  for (let i = 0; i < 9; i++) { isFunction[i][8] = true; isFunction[8][i] = true; }
  for (let i = 0; i < 8; i++) { isFunction[size - 1 - i][8] = true; isFunction[8][size - 1 - i] = true; }
  setFn(8, size - 8, true); // 永遠深色模組
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      isFunction[size - 11 + j][i] = true; isFunction[i][size - 11 + j] = true;
    }
  }

  // 放置資料位元(zigzag)
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIdx < totalBits) {
          modules[y][x] = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
          bitIdx++;
        }
      }
    }
  }

  // 選最佳遮罩
  let bestMask = 0, bestPenalty = Infinity, bestModules = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = modules.map((row) => row.slice());
    applyMask(m, isFunction, mask);
    drawFormatBits(m, isFunction, ecl, mask, size);
    if (ver >= 7) drawVersion(m, ver, size);
    const p = penalty(m, size);
    if (p < bestPenalty) { bestPenalty = p; bestMask = mask; bestModules = m; }
  }
  return bestModules;
}

function applyMask(modules, isFunction, mask) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue;
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y][x] = !modules[y][x];
    }
  }
}

function drawFormatBits(modules, isFunction, ecl, mask, size) {
  const eccBits = { M: 0, L: 1, H: 2, Q: 3 }[ecl];
  const data = (eccBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const get = (i) => ((bits >>> i) & 1) !== 0;
  // 左上
  for (let i = 0; i <= 5; i++) modules[i][8] = get(i);
  modules[7][8] = get(6); modules[8][8] = get(7); modules[8][7] = get(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = get(i);
  // 右上 / 左下
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = get(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = get(i);
  modules[size - 8][8] = true;
}

function drawVersion(modules, ver, size) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3), b = Math.floor(i / 3);
    modules[a][b] = bit; modules[b][a] = bit;
  }
}

function penalty(modules, size) {
  let p = 0;
  // 連續同色
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === modules[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
      else run = 1;
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === modules[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
      else run = 1;
    }
  }
  // 2x2 同色
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++)
      if (modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) p += 3;
  // 深色比例
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

// 對外:回傳布林矩陣
export function makeQrMatrix(text) {
  const data = bytesOf(text);
  for (const ecl of ['Q', 'M', 'L']) {
    for (let ver = 1; ver <= 40; ver++) {
      const cap = numDataCodewords(ver, ecl);
      const ccBits = ver <= 9 ? 8 : 16;
      const needed = Math.ceil((4 + ccBits + data.length * 8) / 8);
      if (needed <= cap) {
        const dataCw = encodeData(data, ver, ecl);
        const all = addEcAndInterleave(dataCw, ver, ecl);
        return makeMatrix(ver, ecl, all);
      }
    }
  }
  throw new Error('資料過長,QR 無法容納');
}
