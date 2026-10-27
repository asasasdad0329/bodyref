# 交接

接手只要讀四樣東西：

1. [VISION](VISION.md)：作者的理念與設計原則（要什麼）。
2. [PLAN](PLAN.md)：現行規劃（怎麼做）。
3. [工作區狀態總表](work/README.md)：做到哪。
4. 進行中的那一個工作檔：細節、紀錄、下一步。

決定與理由在 [DECISIONS](DECISIONS.md)；走過的路在 [HISTORY](HISTORY.md)；舊文件在 [archive](archive/)。

## 接力紀錄

只留最近幾次；每次交棒在最上面加一段：日期、代理、做了什麼、下一步、未決問題。細節寫在工作檔，不寫在這裡。

### 2026-10-26 · Claude

- 做了：研究 R1～R19 全部完成；定下四個系統（#57）與臀的四條變形線（#58）。臀的獨立模改成在 Blender 裡用控制籠從零建（#59，`tools/blender/glute_model.py`），第一版中性型的臀圍、寬、厚、大腿圍都接近目標，算圖與自我檢查記在 [01-glute](work/c1-lower-body/01-glute.md)。
- 下一步：作者看純脂肪線第一版（關鍵形＋動畫）；之後加下垂與柔化，再做純肌肉線（見 01-glute「純脂肪線第一版」）→ 修到通過 → 依序做純脂肪線、純肌肉線、組成線、骨架線（籠上的形狀鍵）。完成條件：每條線有兩端與中間的算圖，臀圍隨線單調。
- 未決：中性臀型；數值控制的資料形式（見 DECISIONS 待決定）。Blender 4.2 LTS 要在容器裡另外下載（約 350 MB），算圖需要 libegl1 等套件，見 01-glute 的「工具」。

### 2026-10-25 · Claude

- 做了：數據討論定下 DECISIONS #19～#43（含變形軸範本）；研究總表 R1～R18 列於[基礎軌第 10 節](work/00-foundation/README.md)。第一批（R1～R5，NHANES DXA）完成，結果在 [research-composition.md](work/00-foundation/research-composition.md)，程式在 `tools/research/`。
- 下一步：第一批的三項已決定（#44、#45、#47）；第二批（骨架）已完成（#48、#49）；第一～六批研究全部完成（R1～R18，見基礎軌第 10 節與各研究檔）。下一步：作者看 DECISIONS「待決定」（預設體型、罩杯定義等）；依 DECISIONS #43 用研究結果把變形軸定案；形狀軌開始 C1-1 臀的 ① 構型。完成條件：每項都有數字、限制與對形狀軌的意義，記入研究資料庫。
- 未決：見 [DECISIONS 待決定](DECISIONS.md#待決定)。原始資料在容器暫存區，換容器要重新下載（來源見基礎軌第 8 節）。

### 2026-10-24 · Claude

- 做了：檢視 Codex 的三輪實作與 PR #15，和作者重新規劃。建立 VISION、PLAN、DECISIONS 與工作區；舊計畫文件歸檔。決定不回滾 main、關閉 PR #15。
- 下一步：基礎軌帶入分區並等作者決定 D1、D2；形狀軌開始 C1-1 臀的 ① 構型。
- 未決：D1、D2（見[基礎軌](work/00-foundation/README.md)）。
