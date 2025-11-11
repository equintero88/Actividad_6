// Funcionando solicitudes amistad
// firebase.js — Firebase v12.4.0 por CDN (ESM)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile as fbUpdateProfile,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set, get, update, remove,
  runTransaction,
  query, orderByChild, limitToLast,
  onValue, onDisconnect,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDvvPb90MYtZ6n0TEDox8TzV5orTrNikFA",
  authDomain: "prueba2-eqc.firebaseapp.com",
  databaseURL: "https://prueba2-eqc-default-rtdb.firebaseio.com",
  projectId: "prueba2-eqc",
  storageBucket: "prueba2-eqc.firebasestorage.app",
  messagingSenderId: "837540862247",
  appId: "1:837540862247:web:07c7372706cabbff9a3102",
  measurementId: "G-SEHWY08BP6"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
// const analytics = getAnalytics(app); // getAnalytics importado pero no usado, puedes agregarlo si lo necesitas
// console.log('[firebase] app.options.apiKey =', app.options.apiKey);
// console.log('[firebase] app.options.authDomain =', app.options.authDomain);

export const auth = getAuth(app);
export const db = getDatabase(app);

// ---------- Auth helpers ----------
export function onAuth(cb) {
  // cb(user | null)
  return onAuthStateChanged(auth, cb);
}

export async function signUp({ email, password, username }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (username) {
    try {
      await fbUpdateProfile(cred.user, { displayName: username });
    } catch (e) {
      console.error("Error updating profile displayName:", e);
    }
  }

  // Perfil en RTDB
  const userRef = ref(db, `users/${cred.user.uid}`);
  const profile = {
    uid: cred.user.uid,
    email,
    username: username || "",
    score: 0,
    createdAt: serverTimestamp(), // Uso correcto de serverTimestamp para RTDB
    updatedAt: serverTimestamp(), // Uso correcto de serverTimestamp para RTDB
  };
  await set(userRef, profile);
  return profile;
}

export async function signIn({ email, password }) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return { user: cred.user };
}

export async function signOutUser() {
  await signOut(auth);
}

// ---------- Perfil / Scores en RTDB ----------
export async function getUserProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export async function updateUserProfile(uid, data) {
  await update(ref(db, `users/${uid}`), { ...data, updatedAt: serverTimestamp() });
  const snap = await get(ref(db, `users/${uid}`));
  return snap.val();
}

// Guarda high-score (máximo) con transacción
export async function saveScore(uid, newScore) {
  const scoreRef = ref(db, `users/${uid}/score`);
  await runTransaction(scoreRef, (current) => {
    // Si current es null o no es un número, se asume 0.
    const curr = typeof current === 'number' ? current : 0;
    return Math.max(curr, Number(newScore) || 0);
  });
  await update(ref(db, `users/${uid}`), { updatedAt: serverTimestamp() });

  const snap = await get(scoreRef);
  return snap.val();
}

// Top N (ordenado desc por score)
export async function getLeaderboard({ limit: lim = 20 } = {}) {
  const q = query(ref(db, 'users'), orderByChild('score'), limitToLast(Number(lim)));
  const snap = await get(q);
  const arr = [];
  console.log("getLeaderboard - Snapshot completo:", snap.val()); // <-- NUEVO LOG
  snap.forEach(child => {
    console.log("getLeaderboard - Procesando hijo:", child.key, child.val()); // <-- NUEVO LOG
    arr.push(child.val())
  });
  // Se invierte el array para que queden en orden descendente (mayor puntaje primero)
  arr.sort((a,b) => (b.score || 0) - (a.score || 0));
  return arr;
}

// Suscripción en tiempo real (opcional)
export function subscribeLeaderboard({ limit: lim = 20 } = {}, cb) {
  const q = query(ref(db, 'users'), orderByChild('score'), limitToLast(Number(lim)));
  return onValue(q, (snap) => {
    console.log("subscribeLeaderboard - Snapshot completo:", snap.val()); // <-- NUEVO LOG
    const out = [];
    snap.forEach(child => {
      console.log("subscribeLeaderboard - Procesando hijo:", child.key, child.val()); // <-- NUEVO LOG
      out.push(child.val());
    });
    // Se invierte el array para que queden en orden descendente (mayor puntaje primero)
    out.sort((a,b) => (b.score || 0) - (a.score || 0));
    cb(out);
  });

  
}


export async function joinQueueAny({ uid, username }) {
  const qRef = ref(db, `mm/queue/${uid}`);
  const entry = { uid, name: username || "Usuario", ts: Date.now() };

  await set(qRef, entry);
  try { onDisconnect(qRef).remove(); } catch {}

  await _attemptPair(entry);
}

/** Saca al usuario de la cola (cancelar/limpiar). */
export async function cancelQueue(uid) {
  await remove(ref(db, `mm/queue/${uid}`));
}

/** Notifica cuando alguien te emparejó. */
export function subscribeUserMatch(uid, cb) {
  const inboxRef = ref(db, `mm/inbox/${uid}`);
  return onValue(inboxRef, (snap) => cb(snap.exists() ? snap.val() : null));
}

// ------------------- Interno -------------------
async function _attemptPair(me) {
  const poolSnap = await get(ref(db, `mm/queue`));
  if (!poolSnap.exists()) return;

  const pool = poolSnap.val() || {};
  const candidates = Object.values(pool).filter(e => e && e.uid !== me.uid);
  if (!candidates.length) return;

  // Elegimos el más antiguo por ts
  candidates.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const other = candidates[0];

  // Iniciador determinista: menor "${uid1}|${uid2}"
  const iAmInitiator = `${me.uid}|${other.uid}` < `${other.uid}|${me.uid}`;
  if (!iAmInitiator) return; // el otro creará la sala

  const roomId = `r_${me.uid.slice(0,6)}_${other.uid.slice(0,6)}_${Date.now().toString(36)}`;
  const now = Date.now();

  const updates = {};
  updates[`mm/rooms/${roomId}`] = { id: roomId, a: me.uid, b: other.uid, since: now, state: "matched" };
  updates[`mm/inbox/${me.uid}`]    = { matchId: roomId, opponent: { uid: other.uid, username: other.name || "Jugador" } };
  updates[`mm/inbox/${other.uid}`] = { matchId: roomId, opponent: { uid: me.uid,   username: me.name   || "Jugador" } };
  updates[`mm/queue/${me.uid}`] = null;
  updates[`mm/queue/${other.uid}`] = null;

  await update(ref(db), updates);
}

export async function sendFriendRequest({ fromUid, fromName, fromEmail, toEmail }) {
  const target = await _findUserByEmail(toEmail);
  if (!target) throw new Error('El correo no está registrado.');
  if (target.uid === fromUid) throw new Error('No puedes enviarte solicitud a ti mismo.');

  const now = Date.now();
  const updates = {};
  // Outbox emisor
  updates[`social/requests/outbox/${fromUid}/${target.uid}`] = {
    toUid: target.uid, toName: target.username, toEmail: target.email || toEmail, status: 'pending', ts: now
  };
  // Inbox receptor
  updates[`social/requests/inbox/${target.uid}/${fromUid}`] = {
    fromUid, fromName: fromName || (fromEmail?.split('@')[0] || 'Usuario'), fromEmail: fromEmail || '', status: 'pending', ts: now
  };
  await update(ref(db), updates);
}

/** Bandeja de entrada de solicitudes (del usuario logueado) */
export function subscribeFriendInbox(myUid, cb) {
  const r = ref(db, `social/requests/inbox/${myUid}`);
  return onValue(r, (snap) => cb(snap.exists() ? snap.val() : {}));
}

/** Aceptar solicitud: crea amistad en ambos sentidos y limpia solicitudes */
// Reemplaza por completo
export async function acceptFriendRequest({ myUid, fromUid }) {
  const me    = await _readUser(myUid);
  const other = await _readUser(fromUid);
  const now = Date.now();

  const updates = {};
  // Crear amistad en ambos sentidos
  updates[`social/friends/${myUid}/${fromUid}`] = {
    uid: fromUid,
    username: other?.username || (other?.email?.split('@')[0] || 'Usuario'),
    email: other?.email || '',
    since: now
  };
  updates[`social/friends/${fromUid}/${myUid}`] = {
    uid: myUid,
    username: me?.username || (me?.email?.split('@')[0] || 'Usuario'),
    email: me?.email || '',
    since: now
  };
  // Eliminar las solicitudes (sin escribir /status al mismo tiempo)
  updates[`social/requests/inbox/${myUid}/${fromUid}`] = null;
  updates[`social/requests/outbox/${fromUid}/${myUid}`] = null;

  await update(ref(db), updates);
  console.log('[friends] accepted ->', { myUid, fromUid });
}

// Reemplaza por completo
export async function rejectFriendRequest({ myUid, fromUid }) {
  const updates = {};
  // Solo eliminamos; no escribimos /status para evitar conflicto ancestro/descendiente
  updates[`social/requests/inbox/${myUid}/${fromUid}`] = null;
  updates[`social/requests/outbox/${fromUid}/${myUid}`] = null;

  await update(ref(db), updates);
  console.log('[friends] rejected ->', { myUid, fromUid });
}



/** Lista de amigos del usuario */
export function subscribeFriendsList(myUid, cb) {
  const r = ref(db, `social/friends/${myUid}`);
  return onValue(r, (snap) => cb(snap.exists() ? snap.val() : {}));
}

/** Eliminar amistad en ambos sentidos */
export async function removeFriendBoth(myUid, friendUid) {
  const updates = {};
  updates[`social/friends/${myUid}/${friendUid}`] = null;
  updates[`social/friends/${friendUid}/${myUid}`] = null;
  await update(ref(db), updates);
}

// ----------------- Helpers internos -----------------
async function _findUserByEmail(email) {
  const snap = await get(ref(db, 'users'));
  if (!snap.exists()) return null;
  const users = snap.val() || {};
  const q = String(email || '').trim().toLowerCase();
  for (const [uid, u] of Object.entries(users)) {
    const em = (u?.email || '').toLowerCase();
    if (em === q) {
      return {
        uid,
        email: u.email || '',
        username: u.username || (u.email ? u.email.split('@')[0] : 'Usuario')
      };
    }
  }
  return null;
}

async function _readUser(uid) {
  const s = await get(ref(db, `users/${uid}`));
  return s.exists() ? (s.val() || {}) : {};
}
