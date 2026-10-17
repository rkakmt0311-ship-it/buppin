// clasp で送るファイル一式を build/gas に作る。
// output/物品シート.csv があれば、初回の取り込み用に INITIAL_DATA.gs も作る。
// 使い方: node tools/build-gas.mjs  →  cd build/gas && npx clasp push
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'admin-gas';
const OUT = path.join('build', 'gas');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));

const csvFile = path.join('output', '物品シート.csv');
if (fs.existsSync(csvFile)) {
  const text = fs.readFileSync(csvFile, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  const data = body.map((r) => Object.fromEntries(head.map((h, i) => {
    const v = r[i] ?? '';
    return [h, /^(総数|使える数)$/.test(h) && /^\d+$/.test(v) ? Number(v) : v];
  })));
  fs.writeFileSync(path.join(OUT, 'INITIAL_DATA.gs'),
    `// 引き継ぎデータ（初期設定で空のシートに書き込む）。取り込み後は削除してよい。\nconst INITIAL_DATA = ${JSON.stringify(data, null, 0)};\n`);
  console.log(`INITIAL_DATA.gs: ${data.length}件`);
}
console.log(`作成しました: ${OUT}`);
