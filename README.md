# BodyRef 實尺人台

輸入身高、體重、三圍和各部位量測，即時生成依真實尺寸換算的 3D 人台。

這個專案有兩個目的：

1. **讓數據有實體**：大部分 3D 軟體的體型調整用的是抽象滑桿（「胸部 +20%」），不是公分。這裡在模型上量到的每一圈，都等於你輸入的數值。
2. **讓描述可以對齊**：「160 公分、50 公斤、C 罩杯」到底長什麼樣子？與其各自想像，不如直接生成一個人台，截圖或分享代碼給對方看。適合當作 AI 產圖、角色設計、服裝打版時的體型參照。

## 功能

- **填你知道的就好**：每個數值不是「手動」（你填的），就是「建議」（依你填的數值連動推算）。建議值旁邊列出一般人的常見範圍（約 10%–90%）。例如身高 160、體重 52 時，把臀圍改成 100，大腿圍的建議值會跟著變粗。
- **現實檢核**：你填的每個數值，都會和「同性別、同身高、其他已填數值也相同」的人比較，列出它大概落在第幾百分位。插畫常見的誇張比例（細腰、大胸、寬臀同時出現）會一項項標出有多少見。
- **體重驗算**：模型體重是用 3D 模型的實際體積乘上人體密度（由體脂率換算）算出來的。手動填的圍度和體重對不上時會提示。
- **3D 檢視**：白模人台（無五官的蛋形頭、有手指腳趾）；以模型為中心旋轉、平移、縮放；正面／斜側／側面／背面一鍵回正；表面線條可選結構線（正中線、公主線、側縫線、橫線、頭部十字線）、網格或不畫；滑鼠移到欄位上會標出量測位置。
- **輸出**：目前視角截圖、正交三視圖（同比例尺，附量測表）、分享連結與分享代碼。

## 怎麼做到的

### 1. 數值連動（`src/core/linkage.ts`）

把全身 18 項數據（身高、體重、體脂率、10 個圍度、肩寬、4 個長度）視為一個多變量常態分佈，長度與重量取對數。你鎖定的數值當作已知條件，其餘項目取條件期望值當建議值，條件變異數換算成常見範圍；少見程度也是同一套計算。

- **連動關係**（共變異數）來自 [ANSUR II](https://www.openlab.psu.edu/ansur2/)：2012 年美國陸軍人體計測，1,986 名女性、4,082 名男性，公有領域。
- **平均值**來自 `src/core/reference.ts` 的台灣／東亞年輕成人參考體型。
- ANSUR II 沒有量的項目用模型補上：體脂率由 BMI（Deurenberg 公式）加上腰、臀、二頭肌圍的偏差估算；下胸圍由胸圍減去和體脂相關的上下胸圍差。細節寫在 `tools/prepare_stats.py`。

### 2. 人體網格（`src/body/mh/`）

人體網格與形變目標來自 [MakeHuman](https://github.com/makehumancommunity/makehuman)（CC0）。網格是一整塊封閉的身體（約 13,000 個頂點），所以關節處沒有接縫。

1. **整體體型**：依性別、胖瘦（BMI）、肌肉量（體脂率相對於 BMI）、罩杯混合 MakeHuman 的整體形變目標。這一步決定脂肪與肌肉的分佈，由 MakeHuman 的藝術家設計。
2. **精確尺寸**：用 MakeHuman 的量測形變目標（胸圍、下胸圍、腰圍、臀圍、臂圍、腿長……）微調，以高斯-牛頓法求出每個目標的權重與整體縮放，直到網格上量到的數值等於目標（誤差 0.05 cm 內）。
3. **在網格上量尺寸**（`measure.ts`）：圍度是用平面切出截面後的凸包周長，就像拉緊的皮尺；下胸圍與腰圍會跨過胸部下方。位置由關節與標記點決定，「最細處」「最粗處」在一段範圍內搜尋。
4. **人台外觀**：拿掉原本的頭，換成依頭部大小生成的蛋形頭（`egghead.ts`），脖子上段接一段平滑的延伸；手臂以骨架權重轉到指定角度。

這些都在 Web Worker 裡執行（`src/body/worker.ts`），拖動滑桿時畫面不會卡住。

## 準確度與限制

- 圍度與長度精確：測試會檢查六種體型（含誇張沙漏、偏胖、高壯男性），網格上量到的每個數值和目標相差都在 0.5 cm 內。
- 參考體型的模型體積和真實人體相差約 5% 以內。
- 建議值是「統計上的典型」，不是唯一答案；ANSUR II 是美國軍人，連動關係套用到一般人時會有偏差。
- 量測位置與量法說明寫在每個欄位下方。上臂圍量在上臂中段；腰圍是肋骨與骨盆之間最細處；肩寬是左肩點經過後頸點到右肩點（服裝量法）。

## 開發

```bash
npm install
npm run dev      # 開發伺服器
npm test         # 連動模型與網格的測試
npm run build    # 輸出到 dist/
```

需要 Node.js 20 以上。

### 重新產生資料檔

`public/body.bin`、`src/body/mh/manifest.json` 與 `src/core/statsModel.json` 都由 `tools/` 裡的腳本產生，需要 Python 3 與 numpy：

```bash
git clone --depth 1 https://github.com/makehumancommunity/makehuman /tmp/makehuman
python3 tools/prepare_body.py /tmp/makehuman/makehuman/data

# ANSUR II 的 CSV 可從 https://www.openlab.psu.edu/ansur2/ 下載
python3 tools/prepare_stats.py "ANSUR II FEMALE Public.csv" "ANSUR II MALE Public.csv"
```

## 部署

- `.github/workflows/ci.yml`：每次推送和 PR 都會跑測試與建置。
- `.github/workflows/deploy.yml`：發佈到 GitHub Pages。GitHub 免費方案只有**公開**儲存庫能用 Pages，所以目前設為只能手動執行。儲存庫改成公開（或升級方案）並在 **Settings → Pages** 把 **Source** 設為 **GitHub Actions** 後，把檔案裡的 `push` 觸發條件取消註解，推送到 `main` 時就會自動發佈。
- 想保持私人儲存庫又免費上線，可以改用 Cloudflare Pages、Netlify 或 Vercel 連結這個儲存庫：建置指令 `npm run build`，輸出資料夾 `dist`。

## 架構

```
src/
  core/                 與 3D 無關的數據層
    measurements.ts     量測項目的定義（名稱、量法、範圍），介面依這份清單產生
    reference.ts        參考體型、罩杯表、人體密度公式
    linkage.ts          數值連動：建議值、常見範圍、少見程度
    statsModel.json     由 ANSUR II 算出的共變異數（tools/prepare_stats.py 產生）
    analysis.ts         摘要數據與現實檢核
    state.ts            狀態、範例體型、瀏覽器儲存、分享代碼
  body/
    client.ts           主畫面與背景執行緒之間的橋梁
    worker.ts           背景執行緒
    mh/                 MakeHuman 網格的處理
      asset.ts          讀取資料檔、套用形變目標
      geometry.ts       切截面、凸包、體積、平滑
      measure.ts        在網格上量尺寸
      model.ts          求解形變權重、擺手臂
      egghead.ts        人台頭與脖子
      guides.ts         結構線
      engine.ts         把以上組成畫面需要的輸出
  view/                 Three.js 顯示層
  ui/                   面板、摘要、匯出與分享
tools/                  產生資料檔的腳本
```

### 常見的擴充方式

- **新增量測項目**：在 `core/measurements.ts` 加一筆定義、在 `tools/prepare_stats.py` 對應到 ANSUR II 的欄位、在 `body/mh/measure.ts` 定義怎麼在網格上量、在 `body/mh/model.ts` 指定用哪個 MakeHuman 形變目標調整。
- **型態指定（胸型、臀型）**：MakeHuman 已有胸部挺度、胸距、臀部體積等形變目標，加進 `tools/prepare_body.py` 的目標清單，再在 `model.ts` 當成使用者可調的參數即可。
- **姿勢**：MakeHuman 的骨架與蒙皮權重（CC0）可以直接用；目前只用來轉手臂角度。

## 授權與來源

- 人體網格、形變目標、骨架權重：MakeHuman 1.x 資產，CC0 1.0。本專案只使用其資產檔，沒有使用 MakeHuman 的程式碼（AGPL）。
- 人體計測資料：ANSUR II，美國政府公有領域資料。

## 規劃中

- 第二階段：型態指定（胸型、臀型、肌肉線條）、脂肪分佈比例、常用姿勢
- 第三階段：自訂動作、貼圖與皮膚、帶空間位置的三圍圖、AI 產圖用的深度圖／法線圖／骨架圖輸出
