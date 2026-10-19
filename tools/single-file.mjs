// 把 dist/ 打包成單一 HTML：CSS、JS 內嵌，人體網格（body.bin）以 base64 內嵌，
// 不需要伺服器就能打開，方便離線分享或上傳到只收單一檔案的地方。
// 用法：npm run build:single（先 build，再輸出 dist/bodyref-single.html）
import fs from 'node:fs';
import path from 'node:path';

const [, , distDir = 'dist', out = path.join(distDir, 'bodyref-single.html')] = process.argv;
const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(distDir, rel), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)].map((m) => read(m[1])).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/g)].map((m) => read(m[1])).join('\n');
const bin = fs.readFileSync(path.join(distDir, 'body.bin')).toString('base64');
const fonts = html.match(/<link\s+rel="stylesheet"\s+href="https:\/\/fonts[^>]+>/)?.[0] ?? '';
const body = html.split(/<body>/)[1].split(/<\/body>/)[0].replace(/<script[\s\S]*?<\/script>/g, '');
const title = html.match(/<title>[^<]*<\/title>/)[0];

const result = `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${title}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
${fonts}
<style>${css}</style>
${body}
<script>window.__BODYREF_BODY_BIN__ = "${bin}";</script>
<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>
`;
fs.writeFileSync(out, result);
console.log(`${out}：${(result.length / 1e6).toFixed(1)} MB`);
