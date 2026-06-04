# 🎲 骰盅遊戲(線上多人)

網頁版多人搖骰遊戲。玩家連線後取暱稱、用 4 碼房號加入同一房間一起玩。

## 遊戲模式
- **純搖骰**:每人各搖 N 顆,點數公開、顯示總和排行。
- **混合模式**:從 5 顆暗骰開始,任何人先按決定子玩法。
  - **紅黑單雙**:選紅/黑/單/雙/大/小,符合條件的骰子被拿掉,直到有人歸零淘汰。
- (吹牛骰開發完成但暫時隱藏)

## 技術
- 後端:Node.js + Express + Socket.IO(即時連線,房間/遊戲狀態存記憶體)
- 前端:純 HTML / CSS / JS,CSS 3D 骰子動畫

## 本地執行
```bash
npm install
npm start
# 開啟 http://localhost:3000
```
伺服器會讀取環境變數 `PORT`(部署平台會自動帶入),預設 3000。

## 部署
任何支援長連線(WebSocket)的 Node 平台皆可(Render / Railway / Fly.io 等)。
- Build:`npm install`
- Start:`npm start`
- 需要 Node 18+。
