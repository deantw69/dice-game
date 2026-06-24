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
- `server/roomManager.js` — 房間/玩家成員、4 碼房號(可自訂)、重連、`viewFor()`(見下)。成員分**三區**:`players`(正式參與)、`spectators`(下一局加入)、`away`(暫離區);房間在三區皆空時才刪除。`createRoom` 可帶 `customCode`(4 碼英數,未被占用就用,否則回錯)。`joinRoom` 暱稱在房內三區重複時不報錯,改用 `uniqueNameInRoom()` 自動加序號(`王`→`王2`→`王3`)。`getRoomList()` 回傳所有房間的公開摘要(房號、房主、人數、狀態、模式),供首頁房間列表使用。

### 遊戲模式介面(新增模式照這個寫)
有兩種:
- **簡單模式**(如 `rollMode`):`startRound(players, opts)`、`handleAction(game, player, action)`、`isRoundOver`/`finishRound`、`publicView(game, players)`、`privateView()`。
- **整場模式 / match mode**(如 `liarsDice`、`mixedMode`、`russianRoulette`、`blackjack21`):多了 `initMatch(players, startDice)`,函式簽名帶 `match`:`startRound(match, players)`、`handleAction(round, match, player, action, players)`、`isMatchOver`/`winner`、`publicView(round, match, players)`、`privateView(round, player)`。`russianRoulette` 是第一個**回合制**模式(輪流行動,非同時),在 `handleAction` 內以 `round.turnIndex` 驗證輪到的玩家;爆掉門檻每回合隨機產生且隱藏(範圍依存活人數:min=人數×5, max=人數×10),玩家只看到可能範圍,爆掉後才揭曉實際門檻;生命數可由房主設定(`room.rouletteLives`,預設 3,0 為單局模式不淘汰,與 `blackjack21` 相同邏輯);爆掉決出本局輸家時,前端額外播炸彈爆炸動圖特效(`room.js` 的 `playBombFx()`:滿版閃光 + 衝擊環 + 💥 + 四散碎片)+ 爆炸音效(`cupSound.js` 的 `playExplosion()`),取代其他模式的嘲諷小號。`blackjack21`(21 點骰)同為回合制:開局每人自動骰 3 顆起手,再輪流要牌(`hit`/`roll`)或停牌(`stand`),骰子加總接近 21 不爆;**暗骰**——他人只看到骰數不看點數,爆掉外觀與停牌相同(bluff 要素);全員結束後開牌,爆掉者輸、全沒爆最低分輸(同分時骰子數多者贏)、全爆超最多者輸;淘汰制,生命數可由房主設定(`room.blackjackLives`,預設 3,0 為單局模式不淘汰);整場結束時彈出金色「最終勝利者」popup。前端用 `actionSeq` 偵測搖骰結果已回(解決 turn 繞回自己時骰子不停的問題)。`speedMode`(手速骰)是第一個**即時同步競速**模式,也是**唯一用伺服器計時器**的模式:每人 5 顆骰,倒數 3 秒(`countdown`)後揭題(`racing`)——隨機指定一個撲克牌型(`server/util/pokerHand.js` 的 `evalHand(hand).arr[0] === targetRank` 判定——須**剛好**該牌型,非「以上」;題池排除散牌與豹子,可微調),揭題後**不自動發骰**(`reveal` 只切 phase),每人各自按「搖骰」開始、無限重骰、各自獨立鎖骰(`setLock`/`reroll`,非話胚那種僅最小者一人;首次 `reroll` 即首擲;連續擲骰有 `ROLL_COOLDOWN_MS`=1 秒冷卻——伺服器以 `round.lastRollAt[id]` 權威擋下快速連按,未滿即回 `{ ok:true, cooldown:true, retryMs }` 不擲骰,前端 `speedRollReadyAt` 樂觀冷卻並以伺服器 `retryMs` 校正、disable 鈕顯示剩餘秒數),搶先湊到剛好指定牌型即「安全」;**達標判定延遲**(`ACHIEVE_DELAY_MS`=1.5 秒)——`handleAction` 偵測達標時不立刻 `markDone`,回傳 `pendingAchieve`,`index.js` 排 1.5 秒 `setTimeout` 後呼叫 `gameController.speedConfirmAchieve()` 再 `broadcastRoom`,所有玩家同步在骰子動畫跑完後才看到達標結果;延遲期間若又重骰(rollSeq 不符)則達標作廢;若 timeout 先觸發(phase 已非 racing)也不補達標、直接判輸。只剩 1 人未達標(N-1 達標)就立刻結束、該人輸,時間到仍有 ≥2 人未達標則未達標者全輸。racing 階段**所有玩家(含他人)的骰子即時顯示**(`publicView` 的 `dice` 在 racing 就送出);前端以後端 per-player `round.rolls[id]`(搖骰次數)偵測「(自己或他人)剛搖完」來播未鎖定骰子的滾動動畫(`showDice` 的 `rollIdx` 路徑,他人鎖定索引取自公開的 `round.locked[id]`)。**單局制**(`isMatchOver` 回 `false`、`winner` 回 `null`,類比吹牛骰每局回大廳、無最終勝利者)。秒數由房主設定(`room.speedSeconds`,預設 30,範圍 10~60)。**伺服器計時器在 `index.js`**(唯一握有 `broadcastRoom()` 的接線層):`armSpeedTimers(room)` 在開局後排 T1 揭題(`targetAt`)、T2 截止(`deadlineAt`)兩個 `setTimeout`,用 `round.speedId` nonce + phase/status 驗證讓過期 timer 自我失效(不必在每條離開/重來路徑手動清除),回呼委派給 `gameController` 的 `speedReveal()`/`speedTimeout()`。`publicView` 帶 `targetAt`/`deadlineAt`/`serverNow`,前端 `room.js` 用 `serverNow` 算時鐘偏移後以輕量 `setInterval`(`setupSpeedClock`)本地更新倒數/計時文字,不整頁 render。`pokerHand.js`(`FS`/`evalHand`/`cmpHand`)由 `mixedMode` 與 `speedMode` 共用。

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
- `net.js`:Socket.IO 封裝(`emit` 回 Promise)+ session 存取。`app.js`:首頁取暱稱(空白時 `ensureName()` 隨機產生「形容詞+動物+數字」並回填)、建房/加房,以及「現有房間」列表(透過 `listRooms` 事件首次查詢 + `roomListUpdate` 即時更新;點擊房間項目直接加入)。首頁也會讀網址 `?code=XXXX` 自動填好房號並聚焦暱稱欄(供掃 QR 進來者直接輸入名稱加入)。
- **分享房間 QR**:房間頁選單「📷 分享」鈕把 `${origin}/?code=房號` 畫成 QR overlay 供他人手機掃描。QR 產生器在 `public/js/vendor/qrcode.js`(自製、byte 模式、自動選版本/錯誤更正等級,純前端無外部依賴/不打 API),`room.js` 的 `drawQr()` 把布林矩陣畫到 canvas。
- 骰子渲染器在 `public/js/dice/`,共同介面 `{ setCount, rollTo, setStatic }`(`diceCss3d` 為遊戲主要使用)。`diceCup`(骰盅:蓋住搖→掀蓋)除 `demo.html` 比較外,**吹牛骰「抓」之前的自己骰子視圖**也用它(`room.js` 的 `getCup`),額外提供分段控制 `{ cover, shake, reveal }`:蓋著待命 / 按住搖骰抖動 / 放開拿到 `myDice` 掀蓋亮點(開盅後再點骰子區可反覆蓋回/打開);盅內骰子尺寸由 `--ds` 依數量自動縮放(CSS 規則用 `.cup-scene .cup-tray` 前綴提高特異度,蓋過 `.dice-stage` 的固定尺寸),確保不超出盅。另有 `scatter` 選項(`getCup` 已啟用):盅內骰子改絕對定位、位置/角度/間距隨機,以 SAT(分離軸定理)碰撞檢測保證彼此不重疊(放不下就自動縮小重排);掀蓋時播「撞來撞去」動畫——隨機初速+自轉,撞牆/互撞(每幀用 MTV 把穿插的方塊推開)、阻尼減速,自然停下即為不重疊散落樣貌直接定格;同一手沿用同組位置,僅換新一手或數量變動才重抽,rAF 被分頁節流時以計時器保底定格。`diceThree` 仍僅用於 `demo.html`。`diceD20`(20 面骰 / d20)是真正的 CSS 3D 二十面體:依黃金比例算出 12 頂點 → 20 個三角面各帶數字 1~20,翻滾後把對應點數的面法線轉向鏡頭(`landingR`);**以 `requestAnimationFrame` 驅動剛體翻滾**(每次擲骰隨機抽一條翻滾軸 `tumbleAxis` + 隨機正反方向,繞它整數圈翻滾——整圈歸零不影響落點,故方向每次都不同卻仍精準落在結果面,再疊上「起點→落點」的測地線對齊旋轉),每幀依「世界空間」法線重新 `shade()`——光源固定在螢幕、不隨骰子轉,呈現立體明暗;6 與 9 加底線(`.d20-num.ul`)區分。另支援 `scatter` 選項(demo 已啟用):在容器內建相對定位 tray,骰子改絕對定位隨機不重疊散落(放不下自動縮小),`rollTo` 時 3D 翻滾的**同時**跑 2D 散落物理——隨機初速、撞牆反彈、彼此碰撞(軸對齊方框,沿穿透較淺軸分離並交換法線速度),依時間阻尼後自然停下定格;碰撞引擎概念同 `diceCup` 的 `animateScatter`(d20 自帶 3D 翻滾,故碰撞用 AABB 而非旋轉方塊 + SAT/MTV)。目前僅在 `demo.html` 展示(violet/emerald/crimson 三色),尚未接入遊戲模式。音效在 `cupSound.js`,全部受 `window.__cupMuted` 控制(遊戲內 🔊 鈕切換)。
- UI 慣例:玩家名稱高亮用 `.hl` class;手機在 `@media (max-width: 600px)` 精簡 header;上半部 `.room-sticky` 釘頂;玩家列表是右下角懸浮面板。
- 搖骰輸入有三種,皆映射到 `pressRoll/releaseRoll`(按住→放開):滑鼠/觸控按住 `#roll`/`#reroll`、空白鍵、以及手機「📱 搖手機擲骰」開關(`#shakeRoll`)。搖手機用 `devicemotion` 偵測加速度變化量,搖晃即 `pressRoll`、停手 `SHAKE_STOP_MS` 後 `releaseRoll`;iOS 13+ 需在勾選的使用者手勢中呼叫 `DeviceMotionEvent.requestPermission()`,且**僅在 HTTPS(安全環境)下才會授權**(本機 http 連線會被拒)。

## 部署
`render.yaml`(Render Blueprint,`autoDeploy: true`):push 到 `main` 即自動部署。Build `npm install`、Start `npm start`。免費方案閒置會休眠且重啟清空記憶體狀態。

## OpenSpec
本專案已導入 OpenSpec(`openspec/` 目錄、`.claude/commands/opsx/`、`/opsx:*` 指令)做 spec-driven 開發。`.claude/settings.local.json` 為個人本機設定(已 gitignore)。
