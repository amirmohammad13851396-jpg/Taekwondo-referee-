const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const crypto = require('crypto');
initializeApp();
const db = getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
function authUid(req){ if(!req.auth) fail('unauthenticated','برای ادامه وارد شوید.'); return req.auth.uid; }
function normalizeCode(v){return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);}
function safeName(v,fallback){return String(v||'').trim().slice(0,40)||fallback;}
async function getMember(tx,roomRef,uid){const snap=await tx.get(roomRef.collection('members').doc(uid));if(!snap.exists)fail('permission-denied','ابتدا با کد اتاق وارد شوید.');return snap.data();}

exports.createRoom = onCall({maxInstances:20}, async req => {
 const uid=authUid(req); const redName=safeName(req.data?.redName,'ورزشکار قرمز'); const blueName=safeName(req.data?.blueName,'ورزشکار آبی');
 let code, ref;
 for(let i=0;i<8;i++){code=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();ref=db.collection('rooms').doc(code);if(!(await ref.get()).exists)break;code=null;}
 if(!code)fail('resource-exhausted','ساخت کد اتاق ممکن نشد؛ دوباره تلاش کنید.');
 const room={code,adminUid:uid,redName,blueName,redScore:0,blueScore:0,redKyonggo:0,blueKyonggo:0,redGamjeom:0,blueGamjeom:0,round:1,duration:120,timerRemaining:120,timerRunning:false,timerStartedAtMs:0,ended:false,createdAt:FieldValue.serverTimestamp()};
 const batch=db.batch();batch.set(ref,room);batch.set(ref.collection('members').doc(uid),{uid,displayName:'مدیر مسابقه',joinedAt:FieldValue.serverTimestamp(),isAdmin:true});await batch.commit();
 return {roomCode:code,member:{uid,displayName:'مدیر مسابقه',isAdmin:true}};
});

exports.joinRoom = onCall({maxInstances:30}, async req => {
 const uid=authUid(req);const code=normalizeCode(req.data?.roomCode);if(code.length<4)fail('invalid-argument','کد اتاق نامعتبر است.');
 const roomRef=db.collection('rooms').doc(code);const room=await roomRef.get();if(!room.exists)fail('not-found','اتاق پیدا نشد. کد را بررسی کنید.');
 const displayName=safeName(req.data?.displayName,'داور');const memberRef=roomRef.collection('members').doc(uid);const existing=await memberRef.get();
 if(existing.exists){return {member:{uid,...existing.data()}};}
 const member={uid,displayName,joinedAt:FieldValue.serverTimestamp(),isAdmin:room.data().adminUid===uid};await memberRef.set(member);return {member};
});

exports.proposeEvent = onCall({maxInstances:40}, async req => {
 const uid=authUid(req);const code=normalizeCode(req.data?.roomCode);const side=req.data?.side;const type=req.data?.type;const points=Number(req.data?.points||0);
 if(!['red','blue'].includes(side)||!['score','kyonggo','gamjeom'].includes(type))fail('invalid-argument','نوع درخواست نامعتبر است.');
 if(type==='score'&&![1,2,3,4,5].includes(points))fail('invalid-argument','امتیاز باید بین ۱ تا ۵ باشد.');
 const roomRef=db.collection('rooms').doc(code);const roomSnap=await roomRef.get();if(!roomSnap.exists)fail('not-found','اتاق پیدا نشد.');
 const room=roomSnap.data();if(room.ended)fail('failed-precondition','مسابقه پایان یافته است.');
 const memberSnap=await roomRef.collection('members').doc(uid).get();if(!memberSnap.exists)fail('permission-denied','ابتدا وارد تیم داوری شوید.');
 const m=memberSnap.data();const ref=roomRef.collection('events').doc();await ref.set({type,side,points:type==='score'?points:0,status:'pending',votes:{},proposerUid:uid,proposerName:m.displayName||'داور',round:room.round||1,createdAt:FieldValue.serverTimestamp()});
 return {eventId:ref.id};
});

exports.voteEvent = onCall({maxInstances:50}, async req => {
 const uid=authUid(req);const code=normalizeCode(req.data?.roomCode);const eventId=String(req.data?.eventId||'');if(!eventId)fail('invalid-argument','درخواست نامعتبر است.');
 const roomRef=db.collection('rooms').doc(code);const eventRef=roomRef.collection('events').doc(eventId);
 await db.runTransaction(async tx=>{
  const roomSnap=await tx.get(roomRef);const eventSnap=await tx.get(eventRef);const member=await getMember(tx,roomRef,uid);
  if(!roomSnap.exists||!eventSnap.exists)fail('not-found','اتاق یا درخواست پیدا نشد.');
  const room=roomSnap.data(),e=eventSnap.data();if(room.ended)fail('failed-precondition','مسابقه پایان یافته است.');if(e.status!=='pending')fail('failed-precondition','این درخواست دیگر در انتظار تأیید نیست.');
  const votes={...(e.votes||{})};if(votes[uid])fail('already-exists','شما قبلاً این درخواست را تأیید کرده‌اید.');votes[uid]=member.displayName||'داور';
  if(Object.keys(votes).length>=2){
   const update={};if(e.type==='score')update[e.side+'Score']=Number(room[e.side+'Score']||0)+Number(e.points||0);
   if(e.type==='kyonggo')update[e.side+'Kyonggo']=Number(room[e.side+'Kyonggo']||0)+1;
   if(e.type==='gamjeom'){update[e.side+'Gamjeom']=Number(room[e.side+'Gamjeom']||0)+1;const opponent=e.side==='red'?'blue':'red';update[opponent+'Score']=Number(room[opponent+'Score']||0)+1;}
   tx.update(roomRef,update);tx.update(eventRef,{votes,status:'approved',approvedAt:FieldValue.serverTimestamp()});
  } else tx.update(eventRef,{votes});
 });
 return {ok:true};
});

exports.adminUpdateMatch = onCall({maxInstances:20}, async req => {
 const uid=authUid(req);const code=normalizeCode(req.data?.roomCode);const action=String(req.data?.action||'');const ref=db.collection('rooms').doc(code);
 await db.runTransaction(async tx=>{
  const snap=await tx.get(ref);if(!snap.exists)fail('not-found','اتاق پیدا نشد.');const room=snap.data();if(room.adminUid!==uid)fail('permission-denied','فقط مدیر مسابقه می‌تواند این تغییر را انجام دهد.');
  const now=Date.now();let patch={};
  if(action==='startTimer'){if(room.ended)fail('failed-precondition','مسابقه پایان یافته است.');let remaining=Number(room.timerRemaining??room.duration??120);if(remaining<=0)remaining=Number(room.duration||120);patch={timerRunning:true,timerRemaining:remaining,timerStartedAtMs:now};}
  else if(action==='pauseTimer'){let remaining=Number(room.timerRemaining||0);if(room.timerRunning)remaining=Math.max(0,remaining-(now-Number(room.timerStartedAtMs||now))/1000);patch={timerRunning:false,timerRemaining:remaining,timerStartedAtMs:0};}
  else if(action==='resetTimer'){patch={timerRunning:false,timerRemaining:Number(room.duration||120),timerStartedAtMs:0};}
  else if(action==='nextRound'){patch={round:Math.min(20,Number(room.round||1)+1),timerRunning:false,timerRemaining:Number(room.duration||120),timerStartedAtMs:0};}
  else if(action==='prevRound'){patch={round:Math.max(1,Number(room.round||1)-1),timerRunning:false,timerRemaining:Number(room.duration||120),timerStartedAtMs:0};}
  else if(action==='setDuration'){const duration=Number(req.data?.duration);if(!Number.isInteger(duration)||duration<30||duration>600)fail('invalid-argument','زمان راند باید بین ۳۰ تا ۶۰۰ ثانیه باشد.');patch={duration,timerRunning:false,timerRemaining:duration,timerStartedAtMs:0};}
  else if(action==='setNames'){patch={redName:safeName(req.data?.redName,'ورزشکار قرمز'),blueName:safeName(req.data?.blueName,'ورزشکار آبی')};}
  else if(action==='finishMatch'){patch={ended:true,timerRunning:false,timerStartedAtMs:0};}
  else fail('invalid-argument','عملیات نامعتبر است.');
  tx.update(ref,patch);
 });return {ok:true};
});
