# BodyRef 實尺人台

**[直接開啟 BodyRef（GitHub Pages）](https://asasasdad0329.github.io/bodyref/)**

輸入身高、體重、三圍和各部位量測，即時生成依真實尺寸換算的 3D 人台。以 AI 生圖與角色設計的體型參照為主，允許美型、誇張比例與後續修型；尺寸精確和曲線、部位連接的品質都要顧到。

這個專案有兩個目的：

1. **讓數據有實體**：大部分 3D 軟體的體型調整用的是抽象滑桿（「胸部 +20%」），不是公分。以實際模型皮尺對準指定尺寸，並明示無法達成的差距。
2. **讓描述可以對齊**：「160 公分、50 公斤、C 罩杯」到底長什麼樣子？與其各自想像，不如直接生成一個人台，截圖或分享代碼給對方看。適合當作 AI 產圖、角色設計、服裝打版時的體型參照。

## 功能

- 以公分、公斤與體脂率控制身體；手動值保持原目標，推算值與實際模型結果分開標示。無法同時滿足條件時顯示差距。
- 女性胸型提供水滴、長水滴／木瓜、圓潤；男女各有均衡／後翹臀型、柔和下腹／平順腹型。代表型與圍度共同求解，不是固定模型。
- 骨骼肌估計量可獨立輸入 kg；總帳區分脂肪、骨骼肌、其餘去脂，不把全部去脂量當成肌肉。固定圈仍參與形態與組成更新。
- 罩杯使用既有上下胸圍差，範圍 A–S。體重未鎖定時，新增胸部體積反映在輸出重量，不反向啟動全身增肌。
- 比例顯示為 `1 : r`，包括身高：股下、身高：手臂長、大腿：小腿、上臂：前臂。手臂長仍是肩點到手腕；分段比值正確換算，舊分享碼的內部意義不變。
- 預設中性灰霧面，正面、前斜、側面、後斜、背面可切換；量測線、結構線、輪廓各自開關。
- 提供乾淨的目前視角圖片、同尺度正交三視圖，可另選附量測資訊。型態、肌肉、尺寸與比例可儲存和分享。

## 控制、量測與資料

人體網格與形變材料使用 MakeHuman CC0 資產，約 13,000 個頂點。骨性框架先提供局部座標，再由區域控制與共享交界共同生成曲面；最後中性平滑、接觸限制、皮尺、體積與組成都使用同一結果。姿勢只轉動完成的中性曲面，不另修輪廓。

- `localControls.ts`／`controls.ts`：實際父參照變換、獨立胸／背／臀肌、臀上／後／下／側與腿根、腹前／下腹／腰側／後腰。肌肉材料保留增減的有號位移；肌脂聯合材料處理單獨相加時的交界差異。
- `breast.ts`：共用根部、寬高深、上下極、胸距與朝向控制。自由乳房由根部籠承接，附著帶隨實際胸壁變換；不以單一乳頭圓頂補胸圍。
- `rings.ts`／`distribution.ts`：保留有效的方向性截面曲線，手動尺寸與組成作硬條件，未填圍度作軟偏好；小型共同校正限制控制範圍、組織非負與幾何有效性。每次從確定的初值求解，快取不改變結果。
- `measure.ts`：最細腰、服裝肩寬與放鬆上臂為使用者量法。肚臍腰、骨點肩寬等來源量法另記，不以固定公分換算混用。放鬆上臂在肩峰到尺骨鷹嘴中點、垂直上臂軸的截面量測。

女性站姿上胸在乳房區間搜尋相對同高胸壁最飽滿的完整皮尺；回報實際路徑周長，不直接回傳輸入，也沒有未驗證的前傾換算。下胸使用同一形變與平滑下的胸壁參照，避免自由乳房穿過皮尺。量法版本為 3；舊分享碼保持公分與罩杯意義，但改良後曲面可能與舊版不同。

ANSUR II 提供尺寸關係與參考分布。其人工推估的體脂、下胸仍是模型假設，沒有改稱實測。NHANES 2017–2018 的 DEMO、BMX、DXA 依 SEQN 合併，以有效成人樣本、品質旗標與 MEC 權重擬合放鬆上臂及粗分區先驗，另作留出驗證；兩份資料沒有拼成虛構的跨資料集受試者。重現方法與誤差見 [重建紀錄](docs/SHAPE_CONTROL_REBUILD.md)。

所有求解在 Web Worker 執行。來源量法、分配偏好與實際模型輸出分開；模型不能由圍度唯一推定真人體脂或骨骼肌。

## 準確度與限制

本輪交付規格是 [SHAPE_CONTROL_PLAN](docs/SHAPE_CONTROL_PLAN.md)，目前驗證狀態見 [HANDOFF](docs/HANDOFF.md)，不是以功能存在宣稱全輪已驗收。GitHub Pages 是已部署版本，分支修改不會自動上線。

手動尺寸的工程容許誤差為 0.5 cm，體重 0.5 kg，指定體脂 1 個百分點，骨骼肌組成帳 0.5 kg。這些是模型求解門檻，不是真人測量或醫療精度。極端固定胸腰臀再增重時，控制容量可能不足；系統保留目標與實際差距，區分組成輸入互斥、未收斂及無效曲面，不能據此稱某種體型生理上不可能。

統計偏好可讓步，允許美術比例；未填尺寸不保證落在資料平均附近。NHANES 的 DXA 去脂軟組織不等於直接測得骨骼肌，局部肌肉係數與分區細分仍是工程先驗。ANSUR II 的軍人樣本也不代表所有族群。

本工具使用既有網格解析度，極端放大時可見多邊形輪廓。幾何護欄檢查非有限座標、面塌縮、折返及新增非相鄰三角面穿插，尚不涵蓋所有共平面接觸；無幾何錯誤也不等於自然外觀已合格。外觀另以多視角、局部放大、截面及不同光向檢查。

## 開發

```bash
npm ci
npm run dev      # 開發伺服器
npm test         # 連動模型與網格的測試
npm run test:body-report -- /absolute/output/body-report.json  # 產物必須在倉庫外
npm run test:shape-report -- /absolute/output/views  # 同快照數值與九視角證據
node tools/ui-regression.mjs /absolute/output/ui     # 真正網頁操作
node tools/performance-regression.mjs /absolute/baseline /absolute/output/performance
npm run build    # 輸出到 dist/
npm run build:single   # 另外打包成單一 HTML（dist/bodyref-single.html），不需要伺服器就能打開
```

協作規則（含 AI 編碼代理）寫在 `AGENTS.md`；目前狀態、已知問題與還沒做的規劃在 `docs/HANDOFF.md`，開發過程與每次轉向的理由在 `docs/HISTORY.md`。

開發與 CI 使用 Node.js 22（22.12 以上）。

### 重新產生資料檔

`public/body.bin`、`src/body/mh/manifest.json` 與 `src/core/statsModel.json` 都由 `tools/` 裡的腳本產生，需要 Python 3 與 numpy：

```bash
git clone --depth 1 https://github.com/makehumancommunity/makehuman /tmp/makehuman
python3 tools/prepare_body.py /tmp/makehuman/makehuman/data

# ANSUR II 的 CSV 可從 https://www.openlab.psu.edu/ansur2/ 下載
python3 tools/prepare_stats.py "ANSUR II FEMALE Public.csv" "ANSUR II MALE Public.csv"
```

## 部署

- 倉庫與 [GitHub Pages 網站](https://asasasdad0329.github.io/bodyref/)已公開，Pages 的來源為 **GitHub Actions**。
- [CI](.github/workflows/ci.yml)：推送到 `main` 或建立、更新 PR 時，執行測試與建置。合併 `main` 後仍需部署，網站才會更新。
- [部署流程](.github/workflows/deploy.yml)：推送 `stable-*` 標籤、發布對應 Release，或手動執行時，重新測試、建置並發佈到 Pages。
- **線上驗收最新版**：到 [Actions → Deploy to GitHub Pages](https://github.com/asasasdad0329/bodyref/actions/workflows/deploy.yml)，按 **Run workflow**、選 `main`；等部署成功後開啟網站。
- **穩定版發佈**：由作者在 [Releases](https://github.com/asasasdad0329/bodyref/releases) 建立以 `main` 為目標的 `stable-YYYY-MM-DD` 標籤並發布 Release；細節見 `AGENTS.md`。

## 架構

```
src/
  core/                 與 3D 無關的數據層
    measurements.ts     量測項目的定義（名稱、量法、範圍），介面依這份清單產生
    reference.ts        參考體型、罩杯表、人體密度公式
    linkage.ts          數值連動：建議值、常見範圍、少見程度
    proportions.ts      身體比例與四肢長度的換算
    statsModel.json     由 ANSUR II 算出的共變異數（tools/prepare_stats.py 產生）
    analysis.ts         摘要數據與現實檢核
    state.ts            狀態、範例體型、瀏覽器儲存、分享代碼
  body/
    client.ts           主畫面與背景執行緒之間的橋梁
    goals.ts            把面板狀態換成網格求解的硬條件與未填圍度的軟偏好
    worker.ts           背景執行緒
    mh/                 MakeHuman 網格的處理
      asset.ts          讀取資料檔、套用形變目標
      geometry.ts       切截面、凸包、體積、平滑
      measure.ts        在網格上量尺寸
      rings.ts          骨架與截面圈、脂肪與肌肉的部位、總量分配與求解
      distribution.ts   自由組織的受限公斤轉移與軟偏好評分
      controls.ts       區域、交界、肌脂材料與男女代表型
      localControls.ts  局部父參照中的共同變換
      breast.ts         女性三胸型共用的控制與附著
      quality.ts        曲面折返、塌縮與穿插檢查
      model.ts          納入量測的中性整理與姿勢
      egghead.ts        人台頭與脖子
      guides.ts         結構線
      engine.ts         把以上組成畫面需要的輸出
  view/                 Three.js 顯示層
  ui/                   面板、摘要、匯出與分享
tools/                  資料準備、數值回歸與單檔打包腳本
```

### 擴充方式

新增量測時同時定義來源語意、網格路徑、責任控制與 `goals.ts` 的硬條件。新增代表型時，在既有局部控制建立規則組合，維持共同數值引擎；加入尺寸、肌脂、鎖定配對與多視角驗收。新增分段組成輸入需保留脂肪、骨骼肌、其他去脂的獨立總帳。

## 這個專案怎麼做出來的

構想、需求、體型與比例的判斷、每一版的驗收由作者負責；程式碼與文件由 AI 編碼代理（Claude Code 等）依討論結果撰寫。開發過程中幾次推翻重來的理由記錄在 `docs/HISTORY.md`。

## 授權與來源

本專案以 [GNU Affero General Public License v3.0 或更新版本](LICENSE)（AGPL-3.0-or-later）釋出：可以自由使用、修改、散布，但散布修改版或拿修改版架設網路服務時，必須以同樣的授權公開完整原始碼，並保留原作者的著作權聲明。

Copyright (C) 2026 asasasdad0329

- 人體網格、形變目標、骨架權重：MakeHuman 1.x 資產，CC0 1.0。本專案只使用其資產檔，沒有使用 MakeHuman 的程式碼。
- 人體計測資料：ANSUR II、NHANES，美國政府公開資料；來源與使用界線見第三方聲明。
- 其他第三方程式庫與字型的授權見 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 規劃中

- 後續：更多代表型、局部自由控制、精細肌肉刻線、InBody 分段數據、服裝支撐、常用姿勢
- 第三階段：自訂動作、貼圖與皮膚、帶空間位置的三圍圖、AI 產圖用的深度圖／法線圖／骨架圖輸出
