# BodyRef 實尺人台

**[直接開啟 BodyRef（GitHub Pages）](https://asasasdad0329.github.io/bodyref/)**

輸入身高、體重、三圍和各部位量測，即時生成依真實尺寸換算的 3D 人台。以 AI 生圖與角色設計的體型參照為主，允許美型、誇張比例與後續修型；尺寸精確和曲線、部位連接的品質都要顧到。

這個專案有兩個目的：

1. **讓數據有實體**：大部分 3D 軟體的體型調整用的是抽象滑桿（「胸部 +20%」），不是公分。這裡在模型上量到的每一圈，都等於你輸入的數值。
2. **讓描述可以對齊**：「160 公分、50 公斤、C 罩杯」到底長什麼樣子？與其各自想像，不如直接生成一個人台，截圖或分享代碼給對方看。適合當作 AI 產圖、角色設計、服裝打版時的體型參照。

## 功能

- **填你知道的就好**：每個數值不是「手動」（你填的），就是「推算」（依你填的數值與體型算出）。推算值旁邊列出一般人的常見範圍（約 10%–90%）。
- **體重跟著體型走**：預設不鎖體重。把腰圍改粗，脂肪會長在腹部、腰側、下背，體重和體脂率跟著變重；手動鎖定體重時維持總質量，依組成條件在可用部位重新分配，填了的圍度多用或省下的量會反映在其他部位（摘要卡會說明）。
- **獨立身體組成**：體脂率與骨骼肌 kg 可各自指定；模型分別記錄脂肪、骨骼肌及其他去脂組織。相同尺寸下也能改變組成與形態。
- **胸、臀、腹代表型**：胸型提供水滴、長水滴／木瓜、圓潤；另有臀型與腹型選擇。型態改變時重新對準手動尺寸及組成。罩杯選單到 S（上下胸圍差 55 cm），罩杯增量不反推全身肌肉。
- **比例**：統一顯示 `1 : r`，如身高：股下、大小腿長度、身高：手臂、上下臂長度。比例和四肢長度互斥：改比例時長度依比例推算，改長度時比例由長度算出。
- **現實檢核**：有可比量測來源的數值提供條件百分位；最細腰、服裝肩寬及人工體脂不冒用不同量法的百分位。輸入衝突與模型未收斂分別顯示，摘要使用實際解。
- **3D 檢視**：中性灰霧面人台（無五官的蛋形頭、有手指腳趾）；凹處僅輕微壓暗；以模型為中心旋轉、平移、縮放；正面／前斜／側面／後斜／背面一鍵回正；畫面上方的工具列切換結構線／網格／無、輪廓線、量測線與手臂角度。
- **輸出**：預設乾淨的目前視角或等比例三視圖；可選擇附量測表。分享連結與代碼保存型態、獨立肌肉量及比例，舊碼仍可載入。

## 怎麼做到的

### 1. 數值連動（`src/core/linkage.ts`）

一般連動使用長度與重量取對數的條件模型；來源量法不同的最細腰、服裝肩寬與放鬆上臂分開處理，不能當成 ANSUR 原始觀測。

- **連動關係**（共變異數）來自 [ANSUR II](https://www.openlab.psu.edu/ansur2/)：2012 年美國陸軍人體計測，1,986 名女性、4,082 名男性，公有領域。
- **平均值**來自 `src/core/reference.ts` 的台灣／東亞年輕成人參考體型。
- ANSUR II 沒有量的項目用模型補上：體脂率由 BMI（Deurenberg 公式）加上腰、臀、二頭肌圍的偏差估算；下胸圍由胸圍減去上下胸圍差，胸圍差大多是個人差異、只有一小部分和體脂相關。細節寫在 `tools/prepare_stats.py`。
- 放鬆上臂與粗分區組成來自 NHANES 2017–2018 的同受試者量測／DXA，採品質篩選、調查權重及留出驗證；與 ANSUR 各自求條件值。整臂不等於上臂，DXA 去脂不等於骨骼肌。
- 比例（`src/core/proportions.ts`）先換算成四肢長度，再交給連動模型。

### 2. 人體網格（`src/body/mh/`）

人體網格與形變目標來自 [MakeHuman](https://github.com/makehumancommunity/makehuman)（CC0）。網格是一整塊封閉的身體（約 13,000 個頂點），所以關節處沒有接縫。

控制與求解分工如下（完整決策及驗證見 [施工紀錄](docs/SHAPE_CONTROL_IMPLEMENTATION.md)）：

1. **框架與截面**（`rings.ts`）：骨架、四肢長度、胸廓及局部截面；手動尺寸是硬條件，推估框架值是參照。
2. **共同區域控制**（`controls.ts`）：父參照、局部軸、拓撲支撐、臀上後側下與腿根過渡。男性採自己的原生肌腹與腹臀規則；肌肉、脂肪及其餘去脂分開校準。
3. **女性胸部**（`breast.ts`）：由 CC0 原生小、中、大杯曲面及同一控制籠延展；根部、上下極、展開及垂墜共同形成三型，沒有額外的乳頭圓頂。
4. **受限分配**：脂肪、骨骼肌、其餘去脂分帳，分配候選後重校手動尺寸與總量；相鄰尺寸以小型局部聯立校正。未鎖體重時，局部增量反映在輸出質量，不反推新的全身肌肉輸入。

脂肪採 0.9 g/cm³，骨骼肌及其餘去脂採 1.06 g/cm³ 的模型近似；總帳與最終中性網格體積閉合。自動骨骼肌比例、乳房組成等仍是明示工程先驗，並非由圍度識別真人組織的醫學模型。

量測在完成平滑的中性曲面進行，姿勢在其後套用。最細腰與最粗臀在有效範圍搜尋；放鬆上臂採肩肘中點；下胸使用同框架與軟組織的胸壁參照。腰臀皮尺只將垂入該高度的自由乳房投回同次求解的胸壁，其餘皮膚仍用最終座標，保留封閉截面；另記原外表面讀值供診斷。上胸保持站姿水平皮尺語意。舊碼保留原數值，未增加未驗證的前傾換算；量法細節及限制見施工紀錄。

每次由確定起點求解；骨架與控制響應可快取，只改手臂姿勢時重用中性解。

這些都在 Web Worker 裡執行（`src/body/worker.ts`），拖動滑桿時畫面不會卡住。

## 準確度與限制

- 手動填的圍度與長度精確：測試涵蓋誇張沙漏、偏胖、高壯男性、G 與 S 罩杯、細腰但體重重、臀圍序列與手動上臂，網格上量到的數值和目標相差在 0.5 cm 內，鎖定的體重在 0.5 kg 內、體脂率在 1 個百分點內；另檢查相鄰輸入的連續性及操作順序的一致性。
- 只填身高時，參考體型的體重與體脂接近參考值（測試檢查 4% 與 3 個百分點內）。
- 支援既有 G／S 及一般／小胸廓 E；極端值仍受網格與控制容量限制。模型未收斂不代表輸入在生理上不可能。
- 初始脂肪分佈仍是造型預設，之後由未填圍度的統計偏好校準；不是醫學上的分段體組成估計，也不保證所有未填圍度落在建議值 ±2～3 cm。手動的極端比例仍可保留。
- 原始網格解析度限制仍在，極大胸的下極及極端臀腿可見離散面；請以多視角與實際殘差判讀。完整驗證狀態見施工紀錄。
- 建議值是「統計上的典型」，不是唯一答案；ANSUR II 是美國軍人，連動關係套用到一般人時會有偏差。
- 量測位置與量法說明寫在每個欄位下方。上臂圍量在上臂中段；腰圍是肋骨與骨盆之間最細處；肩寬是左肩點經過後頸點到右肩點（服裝量法）。

## 開發

```bash
npm ci
npm run dev      # 開發伺服器
npm test         # 連動模型與網格的測試
npm run test:body-report -- /absolute/output/body-report.json  # 產物必須在倉庫外
npm run test:ui -- /absolute/output/ui
npm run test:shape-report -- /absolute/output/images T1 T3 T6
npm run build    # 輸出到 dist/
npm run build:single   # 另外打包成單一 HTML（dist/bodyref-single.html），不需要伺服器就能打開
```

協作規則（含 AI 編碼代理）寫在 `AGENTS.md`；目前狀態、已知問題與還沒做的規劃在 `docs/HANDOFF.md`，開發過程與每次轉向的理由在 `docs/HISTORY.md`。

開發與 CI 使用 Node.js 22（22.12 以上）。

### 重新產生資料檔

`public/body.bin`、`src/body/mh/manifest.json`、`src/core/statsModel.json` 與 `src/core/nhanesModel.json` 都由 `tools/` 裡的腳本產生，需要 Python 3 與 numpy：

```bash
git clone --depth 1 https://github.com/makehumancommunity/makehuman /tmp/makehuman
python3 tools/prepare_body.py /tmp/makehuman/makehuman/data

# ANSUR II 的 CSV 可從 https://www.openlab.psu.edu/ansur2/ 下載
python3 tools/prepare_stats.py "ANSUR II FEMALE Public.csv" "ANSUR II MALE Public.csv"

# NHANES 2017–2018 DEMO_J、BMX_J、DXX_J（另需 pandas）
python3 tools/prepare_nhanes.py /path/to/nhanes-files
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
      model.ts          顯示前的平滑與擺手臂
      egghead.ts        人台頭與脖子
      guides.ts         結構線
      engine.ts         把以上組成畫面需要的輸出
  view/                 Three.js 顯示層
  ui/                   面板、摘要、匯出與分享
tools/                  資料準備、數值回歸與單檔打包腳本
```

### 常見的擴充方式

- **新增量測項目**：在 `core/measurements.ts` 加一筆定義、在 `tools/prepare_stats.py` 對應到 ANSUR II 的欄位、在 `body/mh/measure.ts` 定義怎麼在網格上量、在 `body/mh/rings.ts` 決定由哪一圈或哪一區負責，並在 `body/goals.ts` 決定它是骨架（照建議值）還是軟組織（只有手動填才固定）。
- **脂肪分佈**：`rings.ts` 的 `FAT_SHARE`（變胖）、`LOSS_SHARE`（變瘦）、`LEAN_SHARE`（去脂組織）決定初始分配，再依未填圍度的軟偏好校準。新增 InBody 分段輸入時，需一起處理初始分配與總量條件。
- **型態指定（胸型、臀型）**：每一塊肉的位置、範圍、下垂與變薄方式都寫在 `rings.ts` 的 `build`；胸型、臀型可以做成這些數值的預設組合（例如水滴、圓盤、碗公）。修改形狀後須同步校準體積與尺寸響應，維持手動尺寸與總量條件。
- **姿勢**：MakeHuman 的骨架與蒙皮權重（CC0）可以直接用；目前只用來轉手臂角度。

## 這個專案怎麼做出來的

構想、需求、體型與比例的判斷、每一版的驗收由作者負責；程式碼與文件由 AI 編碼代理（Claude Code 等）依討論結果撰寫。開發過程中幾次推翻重來的理由記錄在 `docs/HISTORY.md`。

## 授權與來源

本專案以 [GNU Affero General Public License v3.0 或更新版本](LICENSE)（AGPL-3.0-or-later）釋出：可以自由使用、修改、散布，但散布修改版或拿修改版架設網路服務時，必須以同樣的授權公開完整原始碼，並保留原作者的著作權聲明。

Copyright (C) 2026 asasasdad0329

- 人體網格、形變目標、骨架權重：MakeHuman 1.x 資產，CC0 1.0。本專案只使用其資產檔，沒有使用 MakeHuman 的程式碼。
- 人體計測資料：ANSUR II、NHANES 2017–2018，美國政府公有領域資料。
- 其他第三方程式庫與字型的授權見 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 規劃中

- 更多胸臀腹代表型、局部自由控制、精細肌肉刻線（腹肌、人魚線、馬甲線）、InBody 分段數據輸入、常用姿勢
- 第三階段：自訂動作、貼圖與皮膚、帶空間位置的三圍圖、AI 產圖用的深度圖／法線圖／骨架圖輸出
