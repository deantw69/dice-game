// 首頁邏輯:取暱稱 + 建房 / 輸入房號加入
import { emit, saveSession } from './net.js';

const $ = (id) => document.getElementById(id);
const nameInput = $('name');
const codeInput = $('code');
const customCodeInput = $('customCode');
const errEl = $('err');

// ---- 輸入記憶(localStorage) ----
const NAME_KEY = 'dice.lastName';
const CODE_KEY = 'dice.lastCode';
const CUSTOM_CODE_KEY = 'dice.lastCustomCode';

// 開頁時帶入上次輸入的暱稱 / 房號 / 自訂房號
nameInput.value = localStorage.getItem(NAME_KEY) || '';
codeInput.value = localStorage.getItem(CODE_KEY) || '';
customCodeInput.value = localStorage.getItem(CUSTOM_CODE_KEY) || '';

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
