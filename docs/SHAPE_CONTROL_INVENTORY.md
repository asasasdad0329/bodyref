# A：現有數值與控制（2026-10-24）

盤點基於 main `11e8fda`，模型仍是已上線 `8c0c203`。本頁只記錄現有內容，不代表造型或變形方法合格；不重建基準。施工順序以主計畫第2節的作者最新指示為準。

## UI 數據目前代表什麼

| 輸入 | 目前意義／相依關係 | 現有入口 |
| --- | --- | --- |
| 性別 | 切換男女參考、材料、區域規則；不是同一形狀等比縮放 | `state`、`goals`、`rings` |
| 身高 cm | 模型頂端到腳底；比例換算與骨架尺度的基準 | `frame.height` |
| 體重 kg | 固定時要求總組成質量；未固定時是模型輸出 | `weight`、`weightLocked` |
| 體脂 % | 脂肪占總質量，內部0–1；與肌肉分開 | `bodyFat`、`bodyFatLocked` |
| 骨骼肌 kg | 骨骼肌估計量，與其他去脂分帳；不能大於可用去脂量 | `muscleMass` |
| 罩杯 | 既有上下胸圍差；與直接上胸數值的相依由linkage處理 | `cupDiff`、`bustDiff` |
| 上胸圍 cm | **現版：站姿實際皮尺；C2必須改成俯身量測錨點**。男性仍為胸部圍度 | `frame.bust`（女）、`locked.bust`（男） |
| 下胸圍 cm | 肋骨胸壁參照；女性不量穿過自由乳房的站姿截面 | `frame.underbust` |
| 腰圍 cm | 使用者最細腰；資料肚臍腰另記，不能固定公分換算 | `locked.waist`、`preferred.waist` |
| 臀圍 cm | 臀區最大水平皮尺，保留實際高度 | `locked.hip` |
| 大腿圍 cm | 胯下至膝長度向下10%的大腿截面 | `locked.thigh` |
| 小腿圍 cm | 膝到踝區間搜尋小腿肚最大截面 | `locked.calf` |
| 臂圍 cm | 肩峰—肘尖中點、垂直肱骨軸的放鬆圍 | `locked.upperArm` |
| 頸圍／腕圍／踝圍 cm | 各自區域的皮尺；頸與末端原有截面控制 | `frame.neck/wrist/ankle` |
| 肩寬 cm | 左肩點經後頸到右肩點的服裝量法；骨點直線另記 | `frame.shoulder` |
| 上臂／前臂長 cm | 肩到肘、肘到腕；與手臂比例互斥 | `frame.upperArmLen/forearmLen` |
| 大腿／小腿長 cm | 胯下到膝、膝到踝；與腿比例互斥 | `frame.thighLen/calfLen` |
| 身高：股下／手臂長 | UI為1:r，先換算成長度；手臂長不是臂展 | `proportions.applyRatios` |
| 大腿：小腿／上臂：前臂 | UI為1:r，舊內部值為上段÷下段，顯示取倒數 | `ratioToDisplay` |
| 胸型／臀型／腹型 | 型態選擇，與尺寸、肌脂分開；舊碼使用確定預設 | `Morphology` |
| 手臂角度 | 完成中性造型後的姿勢，不能改尺寸與組成 | `BodyModel.display` |

手動值保持原目標；未填值是估計或軟偏好。未鎖體重時，改罩杯的局部量體不能反推成全身增肌。比例與直接長度的相依沿用現有規則；各輪到接數據時，再整理並實作該輪具體牽動與形變錨點。

## 已有控制項（不等於變形方法已完成）

| 區塊 | 現有控制／材料 | 現在怎麼做 |
| --- | --- | --- |
| 全身框架 | 身高、肩、四肢長度、胸廓 | 原生長度目標、截面前後側倍率、骨架校準 |
| 腰 | `waist`、`waist-sideL/R`、`lumbar` | 截面縮放＋腰側與後腰位移 |
| 腹 | `abdomen-front`、`lower-abdominal-cover`、`abdomen-profile` | 前腹／下腹位移、整區寬深改型 |
| 臀 | `glute-upper/rear/lower L/R`、`lateral-gluteL/R`、`hip-profile` | 上後下分帶、側向材料、整區寬深改型 |
| 腿根 | `lateral-rootL/R`、`thighCover`、腿根截面 | 外側支撐與整腿截面承接；尚無獨立的已完成連續造型序列 |
| 大腿 | `thigh`、`thighFat`、`thighMuscle` | 沿長度的前後內外倍率，脂肪／肌肉不同方向 |
| 小腿 | `calf`、`calfFat`、`calfMuscle` | 小腿肚到膝踝的截面曲線 |
| 女性胸 | 左右胸根、`width/height/depth/separation/upper-pole/lower-pole/sag/orientation` | 原生小中大杯材料＋局部變換；三型仍需按新施工順序重建 |
| 男性胸 | 胸廓弧、`pectoral-cover`、胸肌材料 | 胸廓前後側分配＋前胸覆蓋 |
| 胸／背／臀肌 | 各自`maximum/minimum/fat-maximum/fat-minimum/volume` | 原生正負肌肉、肌脂交互材料、額外體量 |
| 上背 | `thoracic-back` | 獨立上背位移 |
| 上臂 | `upperArm`、`armFat`、`armMuscle` | 沿肩肘軸的方向性截面 |
| 頸與末端 | `neck/neckFat/wrist/ankle` | 截面控制，手腳承接末端尺度 |
| 共同覆蓋／其他去脂 | `general-cover`、`other-lean-envelope` | 原生體脂材料＋包絡；不是可任意吸收誤差的出口 |

現有模型資產：13,380個身體頂點、13,378個四邊面；另有152個關節輔助點。20個資產區域只粗分軀幹、四肢、胸部等，並沒有完整標出腰、腹、臀上／後／下和周邊範圍。B必須落在這份實際拓撲上細分，不能以現有控制名稱代替模型標定。

現有基準與來源結果保留在 `RELEASE_STATUS.md` 及既有Actions；本次A未重跑造型、效能或完整回歸。
