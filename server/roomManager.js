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

export function createRoom(name, socketId) {
  const code = genCode();
  const host = makePlayer(name, socketId);
  const room = {
    code,
    hostId: host.id,
    modeId: null,
    diceCount: 3,        // 純搖骰用
    status: 'lobby',     // lobby | playing
    players: [host],     // 正式參與者
    spectators: [],      // 等待下一輪加入
    match: null,         // 整場狀態(吹牛骰)
    matchOver: false,
    round: null,         // 當前一輪
    winnerId: null,
  };
  rooms.set(code, room);
  return { room, player: host };
}

export function joinRoom(code, name, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: '找不到此房間' };
  const all = [...room.players, ...room.spectators];
  if (all.some((p) => p.name === name)) return { error: '此房間已有人用這個暱稱' };

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

export function findPlayer(room, playerId) {
  return [...room.players, ...room.spectators].find((p) => p.id === playerId) || null;
}

export function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if ([...room.players, ...room.spectators].some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

export function getRoom(code) {
  return rooms.get(code);
}

// socket 斷線:給予寬限期,逾時移除座位
export function handleDisconnect(socketId, onTimeout) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;
  const player = [...room.players, ...room.spectators].find((p) => p.socketId === socketId);
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

  // 房主移交
  if (room.hostId === playerId && room.players.length > 0) {
    room.hostId = room.players[0].id;
  }
  // 房間清空 → 刪除
  if (room.players.length === 0 && room.spectators.length === 0) {
    rooms.delete(room.code);
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

  const view = {
    code: room.code,
    hostId: room.hostId,
    modeId: room.modeId,
    diceCount: room.diceCount,
    status: room.status,
    matchOver: room.matchOver,
    winnerId: room.winnerId,
    modes: MODE_LIST,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    spectators: room.spectators.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    you: { id: viewerId, isHost: room.hostId === viewerId, isSpectator },
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
