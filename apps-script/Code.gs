/* =====================================================================
 * ระบบนัดทำฟัน — Backend (Google Apps Script, ผูกกับ Google Sheet)
 * ไฟล์: Code.gs  +  Engine.gs (ตรรกะกฎนัด — คัดลอกจาก engine.js)
 * วิธีติดตั้งดูใน README.md
 * ===================================================================== */
var TZ = 'Asia/Bangkok';
var SHEETS = {
  appts:    { name: 'Appointments', cols: ['apptNo','createdAt','date','time','endTime','session','durationMin','title','firstName','lastName','age','phone','treatment','rights','status','source','adminOnly','pinHash','note','rescheduledFrom','rescheduledTo','updatedAt','updatedBy'] },
  closures: { name: 'Closures',     cols: ['date','reason','createdBy','createdAt'] },
  audit:    { name: 'AuditLog',     cols: ['time','admin','action','apptNo','detail'] },
  settings: { name: 'Settings',     cols: ['key','value'] },
  admins:   { name: 'Admins',       cols: ['username','displayName','salt','hash','active'] }
};
var NUM_COLS = { age: 1, durationMin: 1 };
var SESSION_TTL = 6 * 60 * 60;   // 6 ชม. (สูงสุดของ CacheService)

/* ---------------------------------------------------------------- Web App */
function doGet() {
  return json_({ ok: true, service: 'dental-queue', time: stamp_() });
}

function doPost(e) {
  var req, res;
  try {
    req = JSON.parse(e.postData.contents);
    res = route_(req);
  } catch (err) {
    console.error(err && err.stack || err);
    res = { ok: false, code: 'SERVER', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' };
  }
  return json_(res);
}

function route_(req) {
  var action = String(req.action || ''), params = req.params || {};
  if (action === 'adminLogin')  return login_(params);
  if (action === 'adminLogout') { CacheService.getScriptCache().remove('sess_' + req.token); return { ok: true, data: {} }; }
  if (action === 'adminMe')     { var s0 = session_(req.token); return s0 ? { ok: true, data: { name: s0.name } } : { ok: false, code: 'AUTH', message: 'กรุณาเข้าสู่ระบบ' }; }
  if (!Engine.isKnown(action))  return { ok: false, code: 'BAD_ACTION', message: 'ไม่รู้จักคำสั่ง' };

  var admin = null;
  if (Engine.isAdminAction(action)) {
    var s = session_(req.token);
    if (!s) return { ok: false, code: 'AUTH', message: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบอีกครั้ง' };
    admin = s.name;
  }

  if (!Engine.isWrite(action)) return Engine.handle(action, params, ctx_(admin));

  // งานเขียนข้อมูล: ล็อกทั้งสคริปต์ เพื่อกันผู้ป่วยหลายคนจองคิวสุดท้ายพร้อมกัน
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, code: 'BUSY', message: 'ระบบกำลังประมวลผลคำขออื่นอยู่ กรุณาลองอีกครั้ง' };
  try {
    var cache = CacheService.getScriptCache(), rid = req.requestId ? 'rq_' + String(req.requestId).slice(0, 64) : null;
    if (rid) {                                   // กันกดยืนยัน/ส่งซ้ำ → คืนผลเดิม ไม่สร้างนัดใหม่
      var prev = cache.get(rid);
      if (prev) return JSON.parse(prev);
    }
    var res = Engine.handle(action, params, ctx_(admin));
    if (rid && res.ok) cache.put(rid, JSON.stringify(res), 600);
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------------- Context */
function ctx_(admin) {
  return {
    db: db_, admin: admin,
    now: function () {
      var n = new Date();
      return { date: Utilities.formatDate(n, TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(n, TZ, 'HH:mm'), stamp: stamp_() };
    },
    hash: function (s) { return sha_(pepper_() + s); },
    randomPin: function () { return ('000' + Math.floor(Math.random() * 10000)).slice(-4); },
    throttle: throttle_()
  };
}
function stamp_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function throttle_() {
  var c = CacheService.getScriptCache();
  return {
    blocked: function (k) { return (parseInt(c.get('th_' + k), 10) || 0) >= 5; },
    fail:    function (k) { c.put('th_' + k, String((parseInt(c.get('th_' + k), 10) || 0) + 1), 900); },
    reset:   function (k) { c.remove('th_' + k); }
  };
}

/* ---------------------------------------------------------------- Auth */
function sha_(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8), o = '';
  for (var i = 0; i < b.length; i++) o += ('0' + (b[i] & 0xff).toString(16)).slice(-2);
  return o;
}
function pepper_() {
  var p = PropertiesService.getScriptProperties(), v = p.getProperty('PEPPER');
  if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('PEPPER', v); }
  return v;
}
function pwHash_(password, salt) {
  var h = pepper_() + salt + password;
  for (var i = 0; i < 1000; i++) h = sha_(h + salt);
  return h;
}
function session_(token) {
  if (!token) return null;
  var v = CacheService.getScriptCache().get('sess_' + token);
  return v ? JSON.parse(v) : null;
}
function login_(p) {
  var u = String(p.username || '').trim().toLowerCase(), th = throttle_();
  if (!u || !p.password) return { ok: false, code: 'AUTH', message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' };
  if (th.blocked('lg:' + u)) return { ok: false, code: 'TOO_MANY', message: 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที' };
  var rows = readAll_(SHEETS.admins), row = null;
  rows.forEach(function (r) { if (String(r.username).toLowerCase() === u && String(r.active).toUpperCase() !== 'N') row = r; });
  var ok = row && pwHash_(String(p.password), String(row.salt)) === String(row.hash);
  if (!ok) { th.fail('lg:' + u); return { ok: false, code: 'AUTH', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }; }
  th.reset('lg:' + u);
  var token = Utilities.getUuid() + Utilities.getUuid();
  var name = row.displayName || row.username;
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify({ u: u, name: name }), SESSION_TTL);
  db_.addAudit({ time: stamp_(), admin: name, action: 'login', apptNo: '', detail: '' });
  return { ok: true, data: { token: token, name: name } };
}

/* ---------------------------------------------------------------- Sheet adapter */
function sheet_(def) {
  var s = SpreadsheetApp.getActive().getSheetByName(def.name);
  if (!s) throw new Error('ไม่พบชีต ' + def.name + ' — กรุณารัน "ติดตั้งระบบ" จากเมนู');
  return s;
}
function cell_(col, v) {
  if (v instanceof Date) {
    if (col === 'date') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    if (col === 'time' || col === 'endTime') return Utilities.formatDate(v, TZ, 'HH:mm');
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  if (NUM_COLS[col]) return Number(v) || 0;
  return v === null || v === undefined ? '' : String(v);
}
function readAll_(def) {
  var s = sheet_(def), last = s.getLastRow();
  if (last < 2) return [];
  var vals = s.getRange(2, 1, last - 1, def.cols.length).getValues();
  return vals.map(function (r) {
    var o = {};
    def.cols.forEach(function (c, i) { o[c] = cell_(c, r[i]); });
    return o;
  });
}
function appendRows_(def, objs) {
  if (!objs.length) return;
  var s = sheet_(def), start = s.getLastRow() + 1;
  var rows = objs.map(function (o) { return def.cols.map(function (c) { return o[c] === undefined ? '' : o[c]; }); });
  s.getRange(start, 1, rows.length, def.cols.length).setValues(rows);   // คอลัมน์เป็นรูปแบบ "ข้อความ" จึงไม่ถูกตีความเป็นสูตร
}
function findRow_(def, keyCol, key) {
  var s = sheet_(def), last = s.getLastRow();
  if (last < 2) return -1;
  var k = def.cols.indexOf(keyCol) + 1;
  var vals = s.getRange(2, k, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(cell_(keyCol, vals[i][0])) === String(key)) return i + 2;
  return -1;
}

var db_ = {
  getSettings: function () {
    var o = {};
    readAll_(SHEETS.settings).forEach(function (r) { if (r.key) o[r.key] = r.value; });
    return o;
  },
  saveSettings: function (obj) {
    var s = sheet_(SHEETS.settings);
    Object.keys(obj).forEach(function (k) {
      var row = findRow_(SHEETS.settings, 'key', k);
      if (row < 0) s.appendRow([k, String(obj[k])]); else s.getRange(row, 2).setValue(String(obj[k]));
    });
  },
  listAppointments: function () { return readAll_(SHEETS.appts); },
  addAppointment: function (rec) { appendRows_(SHEETS.appts, [rec]); },
  updateAppointment: function (no, patch) {
    var row = findRow_(SHEETS.appts, 'apptNo', no);
    if (row < 0) throw new Error('ไม่พบนัด ' + no);
    var s = sheet_(SHEETS.appts), cols = SHEETS.appts.cols;
    Object.keys(patch).forEach(function (k) {
      var i = cols.indexOf(k);
      if (i >= 0) s.getRange(row, i + 1).setValue(patch[k]);
    });
  },
  deleteAppointment: function (no) {      // ใช้เฉพาะย้อนกลับกรณีเลื่อนนัดล้มเหลวกลางทาง
    var row = findRow_(SHEETS.appts, 'apptNo', no);
    if (row > 0) sheet_(SHEETS.appts).deleteRow(row);
  },
  listClosures: function () { return readAll_(SHEETS.closures); },
  addClosures: function (rows) { appendRows_(SHEETS.closures, rows); },
  removeClosure: function (date) {
    var row = findRow_(SHEETS.closures, 'date', date);
    if (row > 0) sheet_(SHEETS.closures).deleteRow(row);
  },
  addAudit: function (e) { appendRows_(SHEETS.audit, [e]); },
  listAudit: function (limit) {
    var s = sheet_(SHEETS.audit), last = s.getLastRow();
    if (last < 2) return [];
    var n = Math.min(limit || 200, last - 1);
    var vals = s.getRange(last - n + 1, 1, n, SHEETS.audit.cols.length).getValues();
    return vals.map(function (r) {
      var o = {}; SHEETS.audit.cols.forEach(function (c, i) { o[c] = cell_(c, r[i]); }); return o;
    }).reverse();
  }
};

/* ---------------------------------------------------------------- เมนูในชีต */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🦷 ระบบนัดทำฟัน')
    .addItem('1) ติดตั้งระบบ (สร้างชีต/ค่าเริ่มต้น)', 'setup')
    .addItem('2) เพิ่ม / เปลี่ยนรหัสผ่าน ผู้ดูแล', 'addAdmin')
    .addItem('3) ตั้งเวลาสำรองข้อมูล + ลบข้อมูลเก่า (อัตโนมัติ)', 'installTriggers')
    .addSeparator()
    .addItem('สำรองข้อมูลตอนนี้', 'backupNow')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (k) {
    var def = SHEETS[k], s = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    if (s.getLastRow() === 0) s.getRange(1, 1, 1, def.cols.length).setValues([def.cols]);
    s.getRange(1, 1, 1, def.cols.length).setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    s.setFrozenRows(1);
    // ทั้งแผ่นเป็นข้อความ: เบอร์โทรไม่ตัด 0 หน้า, วันที่ไม่ถูกแปลง, และไม่ถูกตีความเป็นสูตร
    s.getRange(1, 1, s.getMaxRows(), def.cols.length).setNumberFormat('@');
  });
  // ค่าเริ่มต้นการตั้งค่า
  var have = {};
  readAll_(SHEETS.settings).forEach(function (r) { have[r.key] = 1; });
  Object.keys(Engine.DEFAULTS).forEach(function (k) {
    if (!have[k]) sheet_(SHEETS.settings).appendRow([k, Engine.DEFAULTS[k]]);
  });
  // สีสถานะในชีตนัดหมาย
  var a = ss.getSheetByName(SHEETS.appts.name), col = SHEETS.appts.cols.indexOf('status') + 1;
  var rng = a.getRange(2, 1, a.getMaxRows() - 1, SHEETS.appts.cols.length), L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.charAt(col - 1);
  var colors = { waiting: '#fef9c3', treating: '#dbeafe', done: '#dcfce7', cancelled: '#fee2e2', noshow: '#e5e7eb' };
  a.setConditionalFormatRules(Object.keys(colors).map(function (st) {
    return SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + L + '2="' + st + '"').setBackground(colors[st]).setRanges([rng]).build();
  }));
  pepper_();
  var d = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (d && ss.getSheets().length > 1) ss.deleteSheet(d);
  SpreadsheetApp.getUi().alert('ติดตั้งเรียบร้อย\n\nขั้นต่อไป: เมนู "เพิ่ม / เปลี่ยนรหัสผ่าน ผู้ดูแล" เพื่อสร้างบัญชี Admin คนแรก');
}

function addAdmin() {
  var ui = SpreadsheetApp.getUi();
  var u = ui.prompt('ชื่อผู้ใช้ (ภาษาอังกฤษ/ตัวเลข)', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  var username = u.getResponseText().trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return ui.alert('ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 3–30 ตัวอักษร');
  var n = ui.prompt('ชื่อที่แสดง / ชื่อเจ้าหน้าที่ (ใช้บันทึกใน Log)', ui.ButtonSet.OK_CANCEL);
  if (n.getSelectedButton() !== ui.Button.OK) return;
  var p = ui.prompt('รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK) return;
  var pw = p.getResponseText();
  if (pw.length < 8) return ui.alert('รหัสผ่านสั้นเกินไป');
  var salt = Utilities.getUuid(), rec = { username: username, displayName: n.getResponseText().trim() || username, salt: salt, hash: pwHash_(pw, salt), active: 'Y' };
  var row = findRow_(SHEETS.admins, 'username', username);
  if (row > 0) sheet_(SHEETS.admins).getRange(row, 1, 1, 5).setValues([[rec.username, rec.displayName, rec.salt, rec.hash, rec.active]]);
  else appendRows_(SHEETS.admins, [rec]);
  ui.alert('บันทึกผู้ดูแล "' + username + '" แล้ว (รหัสผ่านถูกเข้ารหัส ไม่เก็บเป็นข้อความ)');
}

/* ---------------------------------------------------------------- งานอัตโนมัติ */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['backupNow', 'purgeOld'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).inTimezone(TZ).create();
  ScriptApp.newTrigger('purgeOld').timeBased().onMonthDay(1).atHour(3).inTimezone(TZ).create();
  SpreadsheetApp.getUi().alert('ตั้งเวลาแล้ว: สำรองข้อมูลทุกวัน 02:00 น. (เก็บ 30 ชุดล่าสุด) / ลบข้อมูลเกินกำหนดเก็บรักษา ทุกวันที่ 1 ของเดือน 03:00 น.');
}

function backupNow() {
  var ss = SpreadsheetApp.getActive(), it = DriveApp.getFoldersByName('DentalQueue-Backups');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('DentalQueue-Backups');
  DriveApp.getFileById(ss.getId()).makeCopy('Backup-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm'), folder);
  var files = [], fi = folder.getFiles();
  while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(30).forEach(function (f) { f.setTrashed(true); });
}

/* ลบข้อมูลที่เกินระยะเวลาเก็บรักษา (ค่าเริ่มต้น 365 วัน) — ไม่ลบนัดที่ยังใช้งานอยู่ */
function purgeOld() {
  var days = parseInt(db_.getSettings().retentionDays, 10) || 365;
  var cutoff = Utilities.formatDate(new Date(Date.now() - days * 86400000), TZ, 'yyyy-MM-dd');
  [[SHEETS.appts, 'date', true], [SHEETS.closures, 'date', false], [SHEETS.audit, 'time', false]].forEach(function (x) {
    var def = x[0], col = def.cols.indexOf(x[1]), st = def.cols.indexOf('status'), s = sheet_(def), last = s.getLastRow();
    if (last < 2) return;
    var vals = s.getRange(2, 1, last - 1, def.cols.length).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      var d = String(cell_(def.cols[col], vals[i][col])).slice(0, 10);
      var active = x[2] && ['waiting', 'treating'].indexOf(String(vals[i][st])) >= 0;
      if (d && d < cutoff && !active) s.deleteRow(i + 2);
    }
  });
}
