# 交接

接手只要讀四樣東西：

1. [VISION](VISION.md)：作者的理念與設計原則（要什麼）。
2. [PLAN](PLAN.md)：現行規劃（怎麼做）。
3. [工作區狀態總表](work/README.md)：做到哪。
4. 進行中的那一個工作檔：細節、紀錄、下一步。

決定與理由在 [DECISIONS](DECISIONS.md)；走過的路在 [HISTORY](HISTORY.md)；舊文件在 [archive](archive/)。

## 接力紀錄

只留最近幾次；每次交棒在最上面加一段：日期、代理、做了什麼、下一步、未決問題。細節寫在工作檔，不寫在這裡。

### 2026-10-25 · Claude

- 做了：數據討論定下 DECISIONS #19～#43（含變形軸範本）；研究總表 R1～R18 列於[基礎軌第 10 節](work/00-foundation/README.md)。第一批（R1～R5，NHANES DXA）完成，結果在 [research-composition.md](work/00-foundation/research-composition.md)，程式在 `tools/research/`。
- 下一步：第一批的三項已決定（#44、#45、#47）；第二批（骨架）已完成（#48、#49）；第三批（腰腹）已完成。接著第四批（文獻：R1b 細分區與附著線、R2b 區域肌肥大、R16 骨點與肌肉分界的清晰度）。完成條件：每項都有數字、限制與對形狀軌的意義，記入研究資料庫。
- 未決：見 [DECISIONS 待決定](DECISIONS.md#待決定)。原始資料在容器暫存區，換容器要重新下載（來源見基礎軌第 8 節）。

### 2026-10-24 · Claude

- 做了：檢視 Codex 的三輪實作與 PR #15，和作者重新規劃。建立 VISION、PLAN、DECISIONS 與工作區；舊計畫文件歸檔。決定不回滾 main、關閉 PR #15。
- 下一步：基礎軌帶入分區並等作者決定 D1、D2；形狀軌開始 C1-1 臀的 ① 構型。
- 未決：D1、D2（見[基礎軌](work/00-foundation/README.md)）。
