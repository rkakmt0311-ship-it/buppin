/**
 * 物品管理（管理者用）— スプレッドシートに紐づいた Apps Script。
 * ウェブアプリは「アクセスしているユーザー」として実行するため、
 * スプレッドシートの編集権限がない人は書き込めない（権限はGoogleの共有設定で管理する）。
 */

// 学生用ページのURL（GitHub Pages）。引き継いだ写真（ファイル名だけの写真）を表示するのに使う。
const STUDENT_SITE_URL = 'https://rkakmt0311-ship-it.github.io/buppin/';

const SHEET_NAME = '物品';
const HEADERS = ['物品ID', '名前', 'カテゴリ', '説明', '総数', '使える数', '部屋', '棚', '場所メモ', '物品写真', '場所写真', '表示'];
const FIELDS = ['id', 'name', 'category', 'description', 'total', 'available', 'room', 'shelf', 'note', 'photo', 'locPhoto', 'visible'];
const PHOTO_FOLDER_NAME = '物品写真';

function doGet() {
  const page = canEdit_() ? 'Admin' : 'NoAccess';
  const t = HtmlService.createTemplateFromFile(page);
  t.siteUrl = STUDENT_SITE_URL;
  t.email = Session.getActiveUser().getEmail();
  return t.evaluate()
    .setTitle('物品管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 初回だけ持ち主が実行する：シートの見出しと写真フォルダを用意する */
function 初期設定() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME, 0);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  // 引き継ぎデータ（INITIAL_DATA.gs、移行時だけ置く）があり、シートが空なら書き込む
  if (typeof INITIAL_DATA !== 'undefined' && sh.getLastRow() <= 1) {
    const rows = INITIAL_DATA.map((r) => HEADERS.map((h) => (r[h] == null ? '' : r[h])));
    if (rows.length) sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  photoFolder_();
  SpreadsheetApp.getUi().alert('初期設定が終わりました。');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('物品管理').addItem('初期設定', '初期設定').addToUi();
}

function canEdit_() {
  try {
    const email = Session.getActiveUser().getEmail();
    const file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
    if (file.getOwner() && file.getOwner().getEmail() === email) return true;
    return file.getEditors().some((u) => u.getEmail() === email);
  } catch (e) {
    return false; // 閲覧権限もない場合は開けずに例外になる
  }
}

function sheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('「物品」シートがありません。メニューの「物品管理 → 初期設定」を実行してください。');
  return sh;
}

// 見出しの位置から列番号を求める（列の並びを入れ替えても動くように）
function columns_(sh) {
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const col = {};
  HEADERS.forEach((h, i) => {
    const idx = head.indexOf(h);
    if (idx === -1) throw new Error(`見出し「${h}」が見つかりません。1行目を確認してください。`);
    col[FIELDS[i]] = idx;
  });
  return col;
}

function getItems() {
  const sh = sheet_();
  const col = columns_(sh);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  return values.map((r, i) => {
    const o = { row: i + 2 };
    FIELDS.forEach((f) => { o[f] = r[col[f]] === '' ? '' : String(r[col[f]]); });
    return o;
  }).filter((o) => o.name);
}

function findRow_(sh, col, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, col.id + 1, last - 1, 1).getValues().map((r) => String(r[0]));
  const i = ids.indexOf(String(id));
  return i === -1 ? -1 : i + 2;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 使える数を1つ増減する（＋−ボタン） */
function adjustAvailable(id, delta) {
  return withLock_(() => {
    const sh = sheet_();
    const col = columns_(sh);
    const row = findRow_(sh, col, id);
    if (row === -1) throw new Error('物品が見つかりません。画面を更新してください。');
    const total = Number(sh.getRange(row, col.total + 1).getValue()) || 0;
    const cell = sh.getRange(row, col.available + 1);
    const next = Math.max(0, Math.min(total, (Number(cell.getValue()) || 0) + delta));
    cell.setValue(next);
    return next;
  });
}

/** 物品の追加・更新。写真は {data: base64, type} で受け取ってドライブに保存する */
function saveItem(item) {
  const name = String(item.name || '').trim();
  if (!name) throw new Error('名前を入力してください。');
  const total = parseInt(item.total, 10);
  if (!(total >= 0)) throw new Error('総数は0以上の数字で入力してください。');
  let available = item.available === '' || item.available == null ? total : parseInt(item.available, 10);
  if (!(available >= 0)) throw new Error('使える数は0以上の数字で入力してください。');
  if (available > total) throw new Error('使える数が総数より多くなっています。');

  // 写真の保存はロックの外で行う（時間がかかるため）
  const photo = item.newPhoto ? savePhoto_(item.newPhoto, name) : item.photo;
  const locPhoto = item.newLocPhoto ? savePhoto_(item.newLocPhoto, `${name}_配置`) : item.locPhoto;

  return withLock_(() => {
    const sh = sheet_();
    const col = columns_(sh);
    const id = item.id || newId_();
    const values = {
      id, name, category: item.category, description: item.description, total, available,
      room: item.room, shelf: item.shelf, note: item.note, photo, locPhoto, visible: item.hidden ? '非表示' : '',
    };
    let row = item.id ? findRow_(sh, col, item.id) : -1;
    if (row === -1) { row = sh.getLastRow() + 1; }
    const width = sh.getLastColumn();
    const current = row <= sh.getLastRow() ? sh.getRange(row, 1, 1, width).getValues()[0] : new Array(width).fill('');
    FIELDS.forEach((f) => { current[col[f]] = values[f] == null ? '' : values[f]; });
    sh.getRange(row, 1, 1, width).setValues([current]);
    return id;
  });
}

function newId_() {
  return 'B' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('PHOTO_FOLDER_ID');
  if (saved) {
    try { return DriveApp.getFolderById(saved); } catch (e) { /* 消された場合は作り直す */ }
  }
  // スプレッドシートと同じフォルダに作る → そのフォルダを管理者と共有すれば写真も共有される
  const file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  const parents = file.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const found = parent.getFoldersByName(PHOTO_FOLDER_NAME);
  const folder = found.hasNext() ? found.next() : parent.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function savePhoto_(photo, label) {
  const bytes = Utilities.base64Decode(photo.data);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const blob = Utilities.newBlob(bytes, photo.type || 'image/jpeg', `${label}_${stamp}.jpg`);
  const file = photoFolder_().createFile(blob);
  // 学生用ページ（ログインなし）で表示できるように「リンクを知っている全員が閲覧可」にする
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return `https://drive.google.com/file/d/${file.getId()}/view`;
}
