# 第三方授權與來源

本專案的程式碼與文件以 AGPL-3.0-or-later 釋出（見 `LICENSE`）。專案使用了以下第三方的程式庫、資產與資料，它們各自依原本的授權條款使用。

| 項目 | 用途 | 授權 |
| --- | --- | --- |
| [three.js](https://threejs.org/) | 3D 顯示 | MIT（全文見下方） |
| [Playwright](https://github.com/microsoft/playwright) | 開發用的瀏覽器回歸與外觀證據工具，不包含於網站輸出 | Apache-2.0 |
| [MakeHuman](https://github.com/makehumancommunity/makehuman) 1.x 資產：人體網格、形變目標、骨架權重 | 人體網格（`public/body.bin` 由此產生）；`assets/shapes/female-glute.blend` 的雕形胚體及其匯出材料 | 原始資產 CC0 1.0，本專案新雕形及程式依專案 AGPL-3.0-or-later。只使用資產檔，沒有使用 MakeHuman 的程式碼（AGPL） |
| [ANSUR II](https://www.openlab.psu.edu/ansur2/) 人體計測資料 | 數值連動的統計（`src/core/statsModel.json` 由此產生） | 美國政府公有領域 |
| [NHANES 2017–2018](https://wwwn.cdc.gov/nchs/nhanes/continuousnhanes/default.aspx?BeginYear=2017) DEMO_J、BMX_J、DXX_J | 放鬆上臂與粗分區組成衍生統計（`src/core/nhanesModel.json`）；不附個體資料 | 美國政府公開資料，公有領域 |
| Barlow Condensed、IBM Plex Mono、Noto Sans TC | 介面字型，由 Google Fonts 載入，不包含在本倉庫 | SIL Open Font License 1.1 |

開發與建置用的工具（Vite、TypeScript、Vitest 等）不包含在網站輸出裡，授權為 MIT、Apache-2.0 等寬鬆授權。

## three.js

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
