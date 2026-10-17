// Replitの「全データ書き出し」ZIPを、スプレッドシートに取り込むCSVと学生ページ用の写真に変換する。
// 使い方: node tools/convert-export.mjs <書き出しZIP または 展開済みフォルダ>
// 出力:
//   output/物品シート.csv   … スプレッドシートの「物品」シートに読み込む
//   docs/images/thumb/  一覧用の小さい写真（幅360px）
//   docs/images/full/   拡大用の写真（長辺1600px）
//   output/保管用/              貸出申請履歴・利用記録などの元CSV（記録として保管）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const OUT = path.join(ROOT, 'output');
const IMG = path.join(ROOT, 'docs', 'images');

// 学生ページ・スプレッドシートで使う列（docs/index.html の COLUMNS と同じ並び）
const SHEET_HEADERS = ['物品ID', '名前', 'カテゴリ', '説明', '総数', '使える数', '部屋', '棚', '場所メモ', '物品写真', '場所写真', '表示'];

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
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
  return rows.filter((r) => r.some((v) => v.trim()));
}

function readTable(file) {
  const [headers, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows) => '﻿' + rows.map((r) => r.map((v) => csvCell(String(v ?? ''))).join(',')).join('\r\n') + '\r\n';

// ZIP内のファイルは「〜.image」で記録され、実際の拡張子は書き出し時に決まるため、拡張子を除いた名前で探す
function findFile(dir, recorded) {
  if (!recorded) return null;
  const want = recorded.replace(/\\/g, '/').replace(/\.[^./]+$/, '');
  const exact = path.join(dir, recorded);
  if (fs.existsSync(exact)) return exact;
  const folder = path.join(dir, path.dirname(want));
  if (!fs.existsSync(folder)) return null;
  const base = path.basename(want);
  const hit = fs.readdirSync(folder).find((f) => f.replace(/\.[^.]+$/, '') === base);
  return hit ? path.join(folder, hit) : null;
}

function findRoot(dir) {
  if (fs.existsSync(path.join(dir, '物品一覧.csv'))) return dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { const r = findRoot(path.join(dir, e.name)); if (r) return r; }
  }
  return null;
}

async function saveImage(src, name) {
  // スマホ写真の向き情報（EXIF）を反映してから縮小する
  await sharp(src).rotate().resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 }).toFile(path.join(IMG, 'thumb', name));
  await sharp(src).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toFile(path.join(IMG, 'full', name));
}

async function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.error('使い方: node tools/convert-export.mjs <書き出しZIP または 展開済みフォルダ>');
    process.exit(1);
  }
  let dir = input;
  if (fs.statSync(input).isFile()) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-'));
    // Windows 10以降に標準で入っている tar はZIPを展開できる（Git付属のtarはZIP非対応なので名指しする）
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', input, '-C', dir]);
  }
  dir = findRoot(dir);
  if (!dir) throw new Error('物品一覧.csv が見つかりません。Replitの「全データ書き出し」のZIPか確認してください。');

  const items = readTable(path.join(dir, '物品一覧.csv'));
  fs.mkdirSync(path.join(IMG, 'thumb'), { recursive: true });
  fs.mkdirSync(path.join(IMG, 'full'), { recursive: true });

  const rows = [SHEET_HEADERS];
  const missing = [];
  for (const it of items) {
    const id = it['物品ID'];
    const safeId = id.replace(/[^\w-]/g, '_');
    // 変換できない形式（HEICなど）が混ざっていても、ほかの物品の変換は続ける
    const convert = async (recorded, out, label) => {
      if (!recorded) return '';
      const src = findFile(dir, recorded);
      if (!src) { missing.push(`${it['名前']}（${label}）：ZIPに入っていません`); return ''; }
      try { await saveImage(src, out); return out; }
      catch (e) { missing.push(`${it['名前']}（${label}）：変換できない形式です ${path.basename(src)}`); return ''; }
    };
    const photo = await convert(it['写真ファイル名'], `${safeId}.webp`, '物品写真');
    const locPhoto = await convert(it['地図画像ファイル名'], `${safeId}_place.webp`, '配置の写真');
    const note = [it['場所コード'] && `場所コード ${it['場所コード']}`, it['メモ']].filter(Boolean).join('／');
    rows.push([
      id, it['名前'], it['カテゴリ'], it['説明'], it['総数'], it['現在の空き数'],
      it['部屋名'], it['棚の詳細'], note, photo, locPhoto, it['有効/無効'] === '無効' ? '非表示' : '',
    ]);
  }

  fs.mkdirSync(path.join(OUT, '保管用'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '物品シート.csv'), toCsv(rows));
  // 学生ページを手元で確認するためのコピー（本番はスプレッドシートから読む）
  fs.writeFileSync(path.join(ROOT, 'docs', 'items.csv'), toCsv(rows));
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.csv')) fs.copyFileSync(path.join(dir, f), path.join(OUT, '保管用', f));
  }

  console.log(`物品 ${items.length}件を変換しました。`);
  console.log(`  スプレッドシート用: ${path.join(OUT, '物品シート.csv')}`);
  console.log(`  写真: ${path.join(IMG)}`);
  if (missing.length) console.log(`取り込めなかった写真 ${missing.length}件（管理者画面で撮り直してください）:\n  ${missing.join('\n  ')}`);
  const skipped = path.join(dir, '書き出せなかった画像.txt');
  if (fs.existsSync(skipped)) console.log(`\nReplit側で書き出せなかった画像:\n${fs.readFileSync(skipped, 'utf8')}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
