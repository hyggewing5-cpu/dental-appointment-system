const E = require('../engine.js'); const assert = require('assert');
function mk(todayStr='2026-11-08'){
  const S={settings:{},appts:[],closures:[],audit:[]}; const fails={};
  const db={getSettings:()=>S.settings,saveSettings:o=>Object.assign(S.settings,o),
    listAppointments:()=>S.appts.map(a=>({...a})),addAppointment:a=>S.appts.push({...a}),
    updateAppointment:(n,p)=>Object.assign(S.appts.find(a=>a.apptNo===n),p),
    deleteAppointment:n=>{S.appts=S.appts.filter(a=>a.apptNo!==n)},
    listClosures:()=>S.closures.map(c=>({...c})),addClosures:r=>S.closures.push(...r),removeClosure:d=>{S.closures=S.closures.filter(c=>c.date!==d)},
    addAudit:e=>S.audit.push(e),listAudit:()=>S.audit.slice().reverse()};
  const ctx=(admin)=>({db,admin:admin||null,now:()=>({date:todayStr,time:'10:00',stamp:todayStr+' 10:00:00'}),
    hash:s=>'h'+s,randomPin:()=>'1234',throttle:{blocked:k=>(fails[k]||0)>=5,fail:k=>fails[k]=(fails[k]||0)+1,reset:k=>delete fails[k]}});
  const call=(a,p,admin)=>E.handle(a,p,ctx(admin));
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
  let cfg=call('getConfig',{}).data; assert.equal(cfg.titles[cfg.titles.length-1],'อื่น ๆ'); assert.equal(cfg.titles.length,22); assert(cfg.titles.includes('ร.ท.')&&cfg.titles.includes('น.อ.'));
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
