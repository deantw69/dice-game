# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

線上多人骰盅遊戲。後端 Node.js + Express + Socket.IO,前端純 HTML/CSS/JS。介面文字與程式註解使用**繁體中文**。

## Commands

```bash
npm install
npm start          # node server/index.js,服務 http://localhost:3000(讀 PORT 環境變數)
npm run dev        # node --watch,存檔自動重啟
```

- 需要 Node 18+(`package.json` 的 `engines`)。`type: module`,全程 ESM `import`。
- 骰子動畫比較頁:`http://localhost:3000/demo.html`。

### 測試方式
專案**沒有測試框架**。驗證採用臨時的 Node 腳本搭 `socket.io-client` 連到本機伺服器跑情境(多個 forceNew socket 模擬多位玩家),跑完即刪。例:

```bash
npm install --no-save socket.io-client    # 僅測試用,不寫進 package.json
node some_test.mjs                          # 連 http://localhost:3000,用 emit+ack 斷言
```

純前端(`public/`)改動是靜態檔,伺服器免重啟;改 `server/` 的程式需重啟。改完常用 `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` 確認服務存活。

## Architecture

**伺服器權威(server-authoritative)**:所有骰子點數、回合狀態都在伺服器產生與保管;前端只負責呈現與送出動作。狀態**全存記憶體**(`roomManager.js` 的 `rooms` Map)——伺服器重啟/部署/休眠都會清空所有房間,符合設計。

### 後端三層
- `server/index.js` — Socket.IO 事件接線層。每個 client→server 事件做基本驗證後委派給 `gameController`/`roomManager`,再呼叫 `broadcastRoom()`。所有事件都用 ack callback 回 `{ ok }` 或 `{ error }`。另提供 `GET /version` 回傳部署的 git commit 短碼(首頁顯示;本機為 `dev`)。
- `server/gameController.js` — **模式無關**的回合/整場生命週期:`setMode` / `startRound` / `handleAction` / `forceReset` / `onPlayerLeft`,以及「由輸家決定玩法」的順位計算(`computeDecider`)與輸家累計(`recordLosses`)。
- `server/games/*.js` — 各遊戲模式,實作共同介面;在 `games/index.js` 的 `MODES` + `MODE_LIST` 註冊(`MODE_LIST` 的 `available:false` 會在 UI 隱藏並由 `setMode` 拒絕)。
- `server/roomManager.js` — 房間/玩家成員、4 碼房號(可自訂)、重連、`viewFor()`(見下)。成員分**三區**:`players`(正式參與)、`spectators`(下一局加入)、`away`(暫離區);房間在三區皆空時才刪除。`createRoom` 可帶 `customCode`(4 碼英數,未被占用就用,否則回錯)。

### 遊戲模式介面(新增模式照這個寫)
有兩種:
- **簡單模式**(如 `rollMode`):`startRound(players, opts)`、`handleAction(game, player, action)`、`isRoundOver`/`finishRound`、`publicView(game, players)`、`privateView()`。
- **整場模式 / match mode**(如 `liarsDice`、`mixedMode`):多了 `initMatch(players, startDice)`,函式簽名帶 `match`:`startRound(match, players)`、`handleAction(round, match, player, action, players)`、`isMatchOver`/`winner`、`publicView(round, match, players)`、`privateView(round, player)`。

`gameController` 與 `viewFor` 都用 **`typeof mode.initMatch === 'function'`** 區分這兩類。回合流程由 `round.phase` 字串驅動(各模式自定,如 `rolling`/`choosing`/`condition`/`bluffReady`/`pokerCompare`/`reveal`/`roundEnd`);`gameController` 在 `phase === 'roundEnd'` 時判定整場結束並回大廳。

### 防作弊:per-player view(關鍵)
`viewFor(room, viewerId)` 為**每位玩家**各自產生畫面資料,推給該玩家。`publicView` 是大家都看得到的資訊;**祕密資訊(他人未開的暗骰)絕對不能放進 `publicView`**,只能透過 `privateView(round, viewer)` 給「該名玩家自己」(例如 `myDice`)。新增模式時務必遵守,否則對手能從瀏覽器看到底牌。

### 重連與離開
- Client 在 `localStorage`(`dice.session`)存 `{ code, playerId }`;進房頁先 `emit('rejoin')` 用 `playerId` 接回原座位(換 socket/重新整理皆可)。
- 斷線後保留座位 30 秒(`DISCONNECT_GRACE_MS`)再移除。
- **暫離**:玩家按「我要暫離」(`benchSelf`)移入 `away`、不參與下一局;按「我回來了」(`imBack`)回到 `spectators`。`viewFor` 也會推給 away 成員(`you.isAway`)。
- 任何成員變動(leave / kick / 暫離 / 斷線逾時)都會呼叫 `gameController.onPlayerLeft()` 重新判定當前回合是否該結束,避免卡在等待已離開的玩家。

### 前端(`public/`)
- `room.js` 是大宗:訂閱 `roomState`,每次收到就整頁 `render()`(roster / banner / board / controls 等)。狀態完全來自伺服器,前端不保留遊戲狀態。
- `net.js`:Socket.IO 封裝(`emit` 回 Promise)+ session 存取。`app.js`:首頁取暱稱、建房/加房。
- 骰子渲染器在 `public/js/dice/`,共同介面 `{ setCount, rollTo, setStatic }`(`diceCss3d` 為遊戲實際使用;`diceCup`/`diceThree` 主要用於 `demo.html` 比較)。音效在 `cupSound.js`,全部受 `window.__cupMuted` 控制(遊戲內 🔊 鈕切換)。
- UI 慣例:玩家名稱高亮用 `.hl` class;手機在 `@media (max-width: 600px)` 精簡 header;上半部 `.room-sticky` 釘頂;玩家列表是右下角懸浮面板。

## 部署
`render.yaml`(Render Blueprint,`autoDeploy: true`):push 到 `main` 即自動部署。Build `npm install`、Start `npm start`。免費方案閒置會休眠且重啟清空記憶體狀態。

## OpenSpec
本專案已導入 OpenSpec(`openspec/` 目錄、`.claude/commands/opsx/`、`/opsx:*` 指令)做 spec-driven 開發。`.claude/settings.local.json` 為個人本機設定(已 gitignore)。
