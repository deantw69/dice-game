// 首頁邏輯:取暱稱 + 建房 / 輸入房號加入 / 瀏覽現有房間
import { emit, saveSession, socket } from './net.js';

const $ = (id) => document.getElementById(id);
const nameInput = $('name');
const codeInput = $('code');
const customCodeInput = $('customCode');
const errEl = $('err');
const roomListEl = $('roomList');

// ---- 輸入記憶(localStorage) ----
const NAME_KEY = 'dice.lastName';
const CODE_KEY = 'dice.lastCode';
const CUSTOM_CODE_KEY = 'dice.lastCustomCode';

// 開頁時帶入上次輸入的暱稱 / 房號 / 自訂房號
nameInput.value = localStorage.getItem(NAME_KEY) || '';
codeInput.value = localStorage.getItem(CODE_KEY) || '';
customCodeInput.value = localStorage.getItem(CUSTOM_CODE_KEY) || '';

// 掃 QR 進來:網址帶 ?code=XXXX → 自動填房號、聚焦暱稱,只需輸入名稱即可加入
const urlCode = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
if (urlCode) {
  codeInput.value = urlCode;
  localStorage.setItem(CODE_KEY, urlCode);
  setTimeout(() => { nameInput.focus(); }, 0);
}

// 即時記憶
nameInput.addEventListener('input', () => localStorage.setItem(NAME_KEY, nameInput.value.trim()));
codeInput.addEventListener('input', () => localStorage.setItem(CODE_KEY, codeInput.value.trim().toUpperCase()));
customCodeInput.addEventListener('input', () => localStorage.setItem(CUSTOM_CODE_KEY, customCodeInput.value.trim().toUpperCase()));

function showError(msg) {
  errEl.textContent = msg || '';
}

function go(code, playerId, name) {
  localStorage.setItem(NAME_KEY, name);
  localStorage.setItem(CODE_KEY, code);
  saveSession({ code, playerId, name });
  location.href = `/room.html?code=${encodeURIComponent(code)}`;
}

$('create').addEventListener('click', async () => {
  showError('');
  const name = nameInput.value.trim();
  if (!name) return showError('請先輸入暱稱');
  const code = customCodeInput.value.trim().toUpperCase();
  const res = await emit('createRoom', { name, code: code || undefined });
  if (res.error) return showError(res.error);
  go(res.code, res.playerId, name);
});

$('join').addEventListener('click', async () => {
  showError('');
  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();
  if (!name) return showError('請先輸入暱稱');
  if (!code) return showError('請輸入房號');
  const res = await emit('joinRoom', { code, name });
  if (res.error) return showError(res.error);
  go(res.code, res.playerId, name);
});

// Enter 快捷
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') codeInput.focus(); });

// ---- 現有房間列表 ----
const MODE_NAMES = { roll: '純搖骰', liarsDice: '吹牛骰', poker: '話胚', redBlack: '紅黑單雙', mixed: '混合模式' };

function renderRoomList(rooms) {
  if (!rooms || rooms.length === 0) {
    roomListEl.innerHTML = '<p class="muted room-list-empty">目前沒有房間</p>';
    return;
  }
  roomListEl.innerHTML = rooms.map((r) => {
    const mode = r.modeId ? (MODE_NAMES[r.modeId] || r.modeId) : '';
    const statusLabel = r.status === 'playing' ? '遊戲中' : '等待中';
    const statusClass = r.status === 'playing' ? 'playing' : 'lobby';
    const total = r.playerCount + r.spectatorCount;
    return `<div class="room-list-item" data-code="${r.code}">
      <span class="room-item-code">${r.code}</span>
      <div class="room-item-info">
        <div class="room-item-host">${r.hostName} 的房間</div>
        <div class="room-item-meta">
          <span>👤 ${total} 人</span>${mode ? `<span>${mode}</span>` : ''}
        </div>
      </div>
      <span class="room-item-status ${statusClass}">${statusLabel}</span>
    </div>`;
  }).join('');

  roomListEl.querySelectorAll('.room-list-item').forEach((el) => {
    el.addEventListener('click', () => {
      const code = el.dataset.code;
      codeInput.value = code;
      localStorage.setItem(CODE_KEY, code);
      const name = nameInput.value.trim();
      if (!name) { showError('請先輸入暱稱'); nameInput.focus(); return; }
      $('join').click();
    });
  });
}

emit('listRooms').then((res) => renderRoomList(res.rooms));
socket.on('roomListUpdate', (rooms) => renderRoomList(rooms));

// 顯示版本號(git commit 短碼),方便辨認線上部署版本
fetch('/version')
  .then((r) => r.json())
  .then(({ commit }) => { const el = $('version'); if (el) el.textContent = `版本 ${commit}`; })
  .catch(() => {});
