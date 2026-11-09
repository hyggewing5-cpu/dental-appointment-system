/* =====================================================================
 * engine.js — ตรรกะทั้งหมดของระบบนัดทำฟัน
 * ไฟล์เดียวกันนี้ใช้ทั้งใน Google Apps Script (คัดลอกเป็น Engine.gs)
 * และในเบราว์เซอร์ (โหมดสาธิต) เพื่อให้กฎเหมือนกันทุกที่
 * ไม่ติดต่อ Google Sheets โดยตรง — ใช้ ctx.db ที่ส่งเข้ามา
 * ===================================================================== */
var Engine = (function () {
  'use strict';

  /* ---------- ค่าคงที่ ---------- */
  var DEFAULTS = {
    clinicName: 'งานทันตกรรม โรงพยาบาลกองบิน 5',
    clinicPhone: '',
    titles: 'นาย,นาง,นางสาว,เด็กชาย,เด็กหญิง,พล.อ.อ.,พล.อ.ท.,พล.อ.ต.,น.อ.,น.ท.,น.ต.,ร.อ.,ร.ท.,ร.ต.,พ.อ.อ.,พ.อ.ท.,พ.อ.ต.,จ.อ.,จ.ท.,จ.ต.,พลทหาร', // คำนำหน้าที่ Admin เพิ่ม/ลบได้ (คั่นด้วยจุลภาค)
    notice: '',
    bookingWindowDays: '60',   // เปิดจองล่วงหน้า (1–2 เดือน) Admin ปรับได้
    minAdvanceDays: '1',       // จองได้ตั้งแต่ "พรุ่งนี้"
    rescheduleMinDays: '1',    // เลื่อนเองได้ก่อนวันนัดอย่างน้อย N วัน
    retentionDays: '365',
    patientKeyMode: 'phone_name', // phone | phone_name  (ใช้ระบุว่าเป็น "ผู้ป่วยคนเดียวกัน")
    amSlotMinutes: '30',
    amSlots: '09:00=fill,09:30=fill,10:00=scale_extract,10:30=scale_extract,11:00=scale_extract',
    pmStart: '13:30', pmEnd: '15:30',
    openDaysAM: '1,2,3,4,5',   // 0=อาทิตย์ … 6=เสาร์
    openDaysPM: '1,2,3,4',
    walkinStart: '08:00', walkinEnd: '09:00'
  };

  var TREATMENTS = [
    { id: 'fill',    name: 'อุดฟัน',     group: 'fill' },
    { id: 'scale',   name: 'ขูดหินปูน',  group: 'scale_extract' },
    { id: 'extract', name: 'ถอนฟัน',     group: 'scale_extract' }
  ];
  var ADMIN_TREATMENTS = [
    { name: 'ผ่าฟันคุด', minutes: 90 },
    { name: 'อุดฟันยาก / อุดฟันหน้า', minutes: 60 },
    { name: 'อื่น ๆ (ตามดุลยพินิจทันตแพทย์)', minutes: 30 }
  ];
  var RIGHTS = [
    'สิทธิข้าราชการ / กรมบัญชีกลาง',
    'สิทธิ 30 บาท (โรงพยาบาลกองบิน 5)',
    'เงินสด (รวมประกันสังคม)'
  ];
  var OTHER_TITLE = 'อื่น ๆ'; // ตัวเลือกพิเศษ: ให้ผู้ใช้พิมพ์คำนำหน้าเอง (ไม่เก็บค่านี้ลงข้อมูล)
  var STATUSES = ['waiting', 'treating', 'done', 'cancelled', 'noshow'];
  var ACTIVE = ['waiting', 'treating'];
  var FREE = ['cancelled', 'noshow'];

  /* ---------- ข้อผิดพลาด ---------- */
  function fail(code, message, extra) {
    var e = new Error(message);
    e.__engine = true; e.code = code; e.extra = extra || null;
    throw e;
  }

  /* ---------- วัน/เวลา (รูปแบบ YYYY-MM-DD และ HH:MM) ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
  function dow(s) { return parseDate(s).getDay(); }
  function diffDays(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function toMin(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function fromMin(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function validTime(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t || ''); }

  /* ---------- การตั้งค่า ---------- */
  function intIn(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  function parseTitles(v) {
    var seen = {}, out = [];
    String(v).split(',').forEach(function (x) {
      x = x.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
      if (x && x.length <= 20 && x !== OTHER_TITLE && !seen[x] && out.length < 30) { seen[x] = 1; out.push(x); }
    });
    return out.length ? out : parseTitles(DEFAULTS.titles);
  }
  function parseCfg(raw) {
    var s = {}, k;
    for (k in DEFAULTS) s[k] = DEFAULTS[k];
    for (k in (raw || {})) if (raw[k] !== '' && raw[k] != null) s[k] = String(raw[k]);
    var days = function (v) { return String(v).split(',').map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }); };
    return {
      clinicName: s.clinicName, clinicPhone: s.clinicPhone, notice: s.notice,
      titles: parseTitles(s.titles),
      bookingWindowDays: intIn(s.bookingWindowDays, 7, 92, 60),
      minAdvanceDays: intIn(s.minAdvanceDays, 0, 30, 1),
      rescheduleMinDays: intIn(s.rescheduleMinDays, 0, 30, 1),
      retentionDays: intIn(s.retentionDays, 90, 1095, 365),
      patientKeyMode: s.patientKeyMode === 'phone' ? 'phone' : 'phone_name',
      amSlotMinutes: intIn(s.amSlotMinutes, 10, 120, 30),
      amSlots: String(s.amSlots).split(',').map(function (x) {
        var p = x.split('='); return { time: p[0].trim(), group: (p[1] || '').trim() };
      }).filter(function (x) { return validTime(x.time) && x.group; }),
      pmStart: s.pmStart, pmEnd: s.pmEnd,
      openDaysAM: days(s.openDaysAM), openDaysPM: days(s.openDaysPM),
      walkinStart: s.walkinStart, walkinEnd: s.walkinEnd
    };
  }

  function makeState(ctx) {
    var st = { ctx: ctx, _a: null, _cl: null };
    st.c = parseCfg(ctx.db.getSettings());
    st.now = ctx.now();
    st.appts = function () { if (!st._a) st._a = ctx.db.listAppointments(); return st._a; };
    st.closures = function () { if (!st._cl) st._cl = ctx.db.listClosures(); return st._cl; };
    st.dirty = function () { st._a = null; st._cl = null; };
    st.who = function () { return ctx.admin || 'ผู้ป่วย (ออนไลน์)'; };
    return st;
  }

  /* ---------- ตัวช่วยข้อมูล ---------- */
  function occupies(a) { return FREE.indexOf(a.status) < 0; }
  function isActive(a) { return ACTIVE.indexOf(a.status) >= 0; }
  function closureFor(st, date) {
    var l = st.closures();
    for (var i = 0; i < l.length; i++) if (l[i].date === date) return l[i];
    return null;
  }
  function treatmentOf(x, allowFree) {
    x = String(x || '').trim();
    var i;
    for (i = 0; i < TREATMENTS.length; i++) if (TREATMENTS[i].id === x || TREATMENTS[i].name === x) return { name: TREATMENTS[i].name, group: TREATMENTS[i].group };
    for (i = 0; i < ADMIN_TREATMENTS.length; i++) if (ADMIN_TREATMENTS[i].name === x) return { name: x, group: null, minutes: ADMIN_TREATMENTS[i].minutes };
    if (allowFree && x && x.length <= 80) return { name: x, group: null };
    fail('BAD_TREATMENT', 'กรุณาเลือกประเภทการรักษา');
  }
  function pub(a) {
    if (!a) return null;
    var o = {}, k;
    for (k in a) if (k !== 'pinHash') o[k] = a[k];
    return o;
  }
  function normPhone(v) { return String(v == null ? '' : v).replace(/[\s\-]/g, ''); }
  function nameKey(a) { return (String(a.firstName) + '|' + String(a.lastName)).toLowerCase().replace(/\s+/g, ''); }
  function patientKey(st, a) {
    return st.c.patientKeyMode === 'phone' ? normPhone(a.phone) : normPhone(a.phone) + '|' + nameKey(a);
  }
  function cleanText(v, label, max) {
    var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (!s) fail('BAD_' + label, 'กรุณากรอก' + (label === 'FIRST' ? 'ชื่อ' : 'นามสกุล'));
    if (s.length > max) fail('BAD_' + label, 'ข้อความยาวเกินไป');
    if (/[<>]/.test(s)) fail('BAD_' + label, 'ห้ามใช้สัญลักษณ์ < >');
    return s;
  }
  function cleanPatient(p) {
    var title = String(p.title == null ? '' : p.title).replace(/\s+/g, ' ').trim();
    if (!title || title === OTHER_TITLE) fail('BAD_TITLE', 'กรุณาเลือกหรือระบุคำนำหน้า');
    if (title.length > 20) fail('BAD_TITLE', 'คำนำหน้ายาวเกินไป (ไม่เกิน 20 ตัวอักษร)');
    if (/[<>]/.test(title)) fail('BAD_TITLE', 'ห้ามใช้สัญลักษณ์ < >');
    var age = parseInt(p.age, 10);
    if (isNaN(age) || age < 0 || age > 120 || String(p.age).trim() !== String(age)) fail('BAD_AGE', 'อายุไม่ถูกต้อง (0–120 ปี)');
    var phone = normPhone(p.phone);
    if (!/^\d{10}$/.test(phone)) fail('BAD_PHONE', 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก');
    var rights = String(p.rights || '').trim();
    if (RIGHTS.indexOf(rights) < 0) fail('BAD_RIGHTS', 'กรุณาเลือกสิทธิการรักษา');
    return {
      title: title, firstName: cleanText(p.firstName, 'FIRST', 60), lastName: cleanText(p.lastName, 'LAST', 60),
      age: age, phone: phone, rights: rights
    };
  }
  function cleanNote(v) { return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, 300); }

  function nextApptNo(st, date) {
    var prefix = 'D' + date.slice(8, 10) + date.slice(5, 7) + date.slice(2, 4) + '-';
    var max = 0;
    st.appts().forEach(function (a) {
      if (String(a.apptNo).indexOf(prefix) === 0) {
        var n = parseInt(String(a.apptNo).slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + ('00' + (max + 1)).slice(-3);
  }

  function audit(st, action, apptNo, detail) {
    st.ctx.db.addAudit({ time: st.now.stamp, admin: st.who(), action: action, apptNo: apptNo || '', detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}) });
  }

  function guard(st, key) {
    if (st.ctx.throttle && st.ctx.throttle.blocked(key)) fail('TOO_MANY', 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีหรือติดต่อเจ้าหน้าที่');
  }

  /* ---------- ตรวจเงื่อนไขช่วงเวลา ---------- */
  function amTimesFree(st, date, group, excludeNo) {
    return st.c.amSlots.filter(function (s) {
      return s.group === group && !amOccupied(st, date, s.time, excludeNo);
    }).map(function (s) { return s.time; });
  }
  function amOccupied(st, date, time, excludeNo) {
    return st.appts().some(function (a) {
      return a.date === date && a.session === 'AM' && a.time === time && occupies(a) && a.apptNo !== excludeNo;
    });
  }
  function inWindow(st, date) {
    var diff = diffDays(st.now.date, date);
    return diff >= st.c.minAdvanceDays && diff <= st.c.bookingWindowDays;
  }

  /* spec: {date,time,session,treatment:{group},durationMin}  opt: {admin, excludeNo} */
  function validateSlot(st, spec, opt) {
    var c = st.c, date = spec.date, time = spec.time, session = spec.session;
    if (!parseDate(date)) fail('BAD_DATE', 'วันที่ไม่ถูกต้อง');
    if (!validTime(time)) fail('BAD_TIME', 'เวลาไม่ถูกต้อง');
    var d = dow(date), i;

    if (session === 'AM') {
      if (c.openDaysAM.indexOf(d) < 0) fail('NOT_OPEN', 'วันดังกล่าวไม่เปิดให้บริการ');
      if (closureFor(st, date)) fail('CLOSED', 'วันดังกล่าวปิดให้บริการ');
      var slot = null;
      for (i = 0; i < c.amSlots.length; i++) if (c.amSlots[i].time === time) slot = c.amSlots[i];
      if (!slot) fail('BAD_TIME', 'เวลานี้ไม่เปิดรับจอง');
      if (!spec.treatment.group || spec.treatment.group !== slot.group)
        fail('TREATMENT_MISMATCH', 'เวลา ' + time + ' น. ไม่เปิดรับการรักษาประเภทนี้ กรุณาเลือกเวลาที่ตรงกับประเภทการรักษา');
      if (!opt.admin) {
        if (!inWindow(st, date)) fail('OUT_OF_WINDOW', 'วันดังกล่าวยังไม่เปิดให้จองออนไลน์');
        if (date === st.now.date && time <= st.now.time) fail('PAST', 'เวลานี้ผ่านไปแล้ว');
      }
      if (amOccupied(st, date, time, opt.excludeNo)) fail('SLOT_TAKEN', 'คิวนี้ถูกจองแล้ว กรุณาเลือกเวลาอื่น');
      return { session: 'AM', date: date, time: time, endTime: fromMin(toMin(time) + c.amSlotMinutes), durationMin: c.amSlotMinutes };
    }

    if (session === 'PM') {
      if (!opt.admin) fail('FORBIDDEN', 'ผู้ป่วยไม่สามารถจองช่วงบ่ายด้วยตนเองได้');
      if (c.openDaysPM.indexOf(d) < 0) fail('NOT_OPEN', 'วันดังกล่าวไม่มีนัดช่วงบ่าย');
      if (closureFor(st, date)) fail('CLOSED', 'วันดังกล่าวปิดให้บริการ');
      var dur = parseInt(spec.durationMin, 10);
      if (isNaN(dur) || dur < 15 || dur > 120) fail('BAD_DURATION', 'ระยะเวลาต้องอยู่ระหว่าง 15–120 นาที');
      var s = toMin(time), e = s + dur;
      if (s < toMin(c.pmStart) || e > toMin(c.pmEnd)) fail('OUT_OF_HOURS', 'ต้องอยู่ในช่วง ' + c.pmStart + '–' + c.pmEnd + ' น.');
      var hit = st.appts().filter(function (a) {
        return a.date === date && a.session === 'PM' && occupies(a) && a.apptNo !== opt.excludeNo &&
          toMin(a.time) < e && toMin(a.endTime) > s;
      });
      if (hit.length) fail('OVERLAP', 'เวลาทับซ้อนกับนัด ' + hit[0].time + '–' + hit[0].endTime + ' น.', { apptNo: hit[0].apptNo });
      return { session: 'PM', date: date, time: time, endTime: fromMin(e), durationMin: dur };
    }

    if (session === 'WALKIN') {
      if (!opt.admin) fail('FORBIDDEN', 'ไม่อนุญาต');
      if (c.openDaysAM.indexOf(d) < 0) fail('NOT_OPEN', 'วันดังกล่าวไม่เปิดให้บริการ');
      if (time < c.walkinStart || time >= c.walkinEnd) fail('BAD_TIME', 'Walk-in ต้องอยู่ในช่วง ' + c.walkinStart + '–' + c.walkinEnd + ' น.');
      return { session: 'WALKIN', date: date, time: time, endTime: '', durationMin: 0 };
    }
    fail('BAD_SESSION', 'ประเภทนัดไม่ถูกต้อง');
  }

  function assertNoActive(st, patient, excludeNo) {
    var key = patientKey(st, patient);
    var hit = st.appts().filter(function (a) {
      return a.session !== 'WALKIN' && isActive(a) && a.apptNo !== excludeNo && patientKey(st, a) === key;
    })[0];
    if (hit) {
      fail('ACTIVE_EXISTS',
        st.ctx.admin
          ? 'ผู้ป่วยรายนี้มีนัดที่ยังใช้งานอยู่ (' + hit.apptNo + ' วันที่ ' + hit.date + ' ' + hit.time + ') ต้องเปลี่ยนสถานะหรือเลื่อนนัดเดิมก่อน'
          : 'ท่านมีนัดหมายที่ยังไม่สิ้นสุดอยู่ในระบบ หากต้องการเปลี่ยนวัน กรุณาใช้เมนู "เลื่อนนัด" หรือติดต่อเจ้าหน้าที่',
        st.ctx.admin ? { apptNo: hit.apptNo } : null);
    }
  }

  function createRecord(st, patient, tr, slot, source, extra) {
    extra = extra || {};
    var pin = st.ctx.randomPin();
    var no = nextApptNo(st, slot.date);
    var rec = {
      apptNo: no, createdAt: st.now.stamp, date: slot.date, time: slot.time, endTime: slot.endTime,
      session: slot.session, durationMin: slot.durationMin,
      title: patient.title, firstName: patient.firstName, lastName: patient.lastName, age: patient.age, phone: patient.phone,
      treatment: tr.name, rights: patient.rights, status: extra.status || 'waiting', source: source,
      adminOnly: slot.session === 'PM' ? 'Y' : '', pinHash: st.ctx.hash(no + ':' + pin),
      note: cleanNote(extra.note), rescheduledFrom: extra.from || '', rescheduledTo: '',
      updatedAt: st.now.stamp, updatedBy: st.who()
    };
    st.ctx.db.addAppointment(rec);
    st.dirty();
    return { rec: rec, pin: pin };
  }

  function findByNo(st, no) {
    no = String(no || '').trim().toUpperCase();
    var l = st.appts();
    for (var i = 0; i < l.length; i++) if (String(l[i].apptNo).toUpperCase() === no) return l[i];
    return null;
  }
  function getOrFail(st, no) {
    var a = findByNo(st, no);
    if (!a) fail('NOT_FOUND', 'ไม่พบนัดหมาย');
    return a;
  }

  function verifyOwner(st, p) {
    var no = String(p.apptNo || '').trim().toUpperCase();
    guard(st, 'lk:' + no);
    var a = findByNo(st, no);
    var ok = a && normPhone(a.phone) === normPhone(p.phone) &&
      String(p.pin || '').length > 0 && st.ctx.hash(a.apptNo + ':' + String(p.pin).trim()) === a.pinHash;
    if (!ok) {
      if (st.ctx.throttle) st.ctx.throttle.fail('lk:' + no);
      fail('NOT_FOUND', 'ข้อมูลไม่ตรงกับนัดหมายในระบบ กรุณาตรวจสอบเลขที่นัด เบอร์โทร และรหัสยืนยัน');
    }
    if (st.ctx.throttle) st.ctx.throttle.reset('lk:' + no);
    return a;
  }

  function diffFields(before, after) {
    var o = {};
    for (var k in after) if (String(before[k]) !== String(after[k])) o[k] = [before[k], after[k]];
    return o;
  }

  /* =====================================================================
   * ACTIONS
   * ===================================================================== */
  var A = {}, ADMIN = {};

  /* ---------- สาธารณะ ---------- */
  A.getConfig = function (st) {
    var c = st.c, t = st.now.date;
    return {
      clinicName: c.clinicName, clinicPhone: c.clinicPhone, notice: c.notice,
      today: t, minDate: addDays(t, c.minAdvanceDays), maxDate: addDays(t, c.bookingWindowDays),
      treatments: TREATMENTS, rights: RIGHTS, titles: c.titles.concat(OTHER_TITLE), otherTitle: OTHER_TITLE,
      amSlots: c.amSlots, amStart: '09:00', amEnd: '11:30',
      openDaysAM: c.openDaysAM, rescheduleMinDays: c.rescheduleMinDays
    };
  };

  A.availability = function (st, p) {
    var m = /^(\d{4})-(\d{2})$/.exec(p.month || '');
    if (!m) fail('BAD_DATE', 'เดือนไม่ถูกต้อง');
    var tr = treatmentOf(p.treatment);
    var first = m[1] + '-' + m[2] + '-01', days = [];
    var d = parseDate(first), mo = d.getMonth();
    while (d.getMonth() === mo) {
      var ds = fmtDate(d);
      if (c_open(st, ds)) {
        if (closureFor(st, ds)) days.push({ date: ds, state: 'closed', remaining: 0 });
        else {
          var n = amTimesFree(st, ds, tr.group, null).length;
          days.push({ date: ds, state: n > 0 ? 'open' : 'full', remaining: n });
        }
      }
      d.setDate(d.getDate() + 1);
    }
    return { month: p.month, days: days };
  };
  function c_open(st, ds) {
    return st.c.openDaysAM.indexOf(dow(ds)) >= 0 && inWindow(st, ds);
  }

  A.slots = function (st, p) {
    var tr = treatmentOf(p.treatment);
    if (!parseDate(p.date)) fail('BAD_DATE', 'วันที่ไม่ถูกต้อง');
    if (!c_open(st, p.date) || closureFor(st, p.date)) return { date: p.date, times: [], state: closureFor(st, p.date) ? 'closed' : 'off' };
    var times = amTimesFree(st, p.date, tr.group, p.excludeNo ? String(p.excludeNo).trim().toUpperCase() : null)
      .filter(function (t) { return !(p.date === st.now.date && t <= st.now.time); });
    return { date: p.date, times: times, state: times.length ? 'open' : 'full' };
  };

  A.book = function (st, p) {
    var patient = cleanPatient(p);
    if (!p.consent) fail('NO_CONSENT', 'กรุณากดยอมรับการเก็บข้อมูลเพื่อการนัดหมาย');
    var tr = treatmentOf(p.treatment);
    assertNoActive(st, patient, null);
    var slot = validateSlot(st, { date: p.date, time: p.time, session: 'AM', treatment: tr }, { admin: false });
    var r = createRecord(st, patient, tr, slot, 'online');
    audit(st, 'create', r.rec.apptNo, { source: 'online', date: slot.date, time: slot.time, treatment: tr.name });
    return { appt: pub(r.rec), pin: r.pin };
  };

  A.lookup = function (st, p) {
    var a = verifyOwner(st, p);
    var canResched = a.status === 'waiting' && a.session === 'AM' && a.adminOnly !== 'Y' &&
      diffDays(st.now.date, a.date) >= st.c.rescheduleMinDays;
    var reason = '';
    if (a.status !== 'waiting') reason = a.status === 'treating' ? 'อยู่ระหว่างการรักษา' : 'นัดนี้สิ้นสุดแล้ว';
    else if (a.session !== 'AM' || a.adminOnly === 'Y') reason = 'นัดนี้กำหนดโดยทันตแพทย์/เจ้าหน้าที่ กรุณาติดต่อเจ้าหน้าที่เพื่อเลื่อนนัด';
    else if (!canResched) reason = 'ใกล้ถึงวันนัดแล้ว กรุณาติดต่อเจ้าหน้าที่เพื่อเลื่อนนัด';
    var hasActive = st.appts().some(function (x) { return x.session !== 'WALKIN' && isActive(x) && patientKey(st, x) === patientKey(st, a); });
    return { appt: pub(a), canReschedule: canResched, reason: reason, canBookNext: a.status === 'done' && !hasActive };
  };

  A.reschedule = function (st, p) {
    var old = verifyOwner(st, p);
    if (old.status !== 'waiting') fail('NOT_ACTIVE', 'นัดนี้ไม่สามารถเลื่อนได้ (สถานะปัจจุบันไม่ใช่ "รอรับบริการ")');
    if (old.session !== 'AM' || old.adminOnly === 'Y') fail('ADMIN_ONLY', 'นัดนี้ต้องให้เจ้าหน้าที่เป็นผู้เลื่อนนัด');
    if (diffDays(st.now.date, old.date) < st.c.rescheduleMinDays) fail('TOO_LATE', 'ใกล้ถึงวันนัดแล้ว กรุณาติดต่อเจ้าหน้าที่');
    if (p.date === old.date && p.time === old.time) fail('SAME_SLOT', 'กรุณาเลือกวันหรือเวลาใหม่ที่แตกต่างจากเดิม');
    var tr = treatmentOf(old.treatment);
    // 1) ต้องจองใหม่ให้สำเร็จก่อน (นัดเดิมไม่ถูกแตะต้องจนกว่าจะผ่านทุกเงื่อนไข)
    var slot = validateSlot(st, { date: p.date, time: p.time, session: 'AM', treatment: tr }, { admin: false, excludeNo: old.apptNo });
    var r = createRecord(st, old, tr, slot, 'online', { from: old.apptNo });
    // 2) แล้วจึงยกเลิกนัดเดิม (ถ้าล้มเหลวให้ย้อนกลับนัดใหม่)
    try {
      st.ctx.db.updateAppointment(old.apptNo, {
        status: 'cancelled', rescheduledTo: r.rec.apptNo, updatedAt: st.now.stamp, updatedBy: st.who(),
        note: (old.note ? old.note + ' | ' : '') + 'เลื่อนไปนัด ' + r.rec.apptNo
      });
    } catch (e) {
      st.ctx.db.deleteAppointment(r.rec.apptNo);
      throw e;
    }
    st.dirty();
    audit(st, 'reschedule', old.apptNo, { from: old.date + ' ' + old.time, to: r.rec.date + ' ' + r.rec.time, newApptNo: r.rec.apptNo });
    return { appt: pub(r.rec), pin: r.pin, previous: pub(findByNo(st, old.apptNo)) };
  };

  /* ---------- Admin ---------- */
  ADMIN.adminSchedule = function (st, p) {
    var date = p.date || st.now.date;
    if (!parseDate(date)) fail('BAD_DATE', 'วันที่ไม่ถูกต้อง');
    var c = st.c, d = dow(date);
    var list = st.appts().filter(function (a) { return a.date === date; })
      .sort(function (a, b) { return (a.time + a.apptNo) < (b.time + b.apptNo) ? -1 : 1; });
    var stale = st.appts().filter(function (a) { return a.session !== 'WALKIN' && isActive(a) && a.date < st.now.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; }).slice(0, 30);
    var counts = { waiting: 0, treating: 0, done: 0, cancelled: 0, noshow: 0 };
    list.forEach(function (a) { counts[a.status]++; });
    return {
      date: date, dow: d, today: st.now.date,
      closure: closureFor(st, date),
      openAM: c.openDaysAM.indexOf(d) >= 0, openPM: c.openDaysPM.indexOf(d) >= 0,
      slots: c.amSlots, pmStart: c.pmStart, pmEnd: c.pmEnd, walkinStart: c.walkinStart, walkinEnd: c.walkinEnd,
      appts: list.map(pub), counts: counts, stale: stale.map(pub)
    };
  };

  ADMIN.adminOptions = function (st) {
    return { treatments: TREATMENTS, adminTreatments: ADMIN_TREATMENTS, rights: RIGHTS, titles: st.c.titles.concat(OTHER_TITLE), otherTitle: OTHER_TITLE, statuses: STATUSES,
      amSlots: st.c.amSlots, pmStart: st.c.pmStart, pmEnd: st.c.pmEnd, today: st.now.date, clinicName: st.c.clinicName };
  };

  ADMIN.adminCreate = function (st, p) {
    var session = p.session;
    var patient = cleanPatient(p);
    var tr = treatmentOf(p.treatment, session !== 'AM');
    if (session === 'AM' && !tr.group) fail('BAD_TREATMENT', 'ช่วงเช้ารองรับเฉพาะ อุดฟัน / ขูดหินปูน / ถอนฟัน');
    var dur = p.durationMin;
    if (session === 'PM' && !dur) dur = tr.minutes || 30;
    if (session !== 'WALKIN') assertNoActive(st, patient, null);
    var slot = validateSlot(st, { date: p.date, time: p.time || (session === 'WALKIN' ? st.c.walkinStart : ''), session: session, treatment: tr, durationMin: dur }, { admin: true });
    var status = (session === 'WALKIN' && STATUSES.indexOf(p.status) >= 0) ? p.status : 'waiting';
    var r = createRecord(st, patient, tr, slot, session === 'WALKIN' ? 'walkin' : 'admin', { note: p.note, status: status });
    audit(st, 'create', r.rec.apptNo, { source: r.rec.source, session: session, date: slot.date, time: slot.time, treatment: tr.name });
    return { appt: pub(r.rec), pin: r.pin };
  };

  ADMIN.adminUpdate = function (st, p) {
    var a = getOrFail(st, p.apptNo);
    var patient = cleanPatient({
      title: p.title, firstName: p.firstName, lastName: p.lastName, age: p.age, phone: p.phone, rights: p.rights
    });
    var tr = treatmentOf(p.treatment, a.session !== 'AM');
    if (a.session === 'AM' && occupies(a)) {
      var slot = null;
      st.c.amSlots.forEach(function (s) { if (s.time === a.time) slot = s; });
      if (!tr.group || !slot || tr.group !== slot.group) fail('TREATMENT_MISMATCH', 'ประเภทการรักษาไม่ตรงกับเวลาที่นัดไว้ — ให้ใช้ "เปลี่ยนวัน/เวลา" ร่วมด้วย');
    }
    var patch = {
      title: patient.title, firstName: patient.firstName, lastName: patient.lastName, age: patient.age, phone: patient.phone,
      rights: patient.rights, treatment: tr.name, note: cleanNote(p.note), updatedAt: st.now.stamp, updatedBy: st.who()
    };
    var changes = diffFields(a, patch);
    delete changes.updatedAt; delete changes.updatedBy;
    if (!Object.keys(changes).length) return { appt: pub(a), unchanged: true };
    st.ctx.db.updateAppointment(a.apptNo, patch);
    st.dirty();
    audit(st, 'edit', a.apptNo, changes);
    return { appt: pub(findByNo(st, a.apptNo)) };
  };

  ADMIN.adminMove = function (st, p) {
    var a = getOrFail(st, p.apptNo);
    if (!isActive(a)) fail('NOT_ACTIVE', 'เลื่อนได้เฉพาะนัดที่ยังใช้งานอยู่ (รอรับบริการ / กำลังรักษา)');
    var tr = treatmentOf(a.treatment, a.session !== 'AM');
    var dur = a.session === 'PM' ? (p.durationMin || a.durationMin) : a.durationMin;
    var slot = validateSlot(st, { date: p.date, time: p.time, session: a.session, treatment: tr, durationMin: dur }, { admin: true, excludeNo: a.apptNo });
    if (slot.date === a.date && slot.time === a.time && slot.durationMin === a.durationMin) fail('SAME_SLOT', 'วันเวลาเหมือนเดิม');
    var patch = { date: slot.date, time: slot.time, endTime: slot.endTime, durationMin: slot.durationMin, updatedAt: st.now.stamp, updatedBy: st.who() };
    var before = { date: a.date, time: a.time, durationMin: a.durationMin };
    st.ctx.db.updateAppointment(a.apptNo, patch);
    st.dirty();
    audit(st, 'move', a.apptNo, { from: before.date + ' ' + before.time, to: slot.date + ' ' + slot.time, durationMin: slot.durationMin });
    return { appt: pub(findByNo(st, a.apptNo)) };
  };

  ADMIN.adminSetStatus = function (st, p) {
    var a = getOrFail(st, p.apptNo);
    var ns = p.status;
    if (STATUSES.indexOf(ns) < 0) fail('BAD_STATUS', 'สถานะไม่ถูกต้อง');
    if (ns === a.status) return { appt: pub(a), unchanged: true };
    // ฟื้นนัดที่ยกเลิก/ไม่มา กลับมาใช้งาน ต้องตรวจคิวและนัดซ้ำอีกครั้ง
    if (FREE.indexOf(a.status) >= 0 && FREE.indexOf(ns) < 0) {
      if (a.session !== 'WALKIN') {
        assertNoActive(st, a, a.apptNo);
        var tr = treatmentOf(a.treatment, a.session !== 'AM');
        validateSlot(st, { date: a.date, time: a.time, session: a.session, treatment: tr, durationMin: a.durationMin }, { admin: true, excludeNo: a.apptNo });
      }
    }
    var note = a.note;
    if (p.reason && FREE.indexOf(ns) >= 0) note = (note ? note + ' | ' : '') + (ns === 'cancelled' ? 'ยกเลิก: ' : 'ไม่มาตามนัด: ') + cleanNote(p.reason).slice(0, 120);
    st.ctx.db.updateAppointment(a.apptNo, { status: ns, note: note, updatedAt: st.now.stamp, updatedBy: st.who() });
    st.dirty();
    audit(st, 'status', a.apptNo, { from: a.status, to: ns, reason: p.reason || '' });
    return { appt: pub(findByNo(st, a.apptNo)) };
  };

  ADMIN.adminSearch = function (st, p) {
    var q = String(p.q || '').trim().toLowerCase().replace(/[\-\s]+/g, ' ');
    if (q.length < 2) return { patients: [] };
    var digits = q.replace(/\D/g, '');
    var map = {}, order = [];
    st.appts().forEach(function (a) {
      var hit = false;
      if (digits.length >= 3 && /^\d[\d ]*$/.test(q)) hit = normPhone(a.phone).indexOf(digits) >= 0;
      else {
        var full = (a.firstName + ' ' + a.lastName).toLowerCase();
        hit = q.split(' ').every(function (t) { return full.indexOf(t) >= 0; });
      }
      if (!hit) return;
      var k = normPhone(a.phone) + '|' + nameKey(a);
      if (!map[k]) { map[k] = { title: a.title, firstName: a.firstName, lastName: a.lastName, phone: a.phone, age: a.age, total: 0, done: 0, noshow: 0, cancelled: 0, last: '', active: '' }; order.push(k); }
      var o = map[k];
      o.total++;
      if (a.status === 'done') o.done++;
      if (a.status === 'noshow') o.noshow++;
      if (a.status === 'cancelled') o.cancelled++;
      if (a.date > o.last) { o.last = a.date; o.age = a.age; }
      if (isActive(a) && a.session !== 'WALKIN') o.active = a.apptNo;
    });
    return { patients: order.map(function (k) { return map[k]; }).sort(function (a, b) { return a.last < b.last ? 1 : -1; }).slice(0, 50) };
  };

  ADMIN.adminHistory = function (st, p) {
    var phone = normPhone(p.phone), nk = (String(p.firstName) + '|' + String(p.lastName)).toLowerCase().replace(/\s+/g, '');
    var list = st.appts().filter(function (a) { return normPhone(a.phone) === phone && nameKey(a) === nk; })
      .sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? 1 : -1; });
    var nos = {};
    list.forEach(function (a) { nos[a.apptNo] = 1; });
    var logs = st.ctx.db.listAudit(800, null).filter(function (e) { return nos[e.apptNo]; });
    return { appts: list.map(pub), audit: logs };
  };

  ADMIN.adminClosures = function (st) {
    var t = st.now.date;
    return { closures: st.closures().filter(function (c) { return c.date >= addDays(t, -7); }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }), today: t };
  };

  ADMIN.adminAddClosure = function (st, p) {
    var from = p.from, to = p.to || p.from;
    if (!parseDate(from) || !parseDate(to)) fail('BAD_DATE', 'วันที่ไม่ถูกต้อง');
    if (to < from) fail('BAD_DATE', 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม');
    if (diffDays(from, to) > 62) fail('BAD_DATE', 'ปิดได้ครั้งละไม่เกิน 62 วัน');
    var reason = cleanNote(p.reason).slice(0, 120);
    if (!reason) fail('BAD_REASON', 'กรุณาระบุเหตุผล เช่น วันหยุดราชการ / ประชุม / อบรม');
    var dates = [], d = from;
    while (d <= to) { if (!closureFor(st, d)) dates.push(d); d = addDays(d, 1); }
    if (!dates.length) fail('ALREADY', 'วันดังกล่าวถูกปิดไว้แล้ว');
    var set = {}; dates.forEach(function (x) { set[x] = 1; });
    var affected = st.appts().filter(function (a) { return set[a.date] && a.session !== 'WALKIN' && isActive(a); })
      .sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; }).map(pub);
    if (affected.length && !p.confirm) return { needConfirm: true, affected: affected, dates: dates };
    st.ctx.db.addClosures(dates.map(function (x) { return { date: x, reason: reason, createdBy: st.who(), createdAt: st.now.stamp }; }));
    st.dirty();
    audit(st, 'closure_add', '', { dates: dates.length > 3 ? dates[0] + ' … ' + dates[dates.length - 1] : dates.join(','), reason: reason, affected: affected.length });
    // ห้ามยกเลิกนัดเดิมอัตโนมัติ — คืนรายชื่อให้เจ้าหน้าที่ติดต่อเอง
    return { added: dates.length, affected: affected };
  };

  ADMIN.adminRemoveClosure = function (st, p) {
    if (!closureFor(st, p.date)) fail('NOT_FOUND', 'ไม่พบวันปิดดังกล่าว');
    st.ctx.db.removeClosure(p.date);
    st.dirty();
    audit(st, 'closure_remove', '', { date: p.date });
    return { removed: p.date };
  };

  var SETTING_KEYS = {
    clinicName: [1, 80], clinicPhone: [0, 40], notice: [0, 200], titles: [1, 400],
    bookingWindowDays: 'n', minAdvanceDays: 'n', rescheduleMinDays: 'n', retentionDays: 'n', patientKeyMode: 'k'
  };
  ADMIN.adminGetSettings = function (st) {
    var c = st.c, o = {};
    Object.keys(SETTING_KEYS).forEach(function (k) { o[k] = c[k]; });
    o.titles = c.titles.join(', ');
    return { settings: o };
  };
  ADMIN.adminSaveSettings = function (st, p) {
    var out = {};
    Object.keys(SETTING_KEYS).forEach(function (k) {
      if (p[k] === undefined) return;
      var rule = SETTING_KEYS[k], v = p[k];
      if (rule === 'n') {
        var n = parseInt(v, 10);
        if (isNaN(n)) fail('BAD_SETTING', 'ค่าตัวเลขไม่ถูกต้อง: ' + k);
        out[k] = String(n);
      } else if (rule === 'k') {
        out[k] = v === 'phone' ? 'phone' : 'phone_name';
      } else {
        v = String(v).replace(/[<>]/g, '').trim();
        if (v.length < rule[0] || v.length > rule[1]) fail('BAD_SETTING', 'ข้อความไม่ถูกต้อง: ' + k);
        out[k] = v;
      }
    });
    // clamp ผ่าน parseCfg เพื่อให้ค่าที่บันทึกอยู่ในช่วงที่ระบบรองรับ
    var chk = parseCfg(out);
    ['bookingWindowDays', 'minAdvanceDays', 'rescheduleMinDays', 'retentionDays'].forEach(function (k) { if (out[k] !== undefined) out[k] = String(chk[k]); });
    st.ctx.db.saveSettings(out);
    audit(st, 'settings', '', out);
    return { saved: out };
  };

  ADMIN.adminAudit = function (st, p) {
    return { logs: st.ctx.db.listAudit(Math.min(parseInt(p.limit, 10) || 200, 500), null) };
  };

  /* ---------- ตัวเรียกหลัก ---------- */
  var WRITE = { book: 1, reschedule: 1, adminCreate: 1, adminUpdate: 1, adminMove: 1, adminSetStatus: 1, adminAddClosure: 1, adminRemoveClosure: 1, adminSaveSettings: 1 };

  function handle(action, params, ctx) {
    try {
      var st = makeState(ctx);
      var fn = A[action] || ADMIN[action];
      if (!fn) fail('BAD_ACTION', 'ไม่รู้จักคำสั่ง');
      if (ADMIN[action] && !ctx.admin) fail('AUTH', 'กรุณาเข้าสู่ระบบ');
      return { ok: true, data: fn(st, params || {}) };
    } catch (e) {
      if (e && e.__engine) return { ok: false, code: e.code, message: e.message, data: e.extra || null };
      throw e;
    }
  }

  var api = {
    handle: handle,
    isWrite: function (a) { return !!WRITE[a]; },
    isAdminAction: function (a) { return !!ADMIN[a]; },
    isKnown: function (a) { return !!(A[a] || ADMIN[a]); },
    DEFAULTS: DEFAULTS, TREATMENTS: TREATMENTS, RIGHTS: RIGHTS, OTHER_TITLE: OTHER_TITLE, STATUSES: STATUSES,
    util: { parseDate: parseDate, fmtDate: fmtDate, addDays: addDays, dow: dow, normPhone: normPhone, pad: pad }
  };
  return api;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
