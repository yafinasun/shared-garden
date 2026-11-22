# 設計文件：共享花園冒險版（基準）

## 概觀

冒險版是純前端的瀏覽器遊戲，不需建置。規則引擎和介面分開：規則引擎是純函式、狀態可 JSON 序列化，介面每次狀態變動就重新產生畫面。這個切法是為了之後能把規則引擎原封不動搬到伺服器，做伺服器權威的多人連線。

遊戲內容與數值見 `shared-garden/規格書.md`；本文件說明程式怎麼組織。

## 架構

```
index.html
 ├─ style.css、adventure.css        樣式
 ├─ adventure-rules.js             規則引擎 → window.GardenAdventure
 └─ adventure-app.js               介面     → window.GardenUI
       │  使用者操作（data-act）
       ▼
   applyAction(state, action) ──► { ok, state, error }
       │  ok：換成新 state
       ▼
   render()：依 ui 狀態與 state 產生 HTML（innerHTML）
```

- **單向資料流**：介面不直接改 state，所有遊戲變動都經過 `applyAction`。
- **介面狀態**（`GardenUI.ui`）只放和畫面有關、不影響規則的東西，例如目前畫面、選中的牌、拖曳中的牌、是否開著牌卡庫、錯誤訊息、檢視中的玩家。
- **素材路徑**：`window.GARDEN_ASSETS`（預設 `assets/`）、`window.GARDEN_MUSIC`（預設 `music/`）。`dev/` 底下的測試頁設成 `../assets/`、`../music/`。

## 元件與介面

### 規則引擎 `adventure-rules.js`

對外匯出 `window.GardenAdventure`：

| 名稱 | 類型 | 說明 |
|---|---|---|
| `CONFIG` | 物件 | 所有可調數值 |
| `SPECIES`、`POT_SPECIES`、`CHARACTERS` | 物件 | 專屬植物、盆栽植物、角色 |
| `CARDS`、`UPGRADES`、`GROWTH_CARDS`、`EARTH_POOL` | 物件／陣列 | 卡牌（含自動產生的「＋」版）、升級差異、各植物的專屬牌、戰後牌池 |
| `VIRUSES`、`REWARDS`、`EVENTS`、`NODE_TYPES` | 物件 | 病毒、寶箱收穫、事件、地點類型 |
| `STAGE_NAMES`、`MAX_STAGE` | 常數 | 階段名稱、最高階段（2） |
| `createGame(players, { seed })` | 函式 | 建立新局；players 為 `[{ name, charId }]` |
| `applyAction(state, action)` | 函式 | 唯一的狀態變更入口，不修改輸入 |
| `intentOf(state)` | 函式 | 病毒本回合意圖 |
| `reachable(state)`、`currentNode(state)` | 函式 | 地圖可前往的地點、目前地點 |
| `canTrade(state)`、`enhanceable(player)` | 函式 | 是否可交易、成熟時可強化的牌 |
| `ownedCounts`、`deckCounts`、`playerCards` | 函式 | 牌卡庫與牌組統計 |

#### 動作（action）

| type | 參數 | 場景 |
|---|---|---|
| `pick` | `choice`：卡牌 id、`enhance:<id>`、`skip` | 有待選升階時（優先於其他動作） |
| `play` | `cardIndex`、`target?`、`playerId?` | 戰鬥或花園 |
| `sow` | `pot` | 花園 |
| `endTurn` | `playerId?` | 戰鬥 |
| `purify` | — | 戰鬥 |
| `advance` | — | 花園 → 地圖 |
| `move` | `node` | 地圖 |
| `reward` | 戰後：`playerId`、`choice`；寶箱：`choice`、`target?` | 收穫 |
| `event` | `choice`（0 或 1） | 事件 |
| `upgrade` | `card`、`playerId?` | 休息點花園或交易 |
| `leaveShop` | — | 交易 |

#### 主要內部函式

| 函式 | 說明 |
|---|---|
| `buildMap` | 依 `mapLayout`、`lanePlans` 產生地圖，分配病毒與事件 |
| `enterNode` | 依地點類型切換場景（花園、戰鬥、寶箱、事件） |
| `startBattle`、`startRound`、`endTurn`、`virusPhase` | 戰鬥流程 |
| `playBattleCard`、`playGardenCard` | 依卡牌效果欄位結算 |
| `hurt`、`damageVirus` | 傷害結算（護盾、外殼、反擊） |
| `checkVictory`、`checkLose`、`finish` | 勝負判定 |
| `grow`、`addCare`、`queuePick`、`resolvePick` | 植物成長與升階選牌 |
| `claimChest`、`claimCard`、`applyEvent`、`upgradeCard` | 寶箱、戰後收穫、事件、升級 |
| `rand`、`shuffle` | mulberry32 亂數，種子存在 `state.seed` |
| `describe` | 依效果欄位產生卡牌說明 |

### 介面 `adventure-app.js`

對外匯出 `window.GardenUI = { ui, render, music }`。

| 區塊 | 函式 |
|---|---|
| 圖片 | `art(name, cls, alt)`（png）、`sceneBg(name)`（jpg）、`charArt`（加 `char-<id>` class，倒下用 `-down`）、`plantArt`、`potArt`、`virusArt`、`eventArt`、`nodeIcon`、`res`（資源圖示） |
| 畫面 | `homeView`、`setupView`、`gameView`、`hud`、`mapView`、`gardenView`、`battleView`、`pickView`、`cardRewardView`、`chestView`、`eventView`、`shopView`、`libraryView`、`endingView`、`loseArt`、`logView` |
| 卡牌 | `cardHtml`：底框 `card-frame.jpg`＋圖示＋文字 |
| 操作 | 點擊事件委派（`data-act`）、拖拉出牌（pointer 事件，合法目標加 class） |
| 音樂 | 依場景選曲；第一次互動後解鎖；開關存在 `localStorage` 的 `garden-music`；音量 0.45 |

### 樣式 `adventure.css`

依日期分段往後追加。角色比例差異用 class 處理，例如 `.cast-char.char-shiba`、`.hero-char.char-shiba`。

## 資料模型

### 遊戲狀態（state）

```js
{
  seed,                       // 亂數種子（每次使用後更新）
  scene,                      // 'garden' | 'map' | 'battle' | 'reward' | 'event' | 'shop' | 'over'
  col, lane, path: [nodeId],  // 地圖位置與走過的路
  map: [[node]],              // 每欄 1 或 3 個地點
  turnIdx,                    // 戰鬥中輪到的玩家
  result: { win, reason } | null,
  battle: {
    virus: { id, name, hp, maxHp, spore, armor },
    round, energy: {pid: n}, power: {pid: n},
    reduce, halve, guard: { playerId, reduce } | null,
    thorns: {pid: n}, chain: {pid: n}
  } | null,
  reward: { kind: 'cards', offers: {pid: [cardId]}, done: {pid: true} }
        | { kind: 'chest', left, taken: [id], options: [id] } | null,
  event: { id } | null,
  picks: [{ playerId, stage, options: [cardId], enhance }],
  purity, remains, seeds,     // 淨化因子、植物殘骸、地球種子
  pots: [{ species, stage, care } | null],
  players: [{
    id, name, charId, hp, block,
    deck: [cardId], discard: [cardId], hand: [cardId], gardenHand: [cardId],
    plant: { species, stage, care }
  }],
  gardenPile: { deck: [cardId], discard: [cardId] },
  log: [{ col, text }]        // 最多 150 筆
}
```

### 地點（node）

```js
{ id: 'col-lane', col, lane, type, name, emoji, virus?, event? }
```

### 卡牌（CARDS 的一筆）

```js
{
  id, set,           // 'basic' | 'earth' | 'garden' | 專屬植物 id
  name, kind, cost,  // kind：攻擊／防禦／Buff／特殊／照料
  // 效果欄位（有寫才生效）：dmg、sporeBonus、clearSpores、dmgPerSpore、spore、sporeClear、
  // block、blockAll、selfBlock、heal、healAll、selfHeal、draw、drawTarget、drawAll、foresight、
  // energy、power、weaken、halve、chain、guard、thorns、care、consumable
  scope,             // 'battle' | 'garden'（自動產生）
  target,            // 'player' | null（自動產生）
  desc,              // 說明（自動產生）
  upgraded?, base?   // 「＋」版才有
}
```

「＋」版的 id 是原 id 加 `+`，由 `UPGRADES` 的差異數值合成。

## 錯誤處理

- 所有不合法動作由 `applyAction` 回傳 `{ ok: false, state: 原 state, error: 中文訊息 }`，不丟例外。
- `createGame` 的參數錯誤（人數、重複角色、未知角色）會丟出例外。介面直接呼叫 `createGame`，沒有另外攔截，所以要靠角色選擇畫面避免送出不合法的組合。
- 介面把錯誤訊息放在 `ui.error`，顯示在目前畫面下方；下一個成功動作會清除。

## 測試策略

測試都在瀏覽器頁面執行，用 Edge 無頭模式跑：

| 工具 | 方式 | 檢查 |
|---|---|---|
| `dev/adv-sim.html` | 機器人依三種走法各玩 n 局 × 1–4 人；網址可覆寫數值（`n`、`hp`、`dmg`、`pd`、`th`、`gh`） | 勝率、平均戰鬥數、牌組大小、升級數 |
| `dev/adv-ui.html` | 模擬拖拉與點擊走完一局（`#style=fight`、`#style=special`） | 各畫面有出現、拖拉成功、圖片載入、曲目切換、`errors=[]` |
| `dev/shot.html` | 直接跳到指定畫面截圖（`#home`、`#map`、`#battle`、`#garden`、`#pick`、`#reward`、`#chest`、`#event-<id>`、`#library`、`#ending`、`#lose`） | 人工檢查美術 |

執行方式：

```
msedge --headless=old --disable-gpu --virtual-time-budget=60000 --dump-dom <網址>
msedge --headless=old --disable-gpu --window-size=1280,900 --screenshot=<檔案> <網址>
```

結果在 `<pre id="out">` 裡。

**難度目標**：各人數、各走法的模擬勝率約 55–80%。每次調整數值只動 3–5%，調完重跑模擬。

## 設計決定

| 決定 | 理由 | 放棄的做法 |
|---|---|---|
| 卡牌說明由效果數值產生 | 「＋」版與數值調整後說明一定正確 | 把文字畫在卡圖上 |
| 卡牌用共用底框＋圖示＋文字 | 改數值不用重畫圖 | 每張牌一張完整卡圖 |
| 番茄預知改成「抽 1，抽到 0–1 費再抽 1」 | 不需要額外的選牌介面 | 看牌庫頂 3 張選 1 |
| 植物沒有被動能力 | 避免同一次升級給兩份獎勵 | 保留植物被動 |
| 任一玩家倒下即失敗 | 全隊倒下才失敗時，多人勝率升到 80–99%，需大改難度 | 全隊倒下才失敗 |
| 寶箱「成長」50% 出現 | 立即升階太強，不該每次都有 | 每次都出現 |
| 舊版保留在 `classic.html` | 不破壞舊的試玩版本 | 刪除舊版 |
