import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as rm from './roomManager.js';
import * as gc from './gameController.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// 版本資訊:用 Render 的 git commit 短碼,方便辨認線上是哪一版(本機為 dev)
const COMMIT = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev';
app.get('/version', (_req, res) => res.json({ commit: COMMIT }));

app.use(express.static(PUBLIC_DIR));

function broadcastRoomList() {
  io.emit('roomListUpdate', rm.getRoomList());
}

// 把房間狀態(個人化視圖)推送給每位成員
function broadcastRoom(room) {
  if (!room) return;
  for (const p of [...room.players, ...room.spectators, ...(room.away || [])]) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('roomState', rm.viewFor(room, p.id));
    }
  }
  broadcastRoomList();
}

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  socket.on('listRooms', (_payload, cb) => {
    // 前端 emit('listRooms') 經 net.js 會送出 (undefined, ack),cb 在第二位
    cb?.({ rooms: rm.getRoomList() });
  });

  socket.on('createRoom', ({ name, code }, cb) => {
    name = (name || '').trim();
    if (!name) return cb?.({ error: '請輸入暱稱' });
    const res = rm.createRoom(name, socket.id, code);
    if (res.error) return cb?.({ error: res.error });
    const { room, player } = res;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, playerId: player.id });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = (code || '').trim().toUpperCase();
    name = (name || '').trim();
    if (!name) return cb?.({ error: '請輸入暱稱' });
    const res = rm.joinRoom(code, name, socket.id);
    if (res.error) return cb?.({ error: res.error });
    socket.join(code);
    cb?.({ ok: true, code, playerId: res.player.id, asSpectator: res.asSpectator });
    broadcastRoom(res.room);
  });

  // 重連 / 重新整理後回到房間
  socket.on('rejoin', ({ code, playerId }, cb) => {
    code = (code || '').trim().toUpperCase();
    const res = rm.rejoin(code, playerId, socket.id);
    if (res.error) return cb?.({ error: res.error });
    socket.join(code);
    cb?.({ ok: true, code });
    broadcastRoom(res.room);
  });

  socket.on('setMode', ({ modeId }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    const res = gc.setMode(room, me.id, modeId);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setDiceCount', ({ count }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    const res = gc.setDiceCount(room, me.id, count);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setRouletteLives', ({ value }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.rouletteLives = Math.max(0, Math.min(10, parseInt(value) || 0));
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setRouletteBust', ({ value }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    // rouletteBust 已改為每回合隨機隱藏,保留事件但不動作
    cb?.({ ok: true });
  });

  socket.on('setRoulettePasses', ({ value }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.roulettePasses = Math.max(0, Math.min(3, parseInt(value) || 1));
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setBlackjackLives', ({ value }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.blackjackLives = Math.max(0, Math.min(10, parseInt(value) || 0));
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setSpeedSeconds', ({ value }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.speedSeconds = Math.max(10, Math.min(60, parseInt(value) || 30));
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setLoserDecides', ({ on }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.loserDecides = !!on;
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('shufflePlayers', (_payload, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能打亂順序' });
    rm.shufflePlayers(room);
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  // 房主手動排序玩家(只在大廳;開局後順序已鎖進回合)
  socket.on('reorderPlayers', ({ order } = {}, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能調整順序' });
    if (room.status !== 'lobby') return cb?.({ error: '遊戲進行中無法調整順序' });
    const res = rm.reorderPlayers(room, order);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('setAutoRotate', ({ on }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.autoRotate = !!on;
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('startRound', (_payload, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    const res = gc.startRound(room, me.id);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
    if (room.modeId === 'speed') armSpeedTimers(room); // 手速骰:排程揭題/截止計時器
    if (room.modeId === 'roulette') armRouletteAutoRoll(room); // 驚爆骰:安全區自動骰
  });

  socket.on('action', (action, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me) return cb?.({ error: '找不到你的座位' });
    const res = gc.handleAction(room, me, action || {});
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true, cooldown: res.cooldown, retryMs: res.retryMs });
    broadcastRoom(room);
    if (room.modeId === 'roulette') armRouletteAutoRoll(room); // 驚爆骰:手動骰後繼續自動骰
    // 手速骰:達標判定延遲到骰子動畫跑完,所有玩家同步看到結果
    if (res.pendingAchieve) {
      const { pendingAchieve: pid, rollSeq, speedId } = res;
      setTimeout(() => {
        if (gc.speedConfirmAchieve(room, pid, rollSeq, speedId)) broadcastRoom(room);
      }, 1500);
    }
  });

  socket.on('leaveRoom', (_p, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (room) {
      const me = playerBySocket(room, socket.id);
      const leftId = me ? me.id : null;
      if (leftId) rm.removePlayer(room, leftId);
      socket.leave(room.code);
      if (leftId) gc.onPlayerLeft(room, leftId); // 離開後重新判定回合
      broadcastRoom(room);
    }
    cb?.({ ok: true });
  });

  socket.on('forceReset', (_payload, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    const res = gc.forceReset(room, me.id);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('transferHost', ({ targetId }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能指定房主' });
    if (targetId === me.id) return cb?.({ error: '你已經是房主' });
    const target = rm.findPlayer(room, targetId);
    if (!target) return cb?.({ error: '找不到該玩家' });
    room.hostId = targetId;
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('kickPlayer', ({ targetId }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能踢人' });
    if (targetId === me.id) return cb?.({ error: '不能踢自己' });
    const target = rm.findPlayer(room, targetId);
    if (!target) return cb?.({ error: '找不到該玩家' });

    // 通知並讓被踢者離開房間頻道
    if (target.socketId) {
      io.to(target.socketId).emit('kicked', { by: me.name });
      const tsock = io.sockets.sockets.get(target.socketId);
      if (tsock) tsock.leave(room.code);
    }
    if (target.disconnectTimer) { clearTimeout(target.disconnectTimer); target.disconnectTimer = null; }
    rm.removePlayer(room, targetId);
    gc.onPlayerLeft(room, targetId); // 踢人後重新判定回合
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  // 房主把(閒置)玩家丟入暫離觀戰區
  socket.on('benchPlayer', ({ targetId }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能操作' });
    if (targetId === me.id) return cb?.({ error: '不能把自己丟入暫離區' });
    const res = rm.benchPlayer(room, targetId);
    if (res.error) return cb?.({ error: res.error });
    gc.onPlayerLeft(room, targetId); // 移出後重新判定回合
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  // 玩家把自己丟入暫離觀戰區(房主自己暫離會自動把房主轉給下一位)
  socket.on('benchSelf', (_payload, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me) return cb?.({ error: '找不到你的座位' });
    const res = rm.benchPlayer(room, me.id); // 內部會處理房主轉移
    if (res.error) return cb?.({ error: res.error });
    gc.onPlayerLeft(room, me.id); // 移出後重新判定回合
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  // 暫離玩家按「我回來了」→ 回到 spectators(下一局加入)
  socket.on('imBack', (_payload, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me) return cb?.({ error: '找不到你' });
    const res = rm.imBack(room, me.id);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected: ${socket.id} (${reason})`);
    rm.handleDisconnect(socket.id, (room, pid) => {
      gc.onPlayerLeft(room, pid); // 逾時移除後重新判定回合
      broadcastRoom(room);
    });
    const room = rm.findRoomBySocket(socket.id);
    broadcastRoom(room); // 立即反映「離線」狀態
  });
});

// 手速骰計時器:T1 揭題(targetAt)、T2 截止(deadlineAt)。
// 用 round.speedId 當 nonce —— 回呼觸發時若該局已換新/結束,phase/nonce/status 驗證會讓它自動 no-op,
// 因此不必在每條離開/重來路徑手動清除計時器。
function armSpeedTimers(room) {
  const round = room.round;
  if (!round || room.modeId !== 'speed') return;
  const id = round.speedId;
  const now = Date.now();

  setTimeout(() => {
    const r = room.round;
    if (!r || r.speedId !== id || room.status !== 'playing' || r.phase !== 'countdown') return;
    gc.speedReveal(room);
    broadcastRoom(room);
  }, Math.max(0, round.targetAt - now));

  setTimeout(() => {
    const r = room.round;
    if (!r || r.speedId !== id || room.status !== 'playing' || r.phase !== 'racing') return;
    gc.speedTimeout(room);
    broadcastRoom(room);
  }, Math.max(0, round.deadlineAt - now));
}

const ROULETTE_AUTO_DELAY = 400; // ms between each auto-roll step
function armRouletteAutoRoll(room) {
  if (!gc.rouletteNeedsAutoRoll(room)) return;
  setTimeout(() => {
    if (!room.round || room.status !== 'playing' || room.modeId !== 'roulette') return;
    if (!gc.rouletteAutoRollOnce(room)) return;
    broadcastRoom(room);
    armRouletteAutoRoll(room);
  }, ROULETTE_AUTO_DELAY);
}

function playerBySocket(room, socketId) {
  return [...room.players, ...room.spectators, ...(room.away || [])].find((p) => p.socketId === socketId) || null;
}

httpServer.listen(PORT, () => {
  console.log(`🎲 Dice game server running at http://localhost:${PORT}`);
  console.log(`   骰子動畫 demo: http://localhost:${PORT}/demo.html`);
});
