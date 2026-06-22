// 房間管理(in-memory)— 建房 / 加入 / 重連 / 成員與視圖
import { randomBytes } from 'node:crypto';
import { MODES, MODE_LIST } from './games/index.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混字元 (0,O,1,I,L)
const CODE_LEN = 4;
const DISCONNECT_GRACE_MS = 30_000;

/** @type {Map<string, object>} code -> room */
const rooms = new Map();

function genCode() {
  let code;
  do {
    const bytes = randomBytes(CODE_LEN);
    code = Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (rooms.has(code));
  return code;
}

function genId() {
  return randomBytes(8).toString('hex');
}

function makePlayer(name, socketId) {
  return { id: genId(), name, socketId, connected: true, disconnectTimer: null };
}

const CUSTOM_CODE_RE = /^[A-Z0-9]{4}$/; // 自選房號:4 碼英數(大寫)

export function createRoom(name, socketId, customCode) {
  let code;
  if (customCode != null && String(customCode).trim() !== '') {
    code = String(customCode).trim().toUpperCase();
    if (!CUSTOM_CODE_RE.test(code)) return { error: '房號需為 4 碼英數字' };
    if (rooms.has(code)) return { error: '此房號已被使用,請換一個' };
  } else {
    code = genCode();
  }
  const host = makePlayer(name, socketId);
  const room = {
    code,
    hostId: host.id,
    modeId: null,
    diceCount: 3,        // 純搖骰用
    status: 'lobby',     // lobby | playing
    players: [host],     // 正式參與者
    spectators: [],      // 等待下一輪加入
    away: [],            // 暫離觀戰區(房主丟入;需按「我回來了」才會回到 spectators)
    match: null,         // 整場狀態(吹牛骰)
    matchOver: false,
    round: null,         // 當前一輪
    winnerId: null,
    losses: {},          // playerId -> 累計輸的次數
    lastLosers: [],      // 上一場的輸家(供「由輸家決定」用)
    loserDecides: false, // 混合模式:由上一局輸家決定玩法(房主開關)
    autoRotate: false,   // 紅黑單雙:之後每骰由列表順位下一位決定條件(房主開關)
  };
  rooms.set(code, room);
  return { room, player: host };
}

export function joinRoom(code, name, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: '找不到此房間' };
  // 重名檢查涵蓋三區(含暫離 away),避免暫離者暱稱被重用造成兩個同名玩家
  if (allMembers(room).some((p) => p.name === name)) return { error: '此房間已有人用這個暱稱' };

  const player = makePlayer(name, socketId);
  if (room.status === 'playing') {
    room.spectators.push(player);
    return { room, player, asSpectator: true };
  }
  room.players.push(player);
  return { room, player, asSpectator: false };
}

// 以 playerId 重連(換了 socket / 重新整理)
export function rejoin(code, playerId, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: '房間已不存在' };
  const player = findPlayer(room, playerId);
  if (!player) return { error: '座位已不存在' };
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  player.socketId = socketId;
  player.connected = true;
  return { room, player };
}

// 房間全部成員(含暫離區)
function allMembers(room) {
  return [...room.players, ...room.spectators, ...(room.away || [])];
}

export function findPlayer(room, playerId) {
  return allMembers(room).find((p) => p.id === playerId) || null;
}

export function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (allMembers(room).some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

export function getRoom(code) {
  return rooms.get(code);
}

export function getRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    const host = room.players.find((p) => p.id === room.hostId);
    list.push({
      code: room.code,
      hostName: host?.name || '?',
      playerCount: room.players.length,
      spectatorCount: room.spectators.length,
      status: room.status,
      modeId: room.modeId,
    });
  }
  return list;
}

// socket 斷線:給予寬限期,逾時移除座位
export function handleDisconnect(socketId, onTimeout) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;
  const player = allMembers(room).find((p) => p.socketId === socketId);
  if (!player) return null;
  player.connected = false;
  player.disconnectTimer = setTimeout(() => {
    removePlayer(room, player.id);
    onTimeout?.(room, player.id);
  }, DISCONNECT_GRACE_MS);
  return room;
}

export function removePlayer(room, playerId) {
  room.players = room.players.filter((p) => p.id !== playerId);
  room.spectators = room.spectators.filter((p) => p.id !== playerId);
  room.away = (room.away || []).filter((p) => p.id !== playerId);

  // 房主移交
  if (room.hostId === playerId && room.players.length > 0) {
    room.hostId = room.players[0].id;
  }
  // 房間清空 → 刪除
  if (room.players.length === 0 && room.spectators.length === 0 && room.away.length === 0) {
    rooms.delete(room.code);
  }
}

// 房主把玩家丟入暫離觀戰區(從 players / spectators 移到 away)
export function benchPlayer(room, targetId) {
  let idx = room.players.findIndex((p) => p.id === targetId);
  let pl = null;
  if (idx !== -1) { [pl] = room.players.splice(idx, 1); }
  else {
    idx = room.spectators.findIndex((p) => p.id === targetId);
    if (idx !== -1) [pl] = room.spectators.splice(idx, 1);
  }
  if (!pl) return { error: '找不到該玩家' };
  if (!room.away) room.away = [];
  room.away.push(pl);
  // 房主被丟(理論上禁止)→ 移交
  if (room.hostId === targetId && room.players.length > 0) room.hostId = room.players[0].id;
  return { room, player: pl };
}

// 暫離玩家按「我回來了」→ 移到 spectators(下一輪併入)
export function imBack(room, playerId) {
  const idx = (room.away || []).findIndex((p) => p.id === playerId);
  if (idx === -1) return { error: '你不在暫離區' };
  const [pl] = room.away.splice(idx, 1);
  room.spectators.push(pl);
  return { room, player: pl };
}

// 房主手動指定玩家順序;orderedIds 必須是現有 players 的合法重排(同一組 id、不多不少)
export function reorderPlayers(room, orderedIds) {
  if (!Array.isArray(orderedIds)) return { error: '順序格式錯誤' };
  const cur = room.players.map((p) => p.id);
  if (orderedIds.length !== cur.length) return { error: '順序不完整' };
  const want = new Set(orderedIds);
  if (want.size !== orderedIds.length) return { error: '順序有重複' };
  if (!cur.every((id) => want.has(id))) return { error: '順序與玩家不符' };
  const byId = new Map(room.players.map((p) => [p.id, p]));
  room.players = orderedIds.map((id) => byId.get(id));
  return { room };
}

// 隨機打亂玩家順序(Fisher-Yates)
export function shufflePlayers(room) {
  const a = room.players;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// 場上已無正式玩家但仍有觀戰者 → 自動把觀戰者轉為玩家;並確保房主存在於玩家中
// (避免出現「房內 0 玩家、沒有房主、卻有觀戰者」的卡住狀態)
export function ensurePlayers(room) {
  if (room.players.length === 0 && room.spectators.length > 0) {
    room.players.push(...room.spectators);
    room.spectators = [];
  }
  if (room.players.length > 0 && !room.players.some((p) => p.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }
}

// 把觀戰者併入正式玩家(於開始新一輪時呼叫)
export function mergeSpectators(room) {
  if (room.spectators.length === 0) return;
  room.players.push(...room.spectators);
  room.spectators = [];
}

// 為特定玩家建立可見視圖(隱藏他人秘密資訊)
export function viewFor(room, viewerId) {
  const mode = room.modeId ? MODES[room.modeId] : null;
  const isSpectator = room.spectators.some((p) => p.id === viewerId);
  const isAway = (room.away || []).some((p) => p.id === viewerId);

  const view = {
    code: room.code,
    hostId: room.hostId,
    modeId: room.modeId,
    diceCount: room.diceCount,
    status: room.status,
    matchOver: room.matchOver,
    winnerId: room.winnerId,
    losses: room.losses || {},
    loserDecides: !!room.loserDecides,
    autoRotate: !!room.autoRotate,
    blackjackLives: room.blackjackLives ?? 3,
    rouletteLives: room.rouletteLives ?? 3,
    roulettePasses: room.roulettePasses ?? 1,
    modes: MODE_LIST,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    spectators: room.spectators.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    away: (room.away || []).map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    you: { id: viewerId, isHost: room.hostId === viewerId, isSpectator, isAway },
    game: null,
  };

  if (mode && room.round) {
    const viewer = findPlayer(room, viewerId);
    let pub;
    let priv = {};
    if (typeof mode.initMatch === 'function') {
      // 整場狀態模式(吹牛骰 / 混合模式)
      pub = mode.publicView(room.round, room.match, room.players);
      if (viewer) priv = mode.privateView(room.round, viewer);
    } else {
      pub = mode.publicView(room.round, room.players);
      if (viewer) priv = mode.privateView(room.round, viewer);
    }
    view.game = { mode: mode.id, ...pub, ...priv };
  }
  return view;
}
