// Funcionando todo
// app.js — UI + Auth + RTDB + Minijuego (tabs robustas)
import {
  onAuth,
  signUp, signIn, signOutUser,
  getUserProfile,
  saveScore, getLeaderboard, subscribeLeaderboard,
  joinQueueAny,
  cancelQueue,
  subscribeUserMatch,
  sendFriendRequest,
  subscribeFriendInbox,
  acceptFriendRequest,
  rejectFriendRequest,
  subscribeFriendsList,
  removeFriendBoth

} from './firebase.js';

const $ = (sel) => document.querySelector(sel);

// ===== Estado =====
const state = {
  user: null,
  profile: null,
  unsubLb: null,
  unsubMatch: null,
  unsubInbox: null,
  unsubFriends: null
};


// ===== Vistas =====
function showAuth() {
  $('#view-auth').classList.remove('is-hidden');
  $('#view-dashboard').classList.add('is-hidden');
}
function showDash() {
  $('#view-dashboard').classList.remove('is-hidden');
  $('#view-auth').classList.add('is-hidden');
}

// ===== Tabs (simple) =====
function activateTab(which) {
  const isLogin = which === 'login';
  const btnLogin = $('#tab-login');
  const btnReg   = $('#tab-register');
  const formLogin = $('#form-login');
  const formReg   = $('#form-register');

  if (!btnLogin || !btnReg || !formLogin || !formReg) return;

  btnLogin.classList.toggle('is-active', isLogin);
  btnReg.classList.toggle('is-active', !isLogin);
  btnLogin.setAttribute('aria-selected', isLogin ? 'true' : 'false');
  btnReg.setAttribute('aria-selected', !isLogin ? 'true' : 'false');

  formLogin.classList.toggle('is-active', isLogin);
  formReg.classList.toggle('is-active', !isLogin);
}

function bindTabs() {
  const btnLogin = $('#tab-login');
  const btnReg   = $('#tab-register');
  if (!btnLogin || !btnReg) return;

  btnLogin.type = 'button';
  btnReg.type   = 'button';

  btnLogin.addEventListener('click', (e) => { e.preventDefault(); activateTab('login'); });
  btnReg.addEventListener('click',   (e) => { e.preventDefault(); activateTab('register'); });
}

// ===== Perfil / UI =====
function initialsFrom(name) {
  if (!name) return '?';
  const parts = String(name).split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function renderProfile(profile) {
  $('#profile-avatar').textContent  = initialsFrom(profile?.username || profile?.email);
  $('#profile-username').textContent = profile?.username || '—';
  $('#profile-email').textContent    = profile?.email || '';
  $('#profile-score').textContent    = String(profile?.score ?? 0);
}

// ===== Leaderboard =====
async function reloadLeaderboard() {
  const limit = Math.max(1, Math.min(100, Number($('#lb-limit').value || 20)));
  const users = await getLeaderboard({ limit });
  paintLeaderboard(users);
}
function paintLeaderboard(users) {
   console.log('paintLeaderboard recibió usuarios:', users);
  const tbody = $('#table-lb tbody');
  tbody.innerHTML = '';
  users.forEach((u, i) => {
    const tr = document.createElement('tr');
    // La clase 'me' se aplicará si el usuario logueado coincide con el UID de la fila.
    // `state.user` se actualiza por `onAuth`, así que esto funcionará.
    if (state.user && u.uid === state.user.uid) tr.classList.add('me');
    tr.innerHTML = `<td>${i + 1}</td><td>${u.username || u.email}</td><td>${u?.score ?? 0}</td>`;
    tbody.appendChild(tr);
  });
}



function bindAuthWatcher() {
  onAuth(async (user) => {
    state.user = user;

    // Limpieza de suscripciones previas
    if (state.unsubMatch)   { state.unsubMatch();   state.unsubMatch = null; }
    if (state.unsubInbox)   { state.unsubInbox();   state.unsubInbox = null; }
    if (state.unsubFriends) { state.unsubFriends(); state.unsubFriends = null; }

    if (!user) {
      state.profile = null;
      showAuth();
      activateTab('login');
      renderProfile(null);

      // Reset UI de matchmaking
      const lblS = document.querySelector('#mm-state');
      const lblId = document.querySelector('#mm-match-id');
      if (lblS) lblS.textContent = 'Idle';
      if (lblId) lblId.textContent = '—';

      // Reset UI social
      const inboxList = document.querySelector('#fr-inbox');
      const friendsList = document.querySelector('#fr-list');
      if (inboxList)   inboxList.innerHTML = `<li class="muted">No tienes solicitudes.</li>`;
      if (friendsList) friendsList.innerHTML = `<li class="muted">Aún no tienes amigos.</li>`;
    } else {
      state.profile = await getUserProfile(user.uid);
      renderProfile(state.profile);
      showDash();

      // --- Matchmaking: notificación de empareje ---
      state.unsubMatch = subscribeUserMatch(user.uid, (info) => {
        const lblS = document.querySelector('#mm-state');
        const lblId = document.querySelector('#mm-match-id');
        if (!info) return;
        if (lblS) lblS.textContent = `Match listo con ${info.opponent?.username || 'rival'}`;
        if (lblId) lblId.textContent = info.matchId || '—';
        cancelQueue(user.uid).catch(() => {});
      });

      // --- Social: Inbox de solicitudes ---
      state.unsubInbox = subscribeFriendInbox(user.uid, (data) => {
        renderInboxUI(user.uid, data);
      });

      // --- Social: Lista de amigos ---
      state.unsubFriends = subscribeFriendsList(user.uid, (friends) => {
        renderFriendsUI(friends);
      });
    }

    await reloadLeaderboard();
  });
}



// ===== Formularios =====
function bindForms() {
  // Registro
  $('#form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f   = e.currentTarget;
    const msg = $('#msg-register');
    const btn = f.querySelector('button[type="submit"]');

    const email    = f.email.value.trim();
    const username = f.username.value.trim();
    const password = f.password.value;

    if (!email || !password || !username) {
      msg.textContent = 'Completa email, nombre de usuario y contraseña.';
      return;
    }

    btn.disabled = true; msg.textContent = 'Creando...';
    try {
      await signUp({ email, password, username });
      msg.textContent = 'Cuenta creada. Sesión iniciada.';
      f.reset();
    } catch (err) {
      console.error('[register]', err);
      msg.textContent = err.message || 'Error al registrar.';
    } finally {
      btn.disabled = false;
    }
  });

  // Login
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f   = e.currentTarget;
    const msg = $('#msg-login');
    const btn = f.querySelector('button[type="submit"]');

    const email    = f.email.value.trim();
    const password = f.password.value;

    if (!email || !password) {
      msg.textContent = 'Completa email y contraseña.';
      return;
    }

    btn.disabled = true; msg.textContent = 'Autenticando...';
    try {
      await signIn({ email, password });
      msg.textContent = '';
      f.reset();
    } catch (err) {
      console.error('[login]', err);
      msg.textContent = err.message || 'No se pudo iniciar sesión.';
    } finally {
      btn.disabled = false;
    }
  });

  // Logout
  $('#btn-logout').addEventListener('click', async () => {
    await signOutUser();
    showAuth(); // Volver a la vista de autenticación
    activateTab('login'); // Asegurar que la pestaña de login esté activa
  });

  // Recargar leaderboard manualmente
  $('#btn-reload-lb').addEventListener('click', reloadLeaderboard);
}

// ===== Minijuego (Dino Runner) =====
class DinoRunner {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width; this.H = canvas.height;
    this.groundY = this.H - 50;

    this.dino = { x: 60, y: this.groundY - 40, w: 44, h: 44, vy: 0, onGround: true };
    this.obstacles = [];
    this.speed = 280; this.speedGain = 0.08;
    this.gravity = 1400; this.jumpV = -520;
    this.spawnEvery = [700, 1300]; this.spawnTimer = 0;
    this.score = 0; this.best = 0; this.running = true; this.gameOver = false;
    this.last = performance.now();
    this._sent = false;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); this._jump(); }
      if (e.code === 'KeyP') this.running = !this.running;
      if (e.code === 'KeyR' && this.gameOver) this._reset();
    });
    canvas.addEventListener('pointerdown', () => this._jump());

    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }
  _reset() {
    this.obstacles = []; this.speed = 280; this.spawnTimer = 0;
    this.score = 0; this.gameOver = false; this.running = true; this._sent = false;
    this.dino.y = this.groundY - this.dino.h; this.dino.vy = 0; this.dino.onGround = true;
  }
  _jump() { if (this.dino.onGround && !this.gameOver) { this.dino.vy = this.jumpV; this.dino.onGround = false; } }
  _rand(a,b){ return Math.random()*(b-a)+a; }
  _spawn() {
    const h = this._rand(28,56), w = this._rand(16,34), y = this.groundY - h, gap = this._rand(140,240);
    this.obstacles.push({ x: this.W + gap, y, w, h });
  }
  _collides(a,b){ return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y; }

  _tick(now) {
    const dt = Math.min(0.033, (now - this.last)/1000); this.last = now;

    if (this.running && !this.gameOver) {
      this.dino.vy += this.gravity*dt; this.dino.y += this.dino.vy*dt;
      if (this.dino.y >= this.groundY - this.dino.h) {
        this.dino.y = this.groundY - this.dino.h; this.dino.vy=0; this.dino.onGround=true;
      }
      this.spawnTimer -= dt*1000; if (this.spawnTimer<=0){ this._spawn(); this.spawnTimer = this._rand(700,1300); }
      for (const o of this.obstacles) o.x -= this.speed*dt;
      this.obstacles = this.obstacles.filter(o => o.x + o.w > -20);

      for (const o of this.obstacles) {
        if (this._collides(this.dino,o)) {
          this.gameOver = true; this.running=false; this.best = Math.max(this.best, Math.floor(this.score));
          break;
        }
      }

      this.speed += this.speedGain;
      this.score += (this.speed*dt)/8;
    }

    const c=this.ctx; c.clearRect(0,0,this.W,this.H);
    c.fillStyle='#fafafa'; c.fillRect(0,0,this.W,this.H);
    c.strokeStyle='#bdbdbd'; c.lineWidth=2; c.beginPath(); c.moveTo(0,this.groundY); c.lineTo(this.W,this.groundY); c.stroke();
    c.fillStyle='#4a4a4a'; for (const o of this.obstacles) c.fillRect(o.x,o.y,o.w,o.h);
    c.fillStyle='#222'; c.fillRect(this.dino.x,this.dino.y,this.dino.w,this.dino.h);
    c.fillStyle='#fff'; c.fillRect(this.dino.x+this.dino.w-12,this.dino.y+10,6,6);
    c.fillStyle='#222'; c.font='16px system-ui, sans-serif';
    c.fillText(`Score: ${Math.floor(this.score)}`, 12, 22);
    c.fillText(`Best: ${this.best}`, 12, 42);
    if (!this.running && !this.gameOver) { c.fillStyle='#666'; c.font='bold 16px system-ui, sans-serif'; c.fillText('Pausado (P)', this.W/2-40, 40); }
    if (this.gameOver) { c.fillStyle='#d32f2f'; c.font='bold 18px system-ui, sans-serif'; c.fillText('¡Game Over! R = reiniciar', this.W/2-120, 40); }

    requestAnimationFrame(this._tick);

    if (this.gameOver && state.user && !this._sent) {
      this._sent = true;
      const s = Math.floor(this.score);
      $('#msg-game').textContent = 'Guardando score...';
      saveScore(state.user.uid, s).then(async () => {
        $('#msg-game').textContent = `Score guardado: ${s}`;
        state.profile = await getUserProfile(state.user.uid);
        renderProfile(state.profile);
        // Ya no necesitamos reloadLeaderboard() aquí, la suscripción global lo manejará.
        // Pero lo mantenemos para garantizar una actualización inmediata de la UI
        // si no hay un cambio en la base de datos que la dispare.
        reloadLeaderboard();
      }).catch((err) => {
        console.error('[saveScore]', err);
        $('#msg-game').textContent = 'No se pudo guardar el score.';
      }).finally(() => {
        setTimeout(()=>{ this._sent=false; }, 500);
      });
    }
  }
}

// ===== Init =====
function init() {
  showAuth();
  bindTabs();
  activateTab('login');   // estado inicial
  bindForms();
  bindAuthWatcher();
  bindMatchmaking();
  bindFriendsUI();
  bindInboxActions();
  reloadLeaderboard();
  state.unsubLb = subscribeLeaderboard(
    { limit: Number($('#lb-limit').value || 20) },
    paintLeaderboard
  );
  // ************************

  const canvas = document.getElementById('runner');
  if (canvas) new DinoRunner(canvas);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function bindMatchmaking() {
  const findBtn   = document.querySelector('#btn-find-match');
  const cancelBtn = document.querySelector('#btn-cancel-match');
  const lblS = document.querySelector('#mm-state');
  const lblId = document.querySelector('#mm-match-id');
  if (!findBtn || !cancelBtn) return;

  findBtn.onclick = async () => {
    if (!state.user) return;
    const name = state.profile?.username || (state.profile?.email?.split('@')[0]) || 'Usuario';
    lblS && (lblS.textContent = 'Buscando...');
    findBtn.disabled = true; cancelBtn.disabled = true;
    try {
      await joinQueueAny({ uid: state.user.uid, username: name });
      cancelBtn.disabled = false; // ya quedó en cola
    } catch (e) {
      console.error('[matchmaking] joinQueueAny', e);
      lblS && (lblS.textContent = 'Error');
      findBtn.disabled = false; cancelBtn.disabled = true;
    }
  };

  cancelBtn.onclick = async () => {
    if (!state.user) return;
    try { await cancelQueue(state.user.uid); } catch {}
    lblS && (lblS.textContent = 'Cancelado');
    lblId && (lblId.textContent = '—');
    findBtn.disabled = false; cancelBtn.disabled = true;
  };

  window.addEventListener('beforeunload', () => {
    if (state?.user) cancelQueue(state.user.uid).catch(()=>{});
  });
}

function bindFriendsUI() {
  const input = document.querySelector('#fr-email');
  const btn   = document.querySelector('#fr-send');
  const msg   = document.querySelector('#fr-msg');

  if (!input || !btn) return;

  btn.onclick = async () => {
    if (!state.user) return;
    const email = String(input.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      if (msg) msg.textContent = 'Escribe un correo válido.';
      return;
    }
    btn.disabled = true; if (msg) msg.textContent = 'Enviando...';
    try {
      const fromName  = state.profile?.username || (state.profile?.email?.split('@')[0]) || 'Usuario';
      const fromEmail = state.profile?.email || '';
      await sendFriendRequest({ fromUid: state.user.uid, fromName, fromEmail, toEmail: email });
      if (msg) msg.textContent = 'Solicitud enviada.';
      input.value = '';
    } catch (e) {
      console.error('[friends] send', e);
      if (msg) msg.textContent = e?.message || 'No se pudo enviar.';
    } finally {
      btn.disabled = false;
      setTimeout(()=>{ if (msg) msg.textContent = ''; }, 1500);
    }
  };
}

function renderInboxUI(myUid, inboxObj) {
  const ul = document.querySelector('#fr-inbox');
  if (!ul) return;
  ul.innerHTML = '';

  const entries = Object.entries(inboxObj || {});
  if (!entries.length) {
    ul.innerHTML = `<li class="muted">No tienes solicitudes.</li>`;
    return;
  }

  entries
    .sort((a,b) => (a[1]?.ts || 0) - (b[1]?.ts || 0))
    .forEach(([fromUid, req]) => {
      const name   = req.fromName || (req.fromEmail ? req.fromEmail.split('@')[0] : fromUid);
      const status = (req.status || 'pending');

      const li = document.createElement('li');
      li.dataset.from = fromUid;  // <- clave para delegación
      li.innerHTML = `
        <div class="row" style="justify-content:space-between; width:100%;">
          <div><b>${name}</b> <span class="muted">(${status})</span></div>
          ${status === 'pending' ? `
            <div class="row">
              <button type="button" class="fr-accept" data-from="${fromUid}">Aceptar</button>
              <button type="button" class="fr-reject secondary" data-from="${fromUid}">Rechazar</button>
            </div>
          ` : ``}
        </div>
      `;
      ul.appendChild(li);
    });
}



function renderFriendsUI(friendsObj) {
  const ul = document.querySelector('#fr-list');
  if (!ul) return;
  ul.innerHTML = '';
  const entries = Object.entries(friendsObj || {});
  if (!entries.length) {
    ul.innerHTML = `<li class="muted">Aún no tienes amigos.</li>`;
    return;
  }
  entries
    .map(([uid, f]) => f)
    .sort((a,b) => (a.username || '').localeCompare(b.username || ''))
    .forEach((f) => {
      const li = document.createElement('li');
      const label = f.username || (f.email ? f.email.split('@')[0] : f.uid);
      li.innerHTML = `
        <div class="row" style="justify-content:space-between; width:100%;">
          <span>${label}</span>
          <button class="icon-btn" title="Eliminar">🗑️</button>
        </div>
      `;
      li.querySelector('.icon-btn').onclick = () => {
        if (!state.user) return;
        removeFriendBoth(state.user.uid, f.uid).catch(console.error);
      };
      ul.appendChild(li);
    });
}

function bindInboxActions() {
  // Delegación global: funciona aunque vuelvas a renderizar la lista
  document.addEventListener('click', async (e) => {
    const acceptBtn = e.target.closest('#fr-inbox .fr-accept');
    const rejectBtn = e.target.closest('#fr-inbox .fr-reject');
    if (!acceptBtn && !rejectBtn) return;

    e.preventDefault();
    e.stopPropagation();

    if (!state.user) return;

    // Tomamos el UID del remitente desde data-from (en el botón o el li)
    const btn = acceptBtn || rejectBtn;
    const fromUid = btn.getAttribute('data-from') ||
                    btn.closest('li')?.dataset?.from;

    if (!fromUid) return;

    // Deshabilitamos mientras procesamos
    const li = btn.closest('li');
    const a = li?.querySelector('.fr-accept');
    const r = li?.querySelector('.fr-reject');
    if (a) a.disabled = true;
    if (r) r.disabled = true;

    try {
      if (acceptBtn) {
        await acceptFriendRequest({ myUid: state.user.uid, fromUid });
      } else {
        await rejectFriendRequest({ myUid: state.user.uid, fromUid });
      }
      // El UI se actualizará por la suscripción realtime (subscribeFriendInbox)
    } catch (err) {
      console.error('[friends] action error:', err);
      // Rehabilita si algo falló
      if (a) a.disabled = false;
      if (r) r.disabled = false;
    }
  }, true);
}



