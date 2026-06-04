// Socket.IO client 封裝 — 自動重連 + Promise 化的 emit
/* global io */
export const socket = io({ reconnection: true });

// emit 並等待伺服器 callback,回傳 Promise
export function emit(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => resolve(res || {}));
  });
}

// localStorage 暫存身份(供重連/換頁使用)
const KEY = 'dice.session';
export function saveSession(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}
export function clearSession() {
  localStorage.removeItem(KEY);
}
