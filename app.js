// app.js
import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  ref, set, get, child, update, onValue, remove, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js";

const $ = (s) => document.querySelector(s);

// ======= UI existente =======
const loginContainer = $("#loginContainer");
const appSection = $("#appSection");
const authMsg = $("#authMsg");
const authAlert = $("#authAlert");
const welcome = $("#welcome");
const inpUser = $("#usernameInput");
const inpPass = $("#passwordInput");
const loginButton = $("#loginButton");
const registerButton = $("#registerButton");
const resetPwdButton = $("#resetPwdButton");
const logoutButton = $("#logoutButton");
const btnRefresh = $("#btnRefresh");
const tblBody = $("#tblBody");
const listMsg = $("#listMsg");

// ======= UI amigos =======
const friendEmailInput = document.getElementById("friendEmailInput");
const sendFriendReqBtn = document.getElementById("sendFriendReqBtn");
const inboxList = document.getElementById("inboxList");
const friendsList = document.getElementById("friendsList");

// ======= UI panel online =======
const onlineFriendsList = document.getElementById("onlineFriendsList");

// ======= UI toasts =======
const toastContainer = document.getElementById("toastContainer");
function showToast(message, variant = "ok") {
  if (!toastContainer) return;
  const el = document.createElement("div");
  el.className = `toast toast--${variant}`;
  el.innerHTML = `<strong>${variant === "ok" ? "Conectado" : "Desconectado"}</strong>${message}`;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ======= UI matchmaking =======
const btnFindMatch = document.getElementById("btnFindMatch");
const btnCancelMatch = document.getElementById("btnCancelMatch");
const mmStatus = document.getElementById("mmStatus");

let unsubInbox = null;
let unsubFriends = null;
let unsubLeaderboard = null;
let unsubOnline = null;
let unsubUserMatch = null;

let friendsCache = {};     // { friendUid: {uid, username, email} }
let onlineCache = {};      // { uid: { username, ts } }
let prevOnlineSet = new Set();
let onlineInitialized = false;

// --- Helpers de sesión local ---
const storage = {
  get username() { return localStorage.getItem("sid_username") || ""; },
  set username(v) { v ? localStorage.setItem("sid_username", v) : localStorage.removeItem("sid_username"); },
  get email() { return localStorage.getItem("sid_email") || ""; },
  set email(v) { v ? localStorage.setItem("sid_email", v) : localStorage.removeItem("sid_email"); },
};

function showAuth() { loginContainer.classList.remove("hidden"); appSection.classList.add("hidden"); }
function showApp()  { loginContainer.classList.add("hidden"); appSection.classList.remove("hidden"); welcome.textContent = `Hola, ${storage.username}`; }
function showAlert(type, text) { authAlert.innerHTML = `<div class="alert ${type === "error" ? "alert--error" : "alert--success"}">${text}</div>`; }
function clearAlert() { authAlert.innerHTML = ""; }

// ======================= AUTH =======================
async function apiRegister(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;
  const username = email.split("@")[0];
  await set(ref(db, `users/${uid}`), { username, email, score: 0, createdAt: Date.now() });
}

async function apiLogin(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;
  const snap = await get(child(ref(db), `users/${uid}`));
  const node = snap.exists() ? snap.val() : {};
  const username = node.username ?? email.split("@")[0];
  storage.username = username;
  storage.email = node.email ?? email;
  if (!snap.exists() || !node.username || !node.email) {
    await update(ref(db, `users/${uid}`), { username, email: storage.email });
  }
}

// botones
loginButton.addEventListener("click", async (e) => {
  e.preventDefault(); clearAlert(); authMsg.textContent = "";
  const u = inpUser.value.trim(), p = inpPass.value;
  try { await apiLogin(u, p); } catch { showAlert("error", "Error al iniciar sesión"); }
});
registerButton.addEventListener("click", async () => {
  clearAlert();
  const u = inpUser.value.trim(), p = inpPass.value;
  try { await apiRegister(u, p); showAlert("success", "Usuario registrado correctamente."); }
  catch { showAlert("error", "No se pudo registrar."); }
});
resetPwdButton.addEventListener("click", async () => {
  const email = inpUser.value.trim();
  if (!email.includes("@")) return showAlert("error", "Escribe tu email.");
  await sendPasswordResetEmail(auth, email);
  showAlert("success", "Correo de recuperación enviado.");
});

logoutButton.addEventListener("click", async () => {
  const u = auth.currentUser;
  if (u) { try { await remove(ref(db, `users-online/${u.uid}`)); } catch {} }
  await signOut(auth);
  storage.username = ""; storage.email = "";
  cleanupSubscriptions();
  showAuth();
});

// ======================= SESIÓN =======================
onAuthStateChanged(auth, async (u) => {
  if (u) {
    showApp();
    await ensureProfile(u);
    setupPresence(u);

    await loadLeaderboard();
    subscribeLeaderboard();

    subscribeInbox(u.uid);
    subscribeFriends(u.uid);
    subscribeOnline();

    // matchmaking: escucha si otro te empareja
    subscribeUserMatch(u.uid);

  } else {
    cleanupSubscriptions();
    showAuth();
  }
});

async function ensureProfile(u) {
  const userRef = ref(db, `users/${u.uid}`);
  const snap = await get(userRef);
  const fallbackName = storage.username || (u.email ? u.email.split("@")[0] : "Usuario");
  const fallbackEmail = storage.email || u.email || "";
  if (!snap.exists()) {
    await set(userRef, { username: fallbackName, email: fallbackEmail, score: 0, createdAt: Date.now() });
  } else {
    const v = snap.val() || {};
    if (!v.username || !v.email) {
      await update(userRef, { username: v.username ?? fallbackName, email: v.email ?? fallbackEmail });
    }
  }
}

// ======================= PRESENCIA =======================
function setupPresence(u) {
  const meRef = ref(db, `users-online/${u.uid}`);
  const payload = { username: storage.username || (u.email ? u.email.split("@")[0] : "Usuario"), ts: Date.now() };
  set(meRef, payload);
  try { onDisconnect(meRef).remove(); } catch {}
}

function subscribeOnline() {
  if (unsubOnline) unsubOnline();
  const off = onValue(ref(db, `users-online`), (snap) => {
    onlineCache = snap.exists() ? snap.val() : {};
    renderOnlineFriends();

    const current = new Set(Object.keys(friendsCache || {}).filter(uid => onlineCache[uid]));
    if (onlineInitialized) {
      for (const uid of current) if (!prevOnlineSet.has(uid)) {
        const name = friendsCache[uid]?.username || friendsCache[uid]?.email?.split("@")[0] || "Amigo";
        showToast(`${name} se conectó`, "ok");
      }
      for (const uid of prevOnlineSet) if (!current.has(uid)) {
        const name = friendsCache[uid]?.username || friendsCache[uid]?.email?.split("@")[0] || "Amigo";
        showToast(`${name} se desconectó`, "off");
      }
    }
    prevOnlineSet = current;
    onlineInitialized = true;
  });
  unsubOnline = () => off();
}

function renderOnlineFriends() {
  if (!onlineFriendsList) return;
  onlineFriendsList.innerHTML = "";
  const friendsUids = Object.keys(friendsCache || {});
  const onlineFriends = friendsUids.filter(uid => onlineCache[uid]);
  if (onlineFriends.length === 0) {
    onlineFriendsList.innerHTML = `<li class="muted">Ningún amigo en línea.</li>`;
    return;
  }
  onlineFriends.forEach(uid => {
    const f = friendsCache[uid];
    const li = document.createElement("li");
    li.className = "chip";
    li.innerHTML = `<span class="dot"></span><span>${f.username || (f.email ? f.email.split("@")[0] : uid)}</span>`;
    onlineFriendsList.appendChild(li);
  });
}

// ======================= LEADERBOARD =======================
function renderLeaderboard(users) {
  tblBody.innerHTML = "";
  users.forEach((u, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${u.username ?? "—"}</td><td>${Number(u.score) || 0}</td>`;
    tblBody.appendChild(tr);
  });
  listMsg.textContent = `Total: ${users.length}`;
}

async function apiListUsersOnce() {
  const snap = await get(ref(db, "users"));
  if (!snap.exists()) return [];
  return Object.values(snap.val() || {})
    .map(u => ({ ...u, username: u.username ?? (u.email ? u.email.split("@")[0] : "—"), score: Number(u.score) || 0 }))
    .sort((a, b) => b.score - a.score);
}

async function loadLeaderboard() {
  try {
    listMsg.textContent = "Cargando...";
    const users = await apiListUsersOnce();
    renderLeaderboard(users);
    listMsg.textContent = users.length ? `Total: ${users.length}` : "Sin datos aún.";
  } catch (e) {
    console.error("Leaderboard error:", e);
    listMsg.textContent = "No se pudo cargar.";
    tblBody.innerHTML = "";
  }
}
btnRefresh.addEventListener("click", loadLeaderboard);

function subscribeLeaderboard() {
  if (unsubLeaderboard) unsubLeaderboard();
  const off = onValue(ref(db, "users"), (snap) => {
    const val = snap.val() || {};
    const list = Object.values(val)
      .map(u => ({ ...u, username: u.username ?? (u.email ? u.email.split("@")[0] : "—"), score: Number(u.score) || 0 }))
      .sort((a, b) => b.score - a.score);
    renderLeaderboard(list);
  });
  unsubLeaderboard = () => off();
}

// ======================= Puntaje (juego) =======================
async function apiUpdateScore(score) {
  const u = auth.currentUser;
  if (!u) throw new Error("No autenticado");
  const username = storage.username || (u.email ? u.email.split("@")[0] : "Usuario");
  await update(ref(db, `users/${u.uid}`), { score: Number(score) || 0, lastPlayed: Date.now(), username });
}
window.sendScoreToFirebase = async function (score) {
  try { await apiUpdateScore(score); await loadLeaderboard(); }
  catch (e) { console.error("Error al guardar el puntaje:", e); }
};

// ======================= AMIGOS (resumido) =======================
sendFriendReqBtn?.addEventListener("click", async () => {
  const targetEmail = (friendEmailInput?.value || "").trim().toLowerCase();
  if (!targetEmail || !targetEmail.includes("@")) return showAlert("error", "Escribe un correo válido.");
  const me = auth.currentUser;
  if (!me) return showAlert("error", "Inicia sesión.");
  try {
    const target = await findUserByEmail(targetEmail);
    if (!target) return showAlert("error", "Ese correo no está registrado.");
    if (target.uid === me.uid) return showAlert("error", "No puedes enviarte solicitud a ti mismo.");
    await sendFriendRequest(me.uid, target.uid, targetEmail, storage.username || me.email.split("@")[0]);
    showAlert("success", "Solicitud enviada.");
    friendEmailInput.value = "";
  } catch (e) { console.error(e); showAlert("error", "No se pudo enviar la solicitud."); }
});

async function findUserByEmail(email) {
  const snap = await get(ref(db, "users"));
  if (!snap.exists()) return null;
  const users = snap.val();
  for (const uid of Object.keys(users)) {
    const u = users[uid];
    if ((u.email || "").toLowerCase() === email) return { uid, ...u };
  }
  return null;
}
async function sendFriendRequest(fromUid, toUid, toEmail, fromName) {
  const ts = Date.now();
  await update(ref(db, `users/${fromUid}/friendRequests/outbox/${toUid}`), {
    toUid, toEmail, status: "pending", ts
  });
  await update(ref(db, `users/${toUid}/friendRequests/inbox/${fromUid}`), {
    fromUid: fromUid, fromEmail: (storage.email || ""), fromName: fromName, status: "pending", ts
  });
}

function subscribeInbox(uid) {
  if (unsubInbox) unsubInbox();
  const off = onValue(ref(db, `users/${uid}/friendRequests/inbox`), (snap) => {
    const data = snap.exists() ? snap.val() : {};
    renderInbox(uid, data);
  });
  unsubInbox = () => off();
}

function renderInbox(myUid, inboxObj) {
  inboxList.innerHTML = "";
  const entries = Object.entries(inboxObj || {});
  if (!entries.length) {
    inboxList.innerHTML = `<li class="muted">No tienes solicitudes.</li>`;
    return;
  }
  entries.forEach(([fromUid, req]) => {
    const name = req.fromName || (req.fromEmail ? req.fromEmail.split("@")[0] : fromUid);
    const status = req.status || "pending";
    const li = document.createElement("li");
    const left = `<b>${name}</b> <span class="muted">(${status})</span>`;
    const right = status === "pending"
      ? `<div class="row"><button class="acceptBtn">Aceptar</button><button class="rejectBtn secondary">Rechazar</button></div>`
      : ``;
    li.innerHTML = `<div class="row" style="justify-content:space-between; width:100%;"><div>${left}</div>${right}</div>`;
    if (status === "pending") {
      li.querySelector(".acceptBtn").addEventListener("click", () => acceptRequest(myUid, fromUid));
      li.querySelector(".rejectBtn").addEventListener("click", () => rejectRequest(myUid, fromUid));
    }
    inboxList.appendChild(li);
  });
}

async function acceptRequest(myUid, fromUid) {
  const mySnap = await get(child(ref(db), `users/${myUid}`));
  const me = mySnap.val() || {};
  const otherSnap = await get(child(ref(db), `users/${fromUid}`));
  const other = otherSnap.val() || {};
  const now = Date.now();
  await update(ref(db, `users/${myUid}/friendRequests/inbox/${fromUid}`), { status: "accepted" });
  await update(ref(db, `users/${myUid}/friends/${fromUid}`), {
    uid: fromUid,
    username: other.username || (other.email ? other.email.split("@")[0] : "Usuario"),
    email: other.email || "", since: now
  });
  try {
    await update(ref(db, `users/${fromUid}/friendRequests/outbox/${myUid}`), { status: "accepted" });
    await update(ref(db, `users/${fromUid}/friends/${myUid}`), {
      uid: myUid,
      username: me.username || (me.email ? me.email.split("@")[0] : "Usuario"),
      email: me.email || "", since: now
    });
    await remove(ref(db, `users/${myUid}/friendRequests/inbox/${fromUid}`));
    await remove(ref(db, `users/${fromUid}/friendRequests/outbox/${myUid}`));
  } catch (e) { console.warn("Reflejo de aceptación falló:", e); }
}

async function rejectRequest(myUid, fromUid) {
  await update(ref(db, `users/${myUid}/friendRequests/inbox/${fromUid}`), { status: "rejected" });
  try { await update(ref(db, `users/${fromUid}/friendRequests/outbox/${myUid}`), { status: "rejected" }); } catch {}
  await remove(ref(db, `users/${myUid}/friendRequests/inbox/${fromUid}`));
  try { await remove(ref(db, `users/${fromUid}/friendRequests/outbox/${myUid}`)); } catch {}
}

function subscribeFriends(uid) {
  if (unsubFriends) unsubFriends();
  const off = onValue(ref(db, `users/${uid}/friends`), (snap) => {
    friendsCache = snap.exists() ? snap.val() : {};
    renderFriends(friendsCache);
    renderOnlineFriends();
  });
  unsubFriends = () => off();
}

function renderFriends(friendsObj) {
  friendsList.innerHTML = "";
  const entries = Object.entries(friendsObj || {});
  if (!entries.length) {
    friendsList.innerHTML = `<li class="muted">Aún no tienes amigos.</li>`;
    return;
  }
  entries
    .map(([uid, f]) => f)
    .sort((a, b) => (a.username || "").localeCompare(b.username || ""))
    .forEach((f) => {
      const li = document.createElement("li");
      const label = f.username || (f.email ? f.email.split("@")[0] : f.uid);
      li.innerHTML = `
        <div class="row" style="justify-content:space-between; width:100%;">
          <span>${label}</span>
          <button class="icon-btn" data-uid="${f.uid}" title="Eliminar amigo">🗑️</button>
        </div>`;
      li.querySelector(".icon-btn").addEventListener("click", () => removeFriendBoth(auth.currentUser.uid, f.uid));
      friendsList.appendChild(li);
    });
}

async function removeFriendBoth(myUid, friendUid) {
  try {
    await remove(ref(db, `users/${myUid}/friends/${friendUid}`));
    await remove(ref(db, `users/${friendUid}/friends/${myUid}`));
  } catch (e) { console.error("No se pudo eliminar amigo:", e); }
}

// ======================= MATCHMAKING =======================
// Estructura:
// matchmaking/queue/{uid} : { uid, username, ts }
// matches/{matchId} : { aUid, bUid, createdAt, state: "matched" }
// user-matches/{uid} : { matchId, opponent: { uid, username } }

btnFindMatch?.addEventListener("click", joinQueueAny);
btnCancelMatch?.addEventListener("click", cancelQueue);

async function joinQueueAny() {
  const u = auth.currentUser;
  if (!u) return showAlert("error", "Inicia sesión.");
  const me = { uid: u.uid, username: storage.username || (u.email ? u.email.split("@")[0] : "Usuario") };
  mmStatus.textContent = "En cola buscando partida...";
  // Ponme en cola
  await set(ref(db, `matchmaking/queue/${u.uid}`), { uid: me.uid, username: me.username, ts: Date.now() });
  try { onDisconnect(ref(db, `matchmaking/queue/${u.uid}`)).remove(); } catch {}
  // Intentar emparejar con alguien
  await tryPair(me);
}

async function cancelQueue() {
  const u = auth.currentUser;
  if (!u) return;
  await remove(ref(db, `matchmaking/queue/${u.uid}`));
  mmStatus.textContent = "Búsqueda cancelada.";
}

async function tryPair(me) {
  const snap = await get(ref(db, `matchmaking/queue`));
  const list = snap.exists() ? snap.val() : {};
  // Busca el primer otro jugador en cola
  let rival = null;
  for (const otherUid of Object.keys(list)) {
    if (otherUid === me.uid) continue;
    rival = list[otherUid];
    break;
  }
  if (!rival) {
    mmStatus.textContent = "En cola... esperando a otro jugador.";
    return; // quedo esperando
  }

  // Evitar colisiones: solo crea el match el UID "menor"
  const aUid = me.uid < rival.uid ? me.uid : rival.uid;
  const bUid = me.uid < rival.uid ? rival.uid : me.uid;

  if (me.uid !== aUid) {
    mmStatus.textContent = "Encontrado rival, esperando confirmación...";
    return; // el otro creará
  }

  const aName = me.username;
  const bName = rival.username;
  const matchId = `${aUid}_${bUid}_${Date.now()}`;

  const updates = {};
  updates[`matches/${matchId}`] = { aUid, bUid, createdAt: Date.now(), state: "matched" };
  updates[`user-matches/${aUid}`] = { matchId, opponent: { uid: bUid, username: bName } };
  updates[`user-matches/${bUid}`] = { matchId, opponent: { uid: aUid, username: aName } };
  updates[`matchmaking/queue/${aUid}`] = null;
  updates[`matchmaking/queue/${bUid}`] = null;

  await update(ref(db), updates);
  mmStatus.textContent = `¡Emparejado con ${bName}!`;
}

// escucha si te emparejan (aunque empareje el otro)
function subscribeUserMatch(uid) {
  if (unsubUserMatch) unsubUserMatch();
  const off = onValue(ref(db, `user-matches/${uid}`), (snap) => {
    if (!snap.exists()) return;
    const val = snap.val();
    if (val?.opponent?.username) {
      mmStatus.textContent = `¡Emparejado con ${val.opponent.username}! (Match: ${val.matchId})`;
      // por si quedaste en cola por lag
      remove(ref(db, `matchmaking/queue/${uid}`)).catch(() => {});
    }
  });
  unsubUserMatch = () => off();
}

// Limpieza
function cleanupSubscriptions() {
  if (unsubInbox) unsubInbox();
  if (unsubFriends) unsubFriends();
  if (unsubLeaderboard) unsubLeaderboard();
  if (unsubOnline) unsubOnline();
  if (unsubUserMatch) unsubUserMatch();
  unsubInbox = unsubFriends = unsubLeaderboard = unsubOnline = unsubUserMatch = null;
}
