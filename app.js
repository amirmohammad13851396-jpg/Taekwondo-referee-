import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, collection, onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const call = name => httpsCallable(functions, name);
let currentUser = null, roomCode = null, roomData = null, memberData = null;
let unsubs = [], timerInterval = null, pendingEvents = [], historyEvents = [], members = [];
const localKey = "tkd-online-session-v1";

function message(id, text, bad=false) { const el=$(id); el.textContent=text||""; el.className="message"+(bad?" statusbad":" statusgood"); }
function toast(text) { const el=document.createElement("div"); el.className="toast"; el.textContent=text; document.body.appendChild(el); setTimeout(()=>el.remove(),2800); }
function cleanName(v, fallback) { return String(v||fallback).trim().slice(0,40)||fallback; }
function errorText(e) { const map={"functions/unauthenticated":"اتصال کاربر برقرار نیست.","functions/not-found":"اتاق یا درخواست پیدا نشد.","functions/permission-denied":"اجازه انجام این کار را ندارید.","functions/already-exists":"این داور قبلاً تأیید کرده است.","functions/failed-precondition":"این درخواست دیگر در انتظار تأیید نیست.","functions/invalid-argument":"اطلاعات واردشده درست نیست."}; return map[e?.code] || e?.message || "خطایی رخ داد؛ دوباره تلاش کنید."; }
function saveSession(){ if(roomCode&&currentUser) localStorage.setItem(localKey,JSON.stringify({roomCode,uid:currentUser.uid})); }
function clearSession(){localStorage.removeItem(localKey);}
function showMatch(){ $("welcome").classList.add("hidden"); $("match").classList.remove("hidden"); }
function showWelcome(){ $("match").classList.add("hidden"); $("welcome").classList.remove("hidden"); }
function stopListeners(){unsubs.forEach(f=>f());unsubs=[];if(timerInterval)clearInterval(timerInterval);timerInterval=null;}
async function joinWithCode(code,name){
  try { message("welcomeMsg","در حال ورود به اتاق…"); const result=await call("joinRoom")({roomCode:code,displayName:name}); roomCode=code; memberData=result.data.member; saveSession(); attachRoom(); message("welcomeMsg",""); }
  catch(e){message("welcomeMsg",errorText(e),true);}
}
async function createRoom(){
  try { $("createBtn").disabled=true; message("welcomeMsg","در حال ساخت اتاق آنلاین…"); const result=await call("createRoom")({redName:cleanName($("redName").value,"ورزشکار قرمز"),blueName:cleanName($("blueName").value,"ورزشکار آبی")}); roomCode=result.data.roomCode; memberData=result.data.member; saveSession(); attachRoom(); message("welcomeMsg",""); }
  catch(e){message("welcomeMsg",errorText(e),true);} finally{$("createBtn").disabled=false;}
}
function attachRoom(){
 stopListeners(); if(!roomCode)return; showMatch(); $("roomCodeDisplay").textContent=roomCode;
 const roomRef=doc(db,"rooms",roomCode);
 unsubs.push(onSnapshot(roomRef,snap=>{if(!snap.exists()){toast("این اتاق دیگر وجود ندارد.");leaveRoom();return;} roomData=snap.data(); renderRoom();},err=>message("matchMsg",errorText(err),true)));
 const memRef=collection(db,"rooms",roomCode,"members");
 unsubs.push(onSnapshot(memRef,snap=>{members=snap.docs.map(d=>({uid:d.id,...d.data()}));renderMembers();},err=>console.warn(err)));
 const evRef=query(collection(db,"rooms",roomCode,"events"),orderBy("createdAt","desc"),limit(80));
 unsubs.push(onSnapshot(evRef,snap=>{const all=snap.docs.map(d=>({id:d.id,...d.data()}));pendingEvents=all.filter(e=>e.status==="pending");historyEvents=all.filter(e=>e.status!=="pending");renderEvents();},err=>console.warn(err)));
 saveSession();
}
function renderRoom(){
 if(!roomData)return;
 $("redNameDisplay").textContent=roomData.redName;$("blueNameDisplay").textContent=roomData.blueName;
 $("redScore").textContent=roomData.redScore||0;$("blueScore").textContent=roomData.blueScore||0;
 $("redKyonggo").textContent=roomData.redKyonggo||0;$("blueKyonggo").textContent=roomData.blueKyonggo||0;
 $("redGamjeom").textContent=roomData.redGamjeom||0;$("blueGamjeom").textContent=roomData.blueGamjeom||0;
 $("roundDisplay").textContent=`راند ${roomData.round||1}`;
 $("timerState").textContent=roomData.timerRunning?"در حال اجرا":(roomData.ended?"پایان مسابقه":"متوقف / آماده");
 $("connection").textContent=roomData.ended?"مسابقه پایان یافته":"متصل به اتاق";
 const isAdmin=currentUser&&roomData.adminUid===currentUser.uid;
 $("adminTools").classList.toggle("hidden",!isAdmin);
 if(isAdmin){$("editRedName").value=roomData.redName;$("editBlueName").value=roomData.blueName;$("durationInput").value=roomData.duration||120;}
 renderTimer();
}
function renderTimer(){
 if(!roomData)return; let seconds=Math.max(0,Number(roomData.timerRemaining)||0);
 if(roomData.timerRunning&&roomData.timerStartedAtMs) seconds=Math.max(0,seconds-(Date.now()-roomData.timerStartedAtMs)/1000);
 const s=Math.ceil(seconds);$("timer").textContent=`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
 if(roomData.timerRunning&&seconds<=0){$("timerState").textContent="زمان تمام شد";}
}
function renderMembers(){
 $("judgeCount").textContent=members.length;const holder=$("judgesList");holder.replaceChildren();
 members.sort((a,b)=>(a.displayName||"").localeCompare(b.displayName||"","fa")).forEach(m=>{const chip=document.createElement("span");chip.className="judgechip"+(m.uid===currentUser?.uid?" you":"");chip.textContent=(m.displayName||"داور")+(m.uid===currentUser?.uid?" (شما)":"");holder.appendChild(chip);});
}
function eventLabel(e){const side=e.side==="red"?"قرمز":"آبی";if(e.type==="score")return `${side} +${e.points} امتیاز`;if(e.type==="kyonggo")return `کیونگو برای ${side}`;if(e.type==="gamjeom")return `گام‌جوم برای ${side}`;return "رویداد مسابقه";}
function renderEvents(){
 $("pendingCount").textContent=`${pendingEvents.length} در انتظار`;
 const p=$("pendingList");p.replaceChildren();if(!pendingEvents.length){p.className="list empty";p.textContent="درخواستی برای تأیید وجود ندارد.";}else{p.className="list";pendingEvents.forEach(e=>{
  const card=document.createElement("div");card.className="event";const top=document.createElement("div");top.className="eventtop";const title=document.createElement("strong");title.textContent=eventLabel(e);const count=document.createElement("span");count.className="pill";count.textContent=`${Object.keys(e.votes||{}).length} از ۲ تأیید`;top.append(title,count);card.append(top);
  const meta=document.createElement("div");meta.className="eventmeta";meta.textContent=`درخواست‌دهنده: ${e.proposerName||"داور"} • راند ${e.round||1}`;card.append(meta);
  const actions=document.createElement("div");actions.className="eventactions";const vote=document.createElement("button");const already=!!(e.votes&&e.votes[currentUser.uid]);vote.className=already?"voted":"vote";vote.disabled=already||roomData?.ended;vote.textContent=already?"تأیید شد ✓":"تأیید درخواست";vote.onclick=()=>voteEvent(e.id);actions.append(vote);card.append(actions);p.append(card);
 });}
 const h=$("historyList");h.replaceChildren();if(!historyEvents.length){h.className="list empty";h.textContent="هنوز رویدادی ثبت نشده است.";}else{h.className="list";historyEvents.slice(0,30).forEach(e=>{const card=document.createElement("div");card.className="event";const top=document.createElement("div");top.className="eventtop";const title=document.createElement("strong");title.textContent=eventLabel(e);const status=document.createElement("span");status.className="pill";status.textContent=e.status==="approved"?`ثبت شد (${Object.keys(e.votes||{}).length} تأیید)`:"رد شد";top.append(title,status);card.append(top);const meta=document.createElement("div");meta.className="eventmeta";meta.textContent=`درخواست‌دهنده: ${e.proposerName||"داور"} • تأییدها: ${Object.values(e.votes||{}).join("، ")||"—"}`;card.append(meta);h.append(card);});}
}
async function propose(side,type,points){try{const res=await call("proposeEvent")({roomCode,side,type,points:Number(points)||0});message("proposalMsg",`درخواست ثبت شد؛ منتظر تأیید داوران است.`);toast("درخواست برای تیم داوری ارسال شد.");}catch(e){message("proposalMsg",errorText(e),true);}}
async function voteEvent(eventId){try{await call("voteEvent")({roomCode,eventId});toast("تأیید شما ثبت شد.");}catch(e){toast(errorText(e));}}
async function adminUpdate(action,extra={}){try{await call("adminUpdateMatch")({roomCode,action,...extra});toast("تغییرات اعمال شد.");}catch(e){toast(errorText(e));}}
function leaveRoom(){stopListeners();roomCode=null;roomData=null;memberData=null;pendingEvents=[];historyEvents=[];members=[];clearSession();showWelcome();$("connection").textContent="بدون اتاق";}

$("createBtn").addEventListener("click",createRoom);
$("joinBtn").addEventListener("click",()=>{const code=$("joinCode").value.trim().toUpperCase();const name=cleanName($("judgeName").value,"داور");if(!code){message("welcomeMsg","کد اتاق را وارد کنید.",true);return;}joinWithCode(code,name);});
$("joinCode").addEventListener("input",e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""));
document.querySelectorAll("[data-type]").forEach(btn=>btn.addEventListener("click",()=>propose(btn.dataset.side,btn.dataset.type,btn.dataset.points||0)));
$("startTimer").onclick=()=>adminUpdate("startTimer");$("pauseTimer").onclick=()=>adminUpdate("pauseTimer");$("resetTimer").onclick=()=>adminUpdate("resetTimer");$("nextRound").onclick=()=>adminUpdate("nextRound");$("prevRound").onclick=()=>adminUpdate("prevRound");
$("saveDuration").onclick=()=>adminUpdate("setDuration",{duration:Number($("durationInput").value)});
$("saveNames").onclick=()=>adminUpdate("setNames",{redName:cleanName($("editRedName").value,"ورزشکار قرمز"),blueName:cleanName($("editBlueName").value,"ورزشکار آبی")});
$("finishMatch").onclick=()=>{if(confirm("مسابقه پایان یابد؟"))adminUpdate("finishMatch");};
$("leaveBtn").onclick=leaveRoom;
$("copyBtn").onclick=async()=>{try{await navigator.clipboard.writeText(roomCode);toast("کد اتاق کپی شد.");}catch{prompt("کد اتاق را کپی کنید:",roomCode);}};
setInterval(renderTimer,250);

onAuthStateChanged(auth,async user=>{
 if(user){currentUser=user;$("connection").textContent="آماده";const saved=JSON.parse(localStorage.getItem(localKey)||"null");if(saved&&saved.roomCode&&!roomCode){roomCode=saved.roomCode;try{const res=await call("joinRoom")({roomCode,displayName:"داور"});memberData=res.data.member;attachRoom();}catch{clearSession();roomCode=null;showWelcome();}}}
 else {try{await signInAnonymously(auth);}catch(e){$("connection").textContent="خطای ورود";message("welcomeMsg","ورود ناشناس Firebase فعال نیست؛ طبق راهنما آن را فعال کنید.",true);}}
});
