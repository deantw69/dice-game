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

app.use(express.static(PUBLIC_DIR));

// 把房間狀態(個人化視圖)推送給每位成員
function broadcastRoom(room) {
  if (!room) return;
  for (const p of [...room.players, ...room.spectators]) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('roomState', rm.viewFor(room, p.id));
    }
  }
}

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  socket.on('createRoom', ({ name }, cb) => {
    name = (name || '').trim();
    if (!name) return cb?.({ error: '請輸入暱稱' });
    const { room, player } = rm.createRoom(name, socket.id);
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

  socket.on('setLoserDecides', ({ on }, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me || room.hostId !== me.id) return cb?.({ error: '只有房主能設定' });
    room.loserDecides = !!on;
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
  });

  socket.on('action', (action, cb) => {
    const room = rm.findRoomBySocket(socket.id);
    if (!room) return cb?.({ error: '尚未加入房間' });
    const me = playerBySocket(room, socket.id);
    if (!me) return cb?.({ error: '找不到你的座位' });
    const res = gc.handleAction(room, me, action || {});
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
    broadcastRoom(room);
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

function playerBySocket(room, socketId) {
  return [...room.players, ...room.spectators].find((p) => p.socketId === socketId) || null;
}

httpServer.listen(PORT, () => {
  console.log(`🎲 Dice game server running at http://localhost:${PORT}`);
  console.log(`   骰子動畫 demo: http://localhost:${PORT}/demo.html`);
});
