/* =====================================================================
 * api.js — ตัวเชื่อม API + เครื่องมือกลางของหน้าเว็บ
 * - มี API_URL  → เรียก Google Apps Script จริง
 * - ไม่มี       → โหมดสาธิต ใช้ engine.js เดียวกับ backend + localStorage
 * ===================================================================== */
(function () {
  var CFG = window.DQ_CONFIG || {};
  var DEMO = !CFG.API_URL;
  var TH_M = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var TH_MF = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  var TH_D = ['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
  var TH_DS = ['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'];
  var STATUS = {
    waiting:   { th: 'รอรับบริการ',  cls: 's-waiting' },
    treating:  { th: 'กำลังรักษา',   cls: 's-treating' },
    done:      { th: 'เสร็จสิ้น',    cls: 's-done' },
    cancelled: { th: 'ยกเลิก',       cls: 's-cancelled' },
    noshow:    { th: 'ไม่มาตามนัด',  cls: 's-noshow' }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function parse(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function thaiDate(s, o) {
    o = o || {}; var d = parse(s);
    var base = d.getDate() + ' ' + (o.full ? TH_MF : TH_M)[d.getMonth()] + (o.noYear ? '' : ' ' + (d.getFullYear() + 543));
    return o.noDay ? base : (o.shortDay ? TH_DS : TH_D)[d.getDay()] + ' ' + base;
  }
  function thaiMonth(ym) { var p = ym.split('-'); return TH_MF[+p[1] - 1] + ' ' + (+p[0] + 543); }
  function bkkNow() {
    var f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    var o = {}; f.formatToParts(new Date()).forEach(function (p) { o[p.type] = p.value; });
    var hh = o.hour === '24' ? '00' : o.hour;
    return { date: o.year + '-' + o.month + '-' + o.day, time: hh + ':' + o.minute, stamp: o.year + '-' + o.month + '-' + o.day + ' ' + hh + ':' + o.minute + ':' + o.second };
  }

  /* ---------------- โหมดสาธิต: ฐานข้อมูลจำลองใน localStorage ---------------- */
  var KEY = 'dq_demo_v1';
  var store = null;
  function load() {
    if (store) return store;
    try { store = JSON.parse(localStorage.getItem(KEY)); } catch (e) { store = null; }
    if (!store) { store = { settings: {}, appts: [], closures: [], audit: [] }; seed(); }
    return store;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }
  var fails = {};
  function demoCtx(admin) {
    var d = {
      getSettings: function () { return load().settings; },
      saveSettings: function (o) { Object.assign(load().settings, o); save(); },
      listAppointments: function () { return load().appts.map(function (a) { return Object.assign({}, a); }); },
      addAppointment: function (a) { load().appts.push(Object.assign({}, a)); save(); },
      updateAppointment: function (n, p) { Object.assign(load().appts.filter(function (a) { return a.apptNo === n; })[0], p); save(); },
      deleteAppointment: function (n) { store.appts = store.appts.filter(function (a) { return a.apptNo !== n; }); save(); },
      listClosures: function () { return load().closures.map(function (c) { return Object.assign({}, c); }); },
      addClosures: function (r) { load().closures.push.apply(store.closures, r); save(); },
      removeClosure: function (d) { store.closures = store.closures.filter(function (c) { return c.date !== d; }); save(); },
      addAudit: function (e) { load().audit.push(e); save(); },
      listAudit: function (n) { return load().audit.slice(-n).reverse(); }
    };
    return {
      db: d, admin: admin || null, now: bkkNow,
      hash: function (s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'd' + (h >>> 0).toString(36); },
      randomPin: function () { return ('000' + Math.floor(Math.random() * 10000)).slice(-4); },
      throttle: {
        blocked: function (k) { return (fails[k] || 0) >= 5; },
        fail: function (k) { fails[k] = (fails[k] || 0) + 1; },
        reset: function (k) { delete fails[k]; }
      }
    };
  }
  function seed() {
    try {
      var U = Engine.util, now = bkkNow(), ad = 'ระบบสาธิต', i;
      var names = [['นาย','สมชาย','ใจดี',45,'fill'],['นางสาว','พิมพ์ชนก','ศรีสุข',28,'scale'],['นาง','วิไล','รักษ์ไทย',61,'extract'],
                   ['เด็กชาย','ธนกฤต','มั่นคง',9,'fill'],['นาย','อนุชา','แสงทอง',37,'scale'],['นางสาว','กานดา','พึ่งบุญ',24,'extract'],
                   ['นาย','ประเสริฐ','วงศ์ไว',52,'fill'],['นาง','สุดา','เพชรงาม',49,'scale']];
      var n = 0, dates = [], d = U.addDays(now.date, 1);
      while (dates.length < 4) { if (U.dow(d) >= 1 && U.dow(d) <= 5) dates.push(d); d = U.addDays(d, 1); }
      var times = { fill: ['09:00', '09:30'], scale: ['10:00', '10:30', '11:00'], extract: ['10:30', '11:00', '10:00'] };
      var used = {};
      dates.forEach(function (dt, di) {
        for (i = 0; i < 2 + di; i++) {
          var p = names[n % names.length], tm = times[p[4]];
          var t = tm.filter(function (x) { return !used[dt + x]; })[0];
          if (!t) { n++; continue; }
          used[dt + t] = 1;
          var r = Engine.handle('adminCreate', { session: 'AM', title: p[0], firstName: p[1], lastName: p[2], age: p[3], phone: '08' + (10000000 + n * 1111111 % 89999999), rights: Engine.RIGHTS[n % 3], treatment: p[4], date: dt, time: t }, demoCtx(ad));
          n++;
        }
      });
      // นัดช่วงบ่าย + วันปิด
      var thu = dates.filter(function (x) { return U.dow(x) <= 4; })[0];
      Engine.handle('adminCreate', { session: 'PM', title: 'นาย', firstName: 'วีระ', lastName: 'ชัยชนะ', age: 33, phone: '0899000111', rights: Engine.RIGHTS[0], treatment: 'ผ่าฟันคุด', date: thu, time: '13:30' }, demoCtx(ad));
      Engine.handle('adminCreate', { session: 'PM', title: 'นางสาว', firstName: 'มาลี', lastName: 'สุขสันต์', age: 26, phone: '0899000222', rights: Engine.RIGHTS[1], treatment: 'อุดฟันยาก / อุดฟันหน้า', date: thu, time: '15:00', durationMin: 30 }, demoCtx(ad));
      // ย้อนหลัง: วันทำการล่าสุด (เสร็จสิ้น / ไม่มา / Walk-in)
      var back = U.addDays(now.date, -1);
      while (U.dow(back) < 1 || U.dow(back) > 5) back = U.addDays(back, -1);
      var rows = [['นาย','อรรถพล','เจริญสุข',41,'fill','09:00','done'],['นาง','รัชนี','ทองดี',55,'scale','10:00','noshow'],['นางสาว','ปวีณา','ใจงาม',30,'extract','10:30','done']];
      rows.forEach(function (p, k) {
        var r = Engine.handle('adminCreate', { session: 'AM', title: p[0], firstName: p[1], lastName: p[2], age: p[3], phone: '0870000' + (100 + k), rights: Engine.RIGHTS[k % 3], treatment: p[4], date: back, time: p[5] }, demoCtx(ad));
        Engine.handle('adminSetStatus', { apptNo: r.data.appt.apptNo, status: p[6] }, demoCtx(ad));
      });
      Engine.handle('adminCreate', { session: 'WALKIN', title: 'นาย', firstName: 'สมศักดิ์', lastName: 'ปวดฟัน', age: 58, phone: '0860000999', rights: Engine.RIGHTS[2], treatment: 'ปวดฟันรุนแรง', date: back, time: '08:20', status: 'done' }, demoCtx(ad));
      var cl = dates[dates.length - 1];
      var cd = U.addDays(cl, 7); while (U.dow(cd) < 1 || U.dow(cd) > 5) cd = U.addDays(cd, 1);
      Engine.handle('adminAddClosure', { from: cd, reason: 'ประชุมวิชาการ', confirm: true }, demoCtx(ad));
    } catch (e) { console.warn('seed failed', e); }
    save();
  }
  var DEMO_ADMIN = { user: 'admin', pass: 'admin1234', name: 'เจ้าหน้าที่ (สาธิต)' };

  function demoCall(action, params) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var admin = null;
        if (action === 'adminLogin') {
          if (String(params.username).toLowerCase() === DEMO_ADMIN.user && params.password === DEMO_ADMIN.pass) return resolve({ ok: true, data: { token: 'demo-token', name: DEMO_ADMIN.name } });
          return resolve({ ok: false, code: 'AUTH', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }
        if (action === 'adminLogout') return resolve({ ok: true, data: {} });
        if (action === 'adminMe') return resolve(token() === 'demo-token' ? { ok: true, data: { name: DEMO_ADMIN.name } } : { ok: false, code: 'AUTH', message: 'กรุณาเข้าสู่ระบบ' });
        if (Engine.isAdminAction(action) && token() === 'demo-token') admin = DEMO_ADMIN.name;
        try { resolve(Engine.handle(action, params, demoCtx(admin))); }
        catch (e) { console.error(e); resolve({ ok: false, code: 'SERVER', message: 'เกิดข้อผิดพลาดในระบบ' }); }
      }, 220);
    });
  }

  /* ---------------- เรียก API ---------------- */
  function token() { try { return sessionStorage.getItem('dq_token') || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? sessionStorage.setItem('dq_token', t) : sessionStorage.removeItem('dq_token'); } catch (e) {} }

  function call(action, params, opt) {
    opt = opt || {};
    var req = { action: action, params: params || {}, token: token(), requestId: opt.requestId || undefined };
    var p;
    if (DEMO) p = demoCall(action, req.params);
    else {
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 30000);
      p = fetch(CFG.API_URL, {
        method: 'POST', redirect: 'follow', signal: ctl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // text/plain = ไม่ต้อง preflight CORS
        body: JSON.stringify(req)
      }).then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, code: 'NETWORK', message: 'เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่' }; })
        .then(function (x) { clearTimeout(t); return x; });
    }
    return p.then(function (res) {
      if (res.ok) return res.data;
      if (res.code === 'AUTH') { setToken(''); window.dispatchEvent(new Event('dq:auth')); }
      var err = new Error(res.message || 'เกิดข้อผิดพลาด'); err.code = res.code; err.data = res.data; throw err;
    });
  }

  /* ---------------- UI ช่วยเหลือ ---------------- */
  function toast(msg, kind) {
    var box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    var el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 300); }, kind === 'err' ? 5200 : 3200);
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.l = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>' + (label || 'กำลังดำเนินการ…'); }
    else { btn.disabled = false; if (btn.dataset.l) btn.innerHTML = btn.dataset.l; }
  }
  function statusPill(s) { var x = STATUS[s] || { th: s, cls: '' }; return '<span class="pill ' + x.cls + '">' + x.th + '</span>'; }
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  function demoBanner() {
    if (!DEMO) return;
    var b = document.createElement('div'); b.className = 'demo-banner';
    b.innerHTML = '<b>โหมดสาธิต</b> — ข้อมูลเก็บในเบราว์เซอร์นี้เท่านั้น ยังไม่เชื่อม Google Sheet <button type="button" id="demoReset">รีเซ็ตข้อมูลตัวอย่าง</button>';
    document.body.insertBefore(b, document.body.firstChild);
    b.querySelector('#demoReset').onclick = function () { localStorage.removeItem(KEY); location.reload(); };
  }


  var IC = {
    chevL: 'M15 18l-6-6 6-6', chevR: 'M9 18l6-6-6-6', check: 'M20 6L9 17l-5-5', x: 'M18 6L6 18M6 6l12 12',
    calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
    clock: 'M12 6v6l4 2M12 22a10 10 0 100-20 10 10 0 000 20z', phone: 'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.2a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z',
    search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3', user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
    users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
    lock: 'M5 11h14a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2zM7 11V7a5 5 0 0110 0v4', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
    move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20', plus: 'M12 5v14M5 12h14',
    download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3', print: 'M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z',
    alert: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01', info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
    history: 'M3 12a9 9 0 109-9 9.8 9.8 0 00-6.7 2.7L3 8M3 3v5h5M12 7v5l4 2', ban: 'M12 22a10 10 0 100-20 10 10 0 000 20zM4.9 4.9l14.2 14.2',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9', ticket: 'M3 9a3 3 0 000 6v3a1 1 0 001 1h16a1 1 0 001-1v-3a3 3 0 010-6V6a1 1 0 00-1-1H4a1 1 0 00-1 1z',
    tooth: 'M12 2.5c-2 0-3.2 1-5 1-2.2 0-3.5 1.7-3.5 4.2 0 2.2 1 3.7 1.6 6 .6 2.3.8 7.3 2.9 7.3 1.6 0 1.4-4.2 4-4.2s2.4 4.2 4 4.2c2.1 0 2.3-5 2.9-7.3.6-2.3 1.6-3.8 1.6-6 0-2.5-1.3-4.2-3.5-4.2-1.8 0-3-1-5-1z',
    sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    chart: 'M3 3v18h18M7 16v-4M12 16V8M17 16v-7',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', copy: 'M9 9h11a2 2 0 012 2v9a2 2 0 01-2 2H9a2 2 0 01-2-2v-9a2 2 0 012-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1'
  };
  function ic(name, sz) {
    return '<svg viewBox="0 0 24 24" width="' + (sz || 20) + '" height="' + (sz || 20) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + IC[name] + '"/></svg>';
  }

  window.DQ = {
    CFG: CFG, DEMO: DEMO, STATUS: STATUS, call: call, token: token, setToken: setToken, esc: esc, uuid: uuid,
    thaiDate: thaiDate, thaiMonth: thaiMonth, toast: toast, busy: busy, statusPill: statusPill, loadScript: loadScript,
    demoBanner: demoBanner, ic: ic, TH_D: TH_D, bkkNow: bkkNow, util: Engine.util
  };
})();
