const E = require('../engine.js'); const assert = require('assert');
function mk(todayStr='2026-11-08'){
  const S={settings:{},appts:[],closures:[],audit:[],admins:[{username:'admin',displayName:'แอดมิน',salt:'s',hash:'hs:Admin1234',active:'Y'}]}; const fails={};
  const db={getSettings:()=>S.settings,saveSettings:o=>Object.assign(S.settings,o),
    listAppointments:()=>S.appts.map(a=>({...a})),addAppointment:a=>S.appts.push({...a}),
    updateAppointment:(n,p)=>Object.assign(S.appts.find(a=>a.apptNo===n),p),
    deleteAppointment:n=>{S.appts=S.appts.filter(a=>a.apptNo!==n)},
    listClosures:()=>S.closures.map(c=>({...c})),addClosures:r=>S.closures.push(...r),removeClosure:d=>{S.closures=S.closures.filter(c=>c.date!==d)},
    addAudit:e=>S.audit.push(e),listAudit:()=>S.audit.slice().reverse()};
  const ctx=(admin,au)=>({db,admin:admin||null,adminUser:au||(admin?'admin':null),admins:{list:()=>S.admins.map(a=>({...a})),add:o=>S.admins.push({...o}),update:(u,p)=>Object.assign(S.admins.find(a=>a.username===u),p)},newSalt:()=>'salt',hashPw:(p,s)=>'h'+s+':'+p,now:()=>({date:todayStr,time:'10:00',stamp:todayStr+' 10:00:00'}),
    hash:s=>'h'+s,randomPin:()=>'1234',throttle:{blocked:k=>(fails[k]||0)>=5,fail:k=>fails[k]=(fails[k]||0)+1,reset:k=>delete fails[k]}});
  const call=(a,p,admin,au)=>E.handle(a,p,ctx(admin,au));
  return {S,call};
}
const P={title:'นาย',firstName:'สมชาย',lastName:'ใจดี',age:'35',phone:'081-234 5678',rights:E.RIGHTS[0],consent:true};
let {S,call}=mk();
// 2026-11-10 = อังคาร
let r=call('book',{...P,treatment:'fill',date:'2026-11-10',time:'09:00'}); assert(r.ok,JSON.stringify(r)); assert.equal(r.data.appt.apptNo,'D101126-001'); assert.equal(r.data.appt.phone,'0812345678');
assert.equal(call('book',{...P,firstName:'อื่น',treatment:'fill',date:'2026-11-10',time:'09:00'}).code,'SLOT_TAKEN');
assert.equal(call('book',{...P,treatment:'fill',date:'2026-11-11',time:'09:30'}).code,'ACTIVE_EXISTS');
const Q={...P,firstName:'สมหญิง',phone:'0899999999'};
assert.equal(call('book',{...Q,treatment:'fill',date:'2026-11-10',time:'10:00'}).code,'TREATMENT_MISMATCH');
assert.equal(call('book',{...Q,treatment:'scale',date:'2026-11-14',time:'10:00'}).code,'NOT_OPEN'); // เสาร์
assert.equal(call('book',{...Q,treatment:'scale',date:'2026-11-08',time:'10:00'}).code,'NOT_OPEN'); // อาทิตย์
assert.equal(call('book',{...Q,treatment:'scale',date:'2027-03-02',time:'10:00'}).code,'OUT_OF_WINDOW');
assert.equal(call('book',{...Q,phone:'123',treatment:'scale',date:'2026-11-10',time:'10:00'}).code,'BAD_PHONE');
assert.equal(call('book',{...Q,consent:false,treatment:'scale',date:'2026-11-10',time:'10:00'}).code,'NO_CONSENT');
// ทุกคิวเต็ม -> availability full
call('book',{...Q,treatment:'scale',date:'2026-11-10',time:'10:00'});
['10:30','11:00'].forEach((t,i)=>assert(call('book',{...P,firstName:'x'+i,phone:'09000000'+i+'0',treatment:'extract',date:'2026-11-10',time:t}).ok));
let av=call('availability',{month:'2026-11',treatment:'scale'}).data.days.find(d=>d.date==='2026-11-10'); assert.equal(av.state,'full');
av=call('availability',{month:'2026-11',treatment:'fill'}).data.days.find(d=>d.date==='2026-11-10'); assert.equal(av.state,'open'); assert.equal(av.remaining,1);
assert.deepEqual(call('slots',{date:'2026-11-10',treatment:'fill'}).data.times,['09:30']);
// เลื่อนนัด: ล้มเหลวต้องคงนัดเดิม
const no='D101126-001';
assert.equal(call('reschedule',{apptNo:no,phone:P.phone,pin:'9999',date:'2026-11-20',time:'09:00'}).code,'NOT_FOUND');
let bad=call('reschedule',{apptNo:no,phone:P.phone,pin:'1234',date:'2026-11-10',time:'10:00'}); assert(!bad.ok);
assert.equal(S.appts.find(a=>a.apptNo===no).status,'waiting');
let ok=call('reschedule',{apptNo:no,phone:P.phone,pin:'1234',date:'2026-11-20',time:'09:00'}); assert(ok.ok,JSON.stringify(ok));
assert.equal(S.appts.find(a=>a.apptNo===no).status,'cancelled'); assert.equal(ok.data.appt.rescheduledFrom,no);
assert.equal(S.appts.length,5+0); // เดิมไม่ถูกลบ
assert.equal(call('slots',{date:'2026-11-10',treatment:'fill'}).data.times.length,2); // คิวเดิมคืนแล้ว
// ล็อกหลังลองผิดหลายครั้ง
for(let i=0;i<5;i++) call('lookup',{apptNo:'D201126-001',phone:P.phone,pin:'0000'});
assert.equal(call('lookup',{apptNo:'D201126-001',phone:P.phone,pin:'1234'}).code,'TOO_MANY');
// admin
assert.equal(call('adminSchedule',{date:'2026-11-10'}).code,'AUTH');
const AD='เจ้าหน้าที่ A';
let pm=call('adminCreate',{...Q,firstName:'ผ่า',phone:'0877777777',session:'PM',treatment:'ผ่าฟันคุด',date:'2026-11-12',time:'13:30'},AD); assert(pm.ok,JSON.stringify(pm)); assert.equal(pm.data.appt.endTime,'15:00');
assert.equal(call('adminCreate',{...Q,firstName:'ทับ',phone:'0866666666',session:'PM',treatment:'อุดฟันยาก / อุดฟันหน้า',date:'2026-11-12',time:'14:30'},AD).code,'OVERLAP');
assert(call('adminCreate',{...Q,firstName:'พอดี',phone:'0866666666',session:'PM',treatment:'อุดฟันยาก / อุดฟันหน้า',date:'2026-11-12',time:'15:00'},AD).code==='OUT_OF_HOURS');
assert.equal(call('adminCreate',{...Q,firstName:'ศุกร์',phone:'0855555555',session:'PM',treatment:'ผ่าฟันคุด',date:'2026-11-13',time:'13:30'},AD).code,'NOT_OPEN');
assert.equal(call('book',{...P,treatment:'fill',session:'PM',date:'2026-11-12',time:'13:30'}).ok,false);
assert.equal(call('reschedule',{apptNo:pm.data.appt.apptNo,phone:'0877777777',pin:'1234',date:'2026-11-17',time:'09:00'}).code,'ADMIN_ONLY');
// walk-in ไม่กระทบคิว
let w=call('adminCreate',{...Q,firstName:'ฉุกเฉิน',phone:'0844444444',session:'WALKIN',treatment:'ปวดฟันรุนแรง',date:'2026-11-09',time:'08:15',status:'done'},AD); assert(w.ok,JSON.stringify(w));
assert.equal(call('adminCreate',{...Q,session:'WALKIN',treatment:'x',date:'2026-11-09',time:'09:30'},AD).code,'BAD_TIME');
// ปิดวัน: ต้อง confirm, ห้ามยกเลิกอัตโนมัติ
let cl=call('adminAddClosure',{from:'2026-11-20',reason:'ประชุม'},AD); assert(cl.data.needConfirm); assert.equal(cl.data.affected.length,1); assert.equal(S.closures.length,0);
cl=call('adminAddClosure',{from:'2026-11-20',reason:'ประชุม',confirm:true},AD); assert.equal(cl.data.added,1);
assert.equal(S.appts.find(a=>a.apptNo==='D201126-001').status,'waiting');
assert.equal(call('book',{...Q,phone:'0833333333',treatment:'fill',date:'2026-11-20',time:'09:30'}).code,'CLOSED');
assert.equal(call('availability',{month:'2026-11',treatment:'fill'}).data.days.find(d=>d.date==='2026-11-20').state,'closed');
// สถานะ: ไม่มาตามนัดแล้วจองใหม่ได้ทันที, ฟื้นสถานะซ้อนไม่ได้
assert(call('adminSetStatus',{apptNo:'D201126-001',status:'noshow',reason:'ติดต่อไม่ได้'},AD).ok);
let nb=call('book',{...P,treatment:'fill',date:'2026-11-24',time:'09:00'}); assert(nb.ok,JSON.stringify(nb));
assert.equal(call('adminSetStatus',{apptNo:'D201126-001',status:'waiting'},AD).code,'ACTIVE_EXISTS');
// ค้นหา/ประวัติ
assert.equal(call('adminSearch',{q:'081'},AD).data.patients.length,1);
assert(call('adminHistory',{phone:'0812345678',firstName:'สมชาย',lastName:'ใจดี'},AD).data.appts.length>=3);
// แก้ไข + ย้าย
assert(call('adminMove',{apptNo:nb.data.appt.apptNo,date:'2026-11-24',time:'09:30'},AD).ok);
assert.equal(call('adminUpdate',{...nb.data.appt,treatment:'ถอนฟัน'},AD).code,'TREATMENT_MISMATCH');
console.log('ALL PASS, audit entries:',S.audit.length);

// ---- คำนำหน้า: ตั้งค่าได้ + พิมพ์เองได้
{
  const {call}=mk(); const adm='ผู้ดูแล';
  let cfg=call('getConfig',{}).data; assert.equal(cfg.titles[cfg.titles.length-1],'อื่น ๆ'); assert.equal(cfg.titles.length,37); assert(cfg.titles.includes('ร.ท.หญิง')); assert(cfg.titles.includes('ร.ท.')&&cfg.titles.includes('น.อ.'));
  assert(call('adminSaveSettings',{titles:'นาย, นาง, ร.ท., ร.อ., ร.ท.'},adm).ok);
  cfg=call('getConfig',{}).data; assert.deepEqual(cfg.titles,['นาย','นาง','ร.ท.','ร.อ.','อื่น ๆ']); // ตัดซ้ำ + ต่อท้าย "อื่น ๆ"
  assert.equal(call('adminGetSettings',{},adm).data.settings.titles,'นาย, นาง, ร.ท., ร.อ.');
  const base={...P,treatment:'fill',date:'2026-11-10',time:'09:00'};
  let r=call('book',{...base,title:'ดร.'}); assert(r.ok,JSON.stringify(r)); assert.equal(r.data.appt.title,'ดร.'); // พิมพ์เอง
  assert.equal(call('book',{...base,phone:'0811111111',firstName:'ก',title:'อื่น ๆ'}).code,'BAD_TITLE');
  assert.equal(call('book',{...base,phone:'0811111112',firstName:'ข',title:'<b>'}).code,'BAD_TITLE');
  assert.equal(call('book',{...base,phone:'0811111113',firstName:'ค',title:'x'.repeat(21)}).code,'BAD_TITLE');
  assert.equal(call('book',{...base,phone:'0811111114',firstName:'ง',title:''}).code,'BAD_TITLE');
  assert.equal(call('adminSaveSettings',{titles:''},adm).ok,false); // ว่างไม่ได้
  console.log('TITLES PASS');
}

// ---- ผู้ป่วยยกเลิกนัดเอง
{
  const {S,call}=mk(); const P2={title:'นาย',firstName:'สมชาย',lastName:'ใจดี',age:'35',phone:'0812345678',rights:E.RIGHTS[0],consent:true};
  const b=call('book',{...P2,treatment:'fill',date:'2026-11-10',time:'09:00'}); assert(b.ok); const no=b.data.appt.apptNo, pin=b.data.pin;
  assert.equal(call('lookup',{apptNo:no,phone:'0812345678',pin}).data.canCancel,true);
  assert.equal(call('cancel',{apptNo:no,phone:'0812345678',pin:'9999'}).code,'NOT_FOUND');      // PIN ผิด
  assert.equal(call('cancel',{apptNo:no,phone:'0800000000',pin}).code,'NOT_FOUND');             // เบอร์ผิด
  const c=call('cancel',{apptNo:no,phone:'0812345678',pin}); assert(c.ok,JSON.stringify(c)); assert.equal(c.data.appt.status,'cancelled');
  assert.equal(S.appts.length,1); assert(S.appts[0].note.includes('ยกเลิกเอง'));                // ไม่ลบข้อมูล
  assert.equal(S.audit[S.audit.length-1].action,'cancel');
  assert(call('cancel',{apptNo:no,phone:'0812345678',pin}).data.already);                        // กดซ้ำไม่พัง
  assert(call('book',{...P2,firstName:'คนใหม่',treatment:'fill',date:'2026-11-10',time:'09:00'}).ok); // คืนคิวแล้วจองได้
  assert(call('book',{...P2,treatment:'fill',date:'2026-11-12',time:'09:00'}).ok);               // ผู้ป่วยเดิมจองใหม่ได้
  // ใกล้วันนัด (พรุ่งนี้ นับเป็น 0 วัน) ยกเลิกเองไม่ได้
  const m=mk('2026-11-10'); const b2=m.call('book',{...P2,treatment:'fill',date:'2026-11-11',time:'09:00'}); assert(b2.ok);
  const L=m.call('lookup',{apptNo:b2.data.appt.apptNo,phone:'0812345678',pin:b2.data.pin}).data;
  assert.equal(L.canCancel,true);
  const m2=mk('2026-11-11'); m2.S.appts.push(...m.S.appts); assert.equal(m2.call('cancel',{apptNo:b2.data.appt.apptNo,phone:'0812345678',pin:b2.data.pin}).code,'TOO_LATE');
  console.log('CANCEL PASS');
}

// ---- สรุปรายวัน / รายงานรายเดือน
{
  const {S,call}=mk('2026-11-20'); const adm='ผู้ดูแล';
  const mkP=(n,ph)=>({title:'นาย',firstName:n,lastName:'ทดสอบ',age:'30',phone:ph,rights:E.RIGHTS[0],consent:true});
  const b=(n,ph,tr,date,time)=>{const r=call('book',{...mkP(n,ph),treatment:tr,date,time}); assert(r.ok,JSON.stringify(r)); return r.data.appt.apptNo;};
  const a1=b('เอ','0811111111','fill','2026-11-23','09:00'), a2=b('บี','0822222222','fill','2026-11-23','09:30'), a3=b('ซี','0833333333','scale','2026-11-23','10:00'), a4=b('ดี','0844444444','scale','2026-11-24','10:00');
  call('adminSetStatus',{apptNo:a1,status:'done'},adm); call('adminSetStatus',{apptNo:a2,status:'noshow'},adm); call('adminSetStatus',{apptNo:a3,status:'cancelled'},adm);
  const d=call('adminDailySummary',{date:'2026-11-23'},adm); assert(d.ok,JSON.stringify(d));
  assert.equal(d.data.counts.total,3); assert.equal(d.data.counts.done,1); assert.equal(d.data.counts.noshow,1); assert.equal(d.data.counts.cancelled,1);
  assert.equal(d.data.amUsed,1); assert.equal(d.data.amCap,5); assert.equal(d.data.next.date,'2026-11-24'); assert.equal(d.data.next.appts.length,1);
  assert(!JSON.stringify(d).includes('pinHash'));
  assert.equal(call('adminDailySummary',{date:'2026-11-23'}).ok,false);                      // ต้องเป็น Admin
  const m=call('adminMonthlyReport',{month:'2026-11'},adm); assert(m.ok,JSON.stringify(m)); const r=m.data;
  assert.equal(r.totals.total,4); assert.equal(r.totals.done,1); assert.equal(r.noshowRate,50); assert.equal(r.cancelRate,25);
  assert.equal(r.byTreatment[0].key,'อุดฟัน'); assert.equal(r.patients.unique,1); assert.equal(r.patients.fresh,1);
  assert.equal(r.days.length,30); assert.equal(r.days.find(x=>x.date==='2026-11-23').done,1); assert.equal(r.prev.month,'2026-10');
  assert.equal(call('adminMonthlyReport',{month:'2026-13'},adm).code,'BAD_MONTH');
  assert.equal(call('adminMonthlyReport',{month:'2026-01'},adm).data.prev.month,'2025-12');
  console.log('REPORT PASS');
}

// ---- จัดการผู้ดูแลระบบ
{
  const {S,call}=mk(); const adm='แอดมิน';
  assert.equal(call('adminListAdmins',{}).code,'AUTH');
  let l=call('adminListAdmins',{},adm).data.admins; assert.equal(l.length,1); assert(l[0].isMe); assert(!('hash' in l[0])&&!('salt' in l[0]));
  assert.equal(call('adminSaveAdmin',{mode:'add',username:'A b',displayName:'x',password:'12345678'},adm).code,'BAD_USER');
  assert.equal(call('adminSaveAdmin',{mode:'add',username:'nurse1',displayName:'พยาบาล',password:'short'},adm).code,'BAD_PASSWORD');
  assert.equal(call('adminSaveAdmin',{mode:'add',username:'nurse1',displayName:'',password:'12345678'},adm).code,'BAD_NAME');
  assert(call('adminSaveAdmin',{mode:'add',username:'Nurse1',displayName:'พยาบาล หนึ่ง',password:'12345678'},adm).ok);
  assert.equal(S.admins[1].username,'nurse1'); assert.equal(S.admins[1].hash,'hsalt:12345678'); assert.equal(S.admins[1].active,'Y');
  assert.equal(call('adminSaveAdmin',{mode:'add',username:'nurse1',displayName:'ซ้ำ',password:'12345678'},adm).code,'USER_EXISTS');
  assert(call('adminSaveAdmin',{mode:'edit',username:'nurse1',password:'newpass99'},adm).ok); assert.equal(S.admins[1].hash,'hsalt:newpass99');
  assert(call('adminSaveAdmin',{mode:'edit',username:'nurse1',displayName:'ชื่อใหม่'},adm).ok); assert.equal(S.admins[1].displayName,'ชื่อใหม่');
  assert.equal(call('adminSaveAdmin',{mode:'edit',username:'admin',active:false},adm).code,'SELF_DISABLE');
  assert(call('adminSaveAdmin',{mode:'edit',username:'nurse1',active:false},adm).ok); assert.equal(S.admins[1].active,'N');
  assert.equal(call('adminSaveAdmin',{mode:'edit',username:'nobody',active:true},adm).code,'NOT_FOUND');
  // ผู้ดูแลคนสุดท้ายต้องไม่ถูกปิด (nurse1 ปิดอยู่ → ลองปิด admin ผ่านบัญชีอื่น)
  assert(call('adminSaveAdmin',{mode:'edit',username:'nurse1',active:true},adm).ok);
  assert.equal(call('adminSaveAdmin',{mode:'edit',username:'admin',active:false},'พยาบาล','nurse1').ok,true); // nurse1 ปิด admin ได้
  assert.equal(call('adminSaveAdmin',{mode:'edit',username:'nurse1',active:false},'พยาบาล','admin').code,'LAST_ADMIN');
  assert(!JSON.stringify(S.audit).includes('12345678')&&!JSON.stringify(S.audit).includes('newpass99')); // ไม่เก็บรหัสผ่านใน Log
  assert(S.audit.some(a=>a.action==='admin_add')&&S.audit.some(a=>a.action==='admin_edit'));
  console.log('ADMINS PASS');
}

// ---- นัดเพิ่มช่วงเช้า (เจ้าหน้าที่) : อุดฟันเกินโควตา + นัดอื่น ๆ ระบุเอง
{
  const {S,call}=mk('2026-11-08'); const AD='เจ้าหน้าที่ A', D='2026-11-17';
  const Pq=n=>({title:'นาย',firstName:n,lastName:'ทดสอบ',age:'30',rights:E.RIGHTS[0]});
  const ph=i=>'08'+String(10000000+i);
  // คนไข้ออนไลน์จองอุดฟันเต็ม 2 คิว
  assert(call('book',{...Pq('ก'),phone:ph(1),treatment:'fill',date:D,time:'09:00',consent:true}).ok);
  assert(call('book',{...Pq('ข'),phone:ph(2),treatment:'fill',date:D,time:'09:30',consent:true}).ok);
  assert.equal(call('slots',{date:D,treatment:'fill'}).data.times.length,0);
  // เจ้าหน้าที่เพิ่มอุดฟันคนที่ 3, 4 (เวลาซ้ำกับคิวเดิมได้)
  const x1=call('adminCreate',{...Pq('ค'),phone:ph(3),session:'AMX',treatment:'อุดฟัน',date:D,time:'09:00'},AD); assert(x1.ok,JSON.stringify(x1));
  assert.equal(x1.data.appt.session,'AM'); assert.equal(x1.data.appt.source,'extra'); assert.equal(x1.data.appt.treatment,'อุดฟัน');
  assert(call('adminCreate',{...Pq('ง'),phone:ph(4),session:'AMX',treatment:'อุดฟัน',date:D,time:'09:00'},AD).ok);
  // นัดอื่น ๆ พิมพ์เอง
  const o=call('adminCreate',{...Pq('จ'),phone:ph(5),session:'AMX',treatment:'ตัดไหม',date:D,time:'11:45',note:'หลังผ่าตัด'},AD); assert(o.ok,JSON.stringify(o)); assert.equal(o.data.appt.treatment,'ตัดไหม');
  assert.equal(call('adminCreate',{...Pq('ฉ'),phone:ph(6),session:'AMX',treatment:'อื่น ๆ',date:D,time:'10:00'},AD).code,'BAD_TREATMENT');
  assert.equal(call('adminCreate',{...Pq('ช'),phone:ph(7),session:'AMX',treatment:'ตัดไหม',date:D,time:'12:00'},AD).code,'BAD_TIME');
  assert.equal(call('adminCreate',{...Pq('ช'),phone:ph(7),session:'AMX',treatment:'ตัดไหม',date:D,time:'08:30'},AD).code,'BAD_TIME');
  assert.equal(call('adminCreate',{...Pq('ช'),phone:ph(7),session:'AMX',treatment:'ตัดไหม',date:'2026-11-14',time:'10:00'},AD).code,'NOT_OPEN'); // เสาร์
  assert.equal(call('adminCreate',{...Pq('ช'),phone:ph(7),session:'AMX',treatment:'อุดฟัน',date:D,time:'10:00'}).code,'AUTH');
  assert.equal(call('adminCreate',{...Pq('ค'),phone:ph(3),session:'AMX',treatment:'อุดฟัน',date:D,time:'10:00'},AD).code,'ACTIVE_EXISTS'); // 1 คน 1 นัด
  // คิวออนไลน์ไม่ถูกกระทบ (นัดเพิ่มไม่แย่งคิว) และคนไข้เลื่อน/ยกเลิกเองไม่ได้
  const live=S.appts.filter(a=>a.source==='extra'); assert.equal(live.length,3);
  assert.equal(call('slots',{date:D,treatment:'scale'}).data.times.length,3);
  const lk=call('lookup',{apptNo:x1.data.appt.apptNo,phone:ph(3),pin:'1234'}).data; assert(!lk.canReschedule); assert(!lk.canCancel);
  // ย้าย/แก้ไขนัดเพิ่ม
  assert(call('adminMove',{apptNo:x1.data.appt.apptNo,date:D,time:'10:15'},AD).ok);
  assert.equal(call('adminMove',{apptNo:x1.data.appt.apptNo,date:D,time:'13:00'},AD).code,'BAD_TIME');
  const up=call('adminUpdate',{...Pq('ค'),phone:ph(3),apptNo:x1.data.appt.apptNo,treatment:'ขูดหินปูน + ขัดฟัน',note:''},AD); assert(up.ok,JSON.stringify(up));
  // ยกเลิกแล้วฟื้นคืนได้
  assert(call('adminSetStatus',{apptNo:o.data.appt.apptNo,status:'cancelled'},AD).ok); assert(call('adminSetStatus',{apptNo:o.data.appt.apptNo,status:'waiting'},AD).ok);
  // รายงาน: โควตาออนไลน์ไม่รวมนัดเพิ่ม แต่แสดงจำนวนนัดเพิ่ม
  const ds=call('adminDailySummary',{date:D},AD).data; assert.equal(ds.amUsed,2); assert.equal(ds.amExtra,3);
  console.log('EXTRA PASS');
}
