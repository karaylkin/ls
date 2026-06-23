/* Числовой покер — клиент. Ванильный JS + Socket.IO. */
'use strict';

const socket = io({ transports: ['websocket', 'polling'] });
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};

let state = null;        // последнее состояние с сервера
let session = LS.get('ls_session'); // { playerId, sessionToken, code }
let view = session ? 'connecting' : 'home';
let raiseValue = null;   // черновик слайдера повышения
let pendingName = LS.get('ls_name') || '';

/* ----------------------------------------------------------------- звуки */
const Sound = (() => {
  let ctx = null;
  const ensure = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); return ctx; };
  const tone = (freq, dur, type = 'sine', gain = 0.06, when = 0) => {
    const c = ensure();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(c.destination);
    const t = c.currentTime + when;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  };
  const map = {
    chip_bet: () => { tone(320, 0.1, 'triangle'); tone(440, 0.12, 'triangle', 0.05, 0.04); },
    chip_call: () => tone(300, 0.1, 'triangle'),
    check: () => tone(220, 0.08, 'sine'),
    fold: () => tone(140, 0.18, 'sawtooth', 0.04),
    all_in: () => { tone(330, 0.1, 'square', 0.05); tone(495, 0.16, 'square', 0.05, 0.07); tone(660, 0.2, 'square', 0.05, 0.14); },
    answer_lock: () => { tone(523, 0.08, 'sine'); tone(784, 0.12, 'sine', 0.05, 0.05); },
    pot_win: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'sine', 0.06, i * 0.08)); },
    your_turn: () => { tone(880, 0.12, 'sine', 0.06); tone(1175, 0.14, 'sine', 0.05, 0.08); },
    hint_reveal: () => tone(660, 0.16, 'sine', 0.05),
    answer_reveal: () => { tone(392, 0.2, 'sine', 0.06); tone(587, 0.28, 'sine', 0.06, 0.1); },
    round_start: () => { tone(440, 0.12, 'sine', 0.05); tone(554, 0.14, 'sine', 0.05, 0.07); },
    player_out: () => tone(120, 0.4, 'sawtooth', 0.05),
    tournament_win: () => { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.3, 'triangle', 0.07, i * 0.12)); },
    lobby_join: () => tone(659, 0.1, 'sine', 0.04),
    timer_tick: () => tone(900, 0.04, 'sine', 0.03),
  };
  return {
    play(name) { try { (map[name] || (() => {}))(); } catch {} },
    unlock() { try { ensure().resume(); } catch {} },
  };
})();
/* ----------------------------------------------------------------- фоновая музыка */
const Music = (() => {
  let audio = null;
  let started = false;
  let muted = LS.get('ls_music_muted') === true;
  const VOL = 0.28;
  const ensure = () => {
    if (!audio) {
      audio = new Audio('/music/casino-jazz.mp3');
      audio.loop = true;
      audio.volume = VOL;
      audio.preload = 'auto';
    }
    return audio;
  };
  const start = () => {
    if (started || muted) return;
    const a = ensure();
    a.play().then(() => { started = true; updateBtn(); }).catch(() => {});
  };
  const toggle = () => {
    muted = !muted;
    LS.set('ls_music_muted', muted);
    if (muted) {
      if (audio) audio.pause();
      started = false;
    } else {
      start();
    }
    updateBtn();
  };
  let btn = null;
  const updateBtn = () => {
    if (!btn) return;
    btn.textContent = muted ? '🔇' : '🎵';
    btn.title = muted ? 'Включить музыку' : 'Выключить музыку';
    btn.classList.toggle('off', muted);
  };
  const mount = () => {
    btn = document.createElement('button');
    btn.className = 'music-toggle';
    btn.onclick = toggle;
    document.body.appendChild(btn);
    updateBtn();
  };
  return { start, mount, isMuted: () => muted };
})();

document.addEventListener('pointerdown', () => { Sound.unlock(); Music.start(); }, { once: false });
Music.mount();

/* ----------------------------------------------------------------- сокет */
socket.on('connect', () => {
  if (session && session.sessionToken) {
    socket.emit('joinRoom', { code: session.code, name: pendingName, sessionToken: session.sessionToken });
  }
});
socket.on('joined', (j) => {
  session = j;
  LS.set('ls_session', j);
  view = 'game';
});
socket.on('state', (s) => {
  state = s;
  view = 'game';
  if (raiseValue === null && s.you) raiseValue = s.you.minRaiseTo;
  if (!s.you) raiseValue = null;
  render();
});
socket.on('error', (e) => toast(e.message || 'Ошибка'));
socket.on('lobbyClosed', (e) => {
  toast(e.reason || 'Лобби закрыто');
  resetToHome();
});
socket.on('disconnect', () => toast('Связь потеряна, переподключаемся…'));

let toastTimer = null;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}
function resetToHome() {
  LS.del('ls_session');
  session = null; state = null; view = 'home';
  render();
}

/* ----------------------------------------------------------------- действия */
const emit = (ev, data) => socket.emit(ev, data);
function createRoom() {
  const name = (document.getElementById('name')?.value || '').trim();
  if (!name) return toast('Введите имя');
  pendingName = name; LS.set('ls_name', name);
  emit('createRoom', { name });
}
function joinRoom() {
  const name = (document.getElementById('name')?.value || '').trim();
  const code = (document.getElementById('code')?.value || '').trim().toUpperCase();
  if (!name) return toast('Введите имя');
  if (!code) return toast('Введите код лобби');
  pendingName = name; LS.set('ls_name', name);
  emit('joinRoom', { code, name });
}

/* ----------------------------------------------------------------- утилиты рендера */
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const fmt = (n) => (n ?? 0).toLocaleString('ru-RU');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function me() { return state?.players.find((p) => p.isYou) || null; }

/* ----------------------------------------------------------------- главный рендер */
function render() {
  if (view === 'home' || !session) return renderHome();
  if (!state) return renderConnecting();
  $app.innerHTML = '';
  switch (state.phase) {
    case 'LOBBY': renderLobby(); break;
    case 'TOURNAMENT_END': renderEnd(); break;
    case 'STANDINGS': renderStandings(); break;
    default: renderTable(); break; // ANSWERING / BETTING / SHOWDOWN
  }
}

function renderConnecting() {
  $app.innerHTML = '';
  $app.append(h(`<div class="home card-panel"><div class="logo" style="font-size:34px">Подключение…</div><p class="muted">Восстанавливаем ваше место за столом</p></div>`));
}

/* ----------------------------------------------------------------- HOME */
function renderHome() {
  $app.innerHTML = '';
  const el = h(`
    <div class="home card-panel">
      <div class="monogram">L S</div>
      <div class="logo">LOCK&nbsp;STOCK</div>
      <label class="field" style="text-align:left;margin-top:8px">Ваше имя
        <input id="name" maxlength="20" value="${esc(pendingName)}" />
      </label>
      <div class="actions">
        <button class="btn-gold" id="btnCreate">Создать лобби</button>
        <div class="divider">или</div>
        <div class="join-row">
          <input id="code" maxlength="5" placeholder="КОД" />
          <button class="btn-ghost" id="btnJoin">Войти</button>
        </div>
      </div>
    </div>`);
  el.querySelector('#btnCreate').onclick = createRoom;
  el.querySelector('#btnJoin').onclick = joinRoom;
  el.querySelector('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $app.append(el);
}

/* ----------------------------------------------------------------- LOBBY */
function renderLobby() {
  const s = state;
  const mine = me();
  const canStart = s.isHost && s.players.filter((p) => !p.eliminated).length >= 2;
  const el = h(`
    <div class="lobby">
      <div class="lobby__head card-panel">
        <div>
          <div class="logo">LOCK STOCK</div>
          <div class="kicker">Лобби · ожидание игроков</div>
        </div>
        <div class="code-chip">
          <div class="kicker">Код</div>
          <b>${esc(s.code)}</b>
          <button class="btn-ghost" id="copy" style="padding:8px 12px">Копировать</button>
        </div>
      </div>

      <div class="card-panel">
        <div class="panel-body">
          <div class="panel-title">Игроки (${s.players.length}/6)</div>
          <div class="plist" id="plist"></div>
          <div class="row" style="margin-top:16px">
            <button class="${mine?.ready ? 'btn-ghost' : 'btn-gold'}" id="ready">${mine?.ready ? 'Не готов' : 'Готов'}</button>
            <div class="spacer"></div>
          </div>
        </div>
      </div>

      <div class="card-panel">
        <div class="panel-body">
          <div class="panel-title">Параметры турнира</div>
          <div id="settings"></div>
        </div>
      </div>

      <div class="lobby__foot">
        <button class="btn-gold" id="start" ${canStart ? '' : 'disabled'}>Начать игру</button>
        <button class="btn-wine" id="close">Закрыть лобби</button>
      </div>
    </div>`);

  const plist = el.querySelector('#plist');
  s.players.forEach((p) => {
    plist.append(h(`
      <div class="prow">
        <div class="pname">${esc(p.name)}${p.isYou ? ' <span class="muted">(вы)</span>' : ''}</div>
        <div class="row" style="gap:6px">
          ${p.id === s.hostId ? '<span class="tag host">Хост</span>' : ''}
          <span class="tag ${p.ready ? 'ready' : 'wait'}">${p.ready ? 'Готов' : 'Ждёт'}</span>
        </div>
      </div>`));
  });

  // настройки
  const cfg = el.querySelector('#settings');
  const fields = [
    ['startingChips', 'Стартовый стек'],
    ['ante', 'Анте'],
    ['anteDoubleEveryRounds', 'Удвоение анте, раунды'],
    ['anteCap', 'Потолок анте (пусто = нет)'],
    ['turnTimerMs', 'Таймер хода, мс'],
    ['answerTimerMs', 'Окно ответа, мс'],
    ['maxRaisesPerRound', 'Лимит повышений'],
  ];
  const grid = h(`<div class="settings-grid"></div>`);
  fields.forEach(([k, label]) => {
    const v = s.settings[k];
    grid.append(h(`<label class="field">${label}
      <input data-k="${k}" type="number" value="${v === null ? '' : v}" ${s.isHost ? '' : 'disabled'} />
    </label>`));
  });
  cfg.append(grid);
  if (s.isHost) {
    const saveBtn = h(`<button class="btn-ghost" id="saveCfg" style="margin-top:12px">Сохранить настройки</button>`);
    saveBtn.onclick = () => {
      const patch = {};
      grid.querySelectorAll('input[data-k]').forEach((inp) => {
        const k = inp.dataset.k;
        if (k === 'anteCap') patch[k] = inp.value === '' ? null : Number(inp.value);
        else patch[k] = Number(inp.value);
      });
      emit('updateSettings', { settings: patch });
      toast('Настройки сохранены');
    };
    cfg.append(saveBtn);
  } else {
    cfg.append(h(`<p class="muted" style="margin-top:10px">Настройки меняет только хост</p>`));
  }

  el.querySelector('#copy').onclick = () => { navigator.clipboard?.writeText(s.code); toast('Код скопирован'); };
  el.querySelector('#ready').onclick = () => emit('setReady', { ready: !mine?.ready });
  el.querySelector('#start').onclick = () => emit('startGame');
  el.querySelector('#close').onclick = () => { if (confirm('Закрыть лобби для всех?')) emit('closeLobby'); };
  $app.append(el);
}

/* ----------------------------------------------------------------- TABLE */
const BR_LABELS = ['Круг 1 · ставки', 'Круг 2 · после 1-й подсказки', 'Круг 3 · после 2-й подсказки', 'Круг 4 · после ответа — блеф'];

function renderTable() {
  const s = state;
  const el = h(`<div class="table"></div>`);

  // topbar
  el.append(h(`
    <div class="topbar card-panel">
      <div class="logo">LS · LOCK STOCK</div>
      <div class="topbar__stats">
        <div class="stat"><div class="kicker">Раунд</div><b>${s.roundNumber}</b></div>
        <div class="stat"><div class="kicker">Анте</div><b>${fmt(s.currentAnte)}</b></div>
        <div class="stat"><div class="kicker">Фаза</div><b style="font-size:13px">${phaseLabel(s)}</b></div>
      </div>
    </div>`));

  // вопрос
  const qbox = h(`<div class="question-box card-panel"></div>`);
  if (s.question) {
    qbox.append(h(`<div class="kicker" style="margin-bottom:8px">Вопрос</div>`));
    qbox.append(h(`<div class="qtext">${esc(s.question.text)}</div>`));
    if (s.question.hints.length) {
      const hints = h(`<div class="hints"></div>`);
      s.question.hints.forEach((ht, i) => hints.append(h(`<div class="hint"><span class="hlabel">Подсказка ${i + 1}</span>${esc(ht)}</div>`)));
      qbox.append(hints);
    }
    if (s.answerRevealed && s.question.answer !== null) {
      qbox.append(h(`<div class="answer-reveal"><div class="kicker">Правильный ответ</div><div class="big">${fmt(s.question.answer)}</div></div>`));
    }
  }
  el.append(qbox);

  // сукно: банк + места
  const felt = h(`<div class="felt"></div>`);
  felt.append(h(`<div class="pot"><div class="kicker">Банк</div><b>${fmt(s.pot)}</b><div class="sub">${s.currentBet > 0 ? 'текущая ставка ' + fmt(s.currentBet) : BR_LABELS[s.bettingRoundIndex] || ''}</div></div>`));
  const seats = h(`<div class="seats"></div>`);
  s.players.forEach((p) => seats.append(renderSeat(p, s)));
  felt.append(seats);
  el.append(felt);

  // зона взаимодействия
  if (s.phase === 'ANSWERING') el.append(renderAnswerBar(s));
  else if (s.phase === 'BETTING') el.append(renderActionBar(s));
  else if (s.phase === 'SHOWDOWN') el.append(renderResult(s));

  $app.append(el);
  startTicker();
}

function phaseLabel(s) {
  if (s.phase === 'ANSWERING') return 'Запись числа';
  if (s.phase === 'BETTING') return ['Ставки I', 'Ставки II', 'Ставки III', 'Ставки IV'][s.bettingRoundIndex] || 'Ставки';
  if (s.phase === 'SHOWDOWN') return 'Вскрытие';
  return s.phase;
}

function renderSeat(p, s) {
  const cls = ['seat'];
  if (p.isToAct) cls.push('toact');
  if (p.folded) cls.push('folded');
  if (p.eliminated) cls.push('elim');
  const seat = h(`<div class="${cls.join(' ')}"></div>`);

  const badges = [];
  if (p.isDealer) badges.push('<span class="mini dealer">Баттон</span>');
  if (p.allIn) badges.push('<span class="mini allin">Олл-ин</span>');
  if (!p.connected) badges.push('<span class="mini off">Оффлайн</span>');
  if (p.eliminated) badges.push('<span class="mini off">Выбыл</span>');
  if (s.phase === 'ANSWERING' && p.answerLocked) badges.push('<span class="mini locked">Готов</span>');

  seat.append(h(`
    <div class="seat__top">
      <div class="seat__name ${p.isYou ? 'you' : ''}">${esc(p.name)}</div>
      <div class="seat__chips">${fmt(p.chips)}</div>
    </div>`));
  seat.append(h(`
    <div class="seat__row">
      <div class="bet-chip">${p.roundBet > 0 ? `<span class="disc"></span>${fmt(p.roundBet)}` : (p.folded ? '<span class="muted">пас</span>' : '')}</div>
      <div class="badges">${badges.join('')}</div>
    </div>`));

  // карта-ответ: своё число видно всегда; чужое — рубашкой до вскрытия/showCard
  const result = s.lastResult;
  const isWinner = result && result.winnings && result.winnings[p.id] > 0;
  if (p.answer !== null && p.answer !== undefined) {
    seat.append(h(`<div class="pcard face ${isWinner ? 'win' : ''}">${fmt(p.answer)}</div>`));
  } else if (p.answerLocked) {
    seat.append(h(`<div class="pcard back">L S</div>`));
  }
  return seat;
}

/* ---------- ANSWERING ---------- */
function renderAnswerBar(s) {
  const mine = me();
  const bar = h(`<div class="action-bar card-panel"></div>`);
  if (mine && mine.folded) {
    bar.append(h(`<div class="locked-note">Вы не успели вписать ответ — пас на этот раунд</div>`));
  } else if (mine && mine.answerLocked) {
    bar.append(h(`<div class="locked-note">Ваше число зафиксировано: <b class="mono-num">${fmt(mine.answer)}</b></div>`));
    bar.append(h(`<div class="turn-label">Ждём остальных игроков…</div>`));
  } else {
    bar.append(h(`<div class="turn-label mine">Впишите ваше число — это ваша скрытая карта</div>`));
    const row = h(`<div class="answer-input"></div>`);
    const inp = h(`<input id="ans" type="number" inputmode="numeric" placeholder="число" />`);
    const btn = h(`<button class="btn-gold">Зафиксировать</button>`);
    const submit = () => {
      const v = Number(inp.value);
      if (inp.value === '' || !Number.isFinite(v)) return toast('Введите число');
      if (!confirm(`Зафиксировать ${v}? Изменить будет нельзя.`)) return;
      emit('lockAnswer', { value: v });
    };
    btn.onclick = submit;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(inp, btn);
    bar.append(row);
  }
  bar.append(timerEl(s.answerDeadline, 'Окно ответа'));
  return bar;
}

/* ---------- BETTING ---------- */
function renderActionBar(s) {
  const bar = h(`<div class="action-bar card-panel"></div>`);
  const mine = me();
  const myTurn = s.toActId === session.playerId && s.you;

  if (!s.toActId) {
    bar.append(h(`<div class="turn-label">${esc(s.message || 'Открываем дальше…')}</div>`));
    return bar;
  }
  const actor = s.players.find((p) => p.id === s.toActId);
  bar.append(h(`<div class="turn-label ${myTurn ? 'mine' : ''}">${myTurn ? 'Ваш ход' : 'Ходит ' + esc(actor?.name || '')}</div>`));

  if (myTurn) {
    const you = s.you;
    const acts = h(`<div class="act-row"></div>`);
    const has = (a) => you.legalActions.includes(a);
    if (has('check')) acts.append(btn('Чек', 'btn-ghost', () => emit('action', { type: 'check' })));
    if (has('call')) acts.append(btn(`Колл (${fmt(you.toCall)})`, 'btn-gold', () => emit('action', { type: 'call' })));
    if (has('allin')) acts.append(btn(`Ва-банк (${fmt(you.maxRaiseTo - (mine?.roundBet || 0))})`, 'btn-wine', () => { if (confirm('Поставить все фишки?')) emit('action', { type: 'allin' }); }));
    if (has('fold')) acts.append(btn('Пас', 'btn-ghost', () => emit('action', { type: 'fold' })));
    bar.append(acts);

    if (has('raise')) {
      if (raiseValue === null || raiseValue < you.minRaiseTo || raiseValue > you.maxRaiseTo) raiseValue = you.minRaiseTo;
      const ctl = h(`<div class="raise-ctl"></div>`);
      const range = h(`<input type="range" min="${you.minRaiseTo}" max="${you.maxRaiseTo}" step="${Math.max(1, s.currentAnte)}" value="${raiseValue}" />`);
      const amt = h(`<div class="amt">${fmt(raiseValue)}</div>`);
      const go = h(`<button class="btn-gold">Повысить</button>`);
      range.addEventListener('input', () => { raiseValue = Number(range.value); amt.textContent = fmt(raiseValue); });
      go.onclick = () => emit('action', { type: 'raise', amount: Number(range.value) });
      ctl.append(range, amt, go);
      bar.append(ctl);
    }
  }

  bar.append(timerEl(s.turnDeadline, 'Ход'));
  return bar;
}
function btn(label, cls, onclick) { const b = h(`<button class="${cls}">${label}</button>`); b.onclick = onclick; return b; }

/* ---------- SHOWDOWN ---------- */
function renderResult(s) {
  const r = s.lastResult;
  const box = h(`<div class="result-box card-panel"></div>`);
  if (!r) { box.append(h(`<div class="turn-label">Подсчёт банка…</div>`)); return box; }
  box.append(h(`<div class="kicker">Правильный ответ</div>`));
  box.append(h(`<div class="answer-reveal"><span class="big mono-num">${fmt(r.correctAnswer)}</span></div>`));

  const layers = h(`<div class="layers"></div>`);
  if (r.unopposed) {
    layers.append(h(`<div class="win">${esc(s.message || 'Банк забран без вскрытия')}</div>`));
  } else {
    r.layers.forEach((l, i) => {
      const names = l.winners.map((id) => s.players.find((p) => p.id === id)?.name || '?').join(', ');
      layers.append(h(`<div>${r.layers.length > 1 ? (i === 0 ? 'Основной банк' : 'Побочный ' + i) + ': ' : 'Банк: '}<span class="win">${fmt(l.amount)}</span> → ${esc(names)}</div>`));
    });
  }
  box.append(layers);

  // показать карту при победе без вскрытия
  const mine = me();
  if (r.unopposed && mine && r.winnings[mine.id] && !mine.showCard) {
    box.append(btn('Показать карту', 'btn-ghost', () => emit('showCard')));
  }
  if (s.question?.comment) box.append(h(`<p class="muted" style="margin-top:10px">${esc(s.question.comment)}</p>`));
  box.append(timerEl(s.showdownDeadline, 'Следующий круг'));
  return box;
}

/* ----------------------------------------------------------------- STANDINGS */
function renderStandings() {
  const s = state;
  const el = h(`<div class="standings card-panel"><h2 class="logo">Положение за столом</h2></div>`);
  const sorted = [...s.players].sort((a, b) => b.chips - a.chips);
  sorted.forEach((p, i) => {
    const d = s.lastResult?.delta?.[p.id] ?? 0;
    const dcls = d > 0 ? 'up' : d < 0 ? 'down' : 'zero';
    const dtxt = d > 0 ? `+${fmt(d)}` : d < 0 ? fmt(d) : '0';
    el.append(h(`
      <div class="srow">
        <div class="rank">${i + 1}</div>
        <div class="sname">${esc(p.name)}${p.isYou ? ' <span class="muted">(вы)</span>' : ''}${p.eliminated ? ' <span class="mini off">выбыл</span>' : ''}</div>
        <div class="schips mono-num">${fmt(p.chips)}</div>
        <div class="delta ${dcls}">${dtxt}</div>
      </div>`));
  });
  if (s.message) el.append(h(`<p class="muted center" style="margin-top:6px">${esc(s.message)}</p>`));
  el.append(timerEl(s.standingsDeadline, 'Следующий раунд через'));
  $app.append(el);
  startTicker();
}

/* ----------------------------------------------------------------- END */
function renderEnd() {
  const s = state;
  const champ = [...s.players].sort((a, b) => b.chips - a.chips)[0];
  const el = h(`
    <div class="endscreen card-panel">
      <div class="crown">👑</div>
      <div class="kicker">Победитель турнира</div>
      <div class="champ logo">${esc(champ?.name || '')}</div>
      <div class="muted mono-num">Финальный стек: ${fmt(champ?.chips || 0)}</div>
      <div class="act-row" style="margin-top:26px" id="endActions"></div>
    </div>`);
  const acts = el.querySelector('#endActions');
  if (state.isHost) {
    acts.append(btn('Новая игра', 'btn-gold', () => emit('playAgain', { toLobby: false })));
    acts.append(btn('Настроить в лобби', 'btn-ghost', () => emit('playAgain', { toLobby: true })));
  } else {
    acts.append(h(`<div class="turn-label" style="width:100%">Ждём, пока хост начнёт новую игру…</div>`));
  }
  acts.append(btn('Выйти', 'btn-ghost', resetToHome));
  $app.append(el);
}

/* ----------------------------------------------------------------- таймеры (обратный отсчёт) */
let tickRaf = null;
function timerEl(deadline, label) {
  const wrap = h(`<div class="timer" data-deadline="${deadline ?? ''}"><span class="tlabel">${label}</span><div class="bar"><i></i></div><span class="tval">—</span></div>`);
  return wrap;
}
function startTicker() {
  if (tickRaf) cancelAnimationFrame(tickRaf);
  const loop = () => {
    document.querySelectorAll('.timer[data-deadline]').forEach((t) => {
      const dl = Number(t.dataset.deadline);
      if (!dl) return;
      const left = Math.max(0, dl - Date.now());
      const total = guessTotal(t);
      const pct = total ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
      t.querySelector('i').style.width = pct + '%';
      t.querySelector('.tval').textContent = (left / 1000).toFixed(left < 10000 ? 1 : 0) + ' с';
      t.classList.toggle('low', left < 10000);
    });
    tickRaf = requestAnimationFrame(loop);
  };
  loop();
}
function guessTotal(t) {
  const s = state; if (!s) return 0;
  const dl = Number(t.dataset.deadline);
  if (dl === s.turnDeadline) return s.settings.turnTimerMs;
  if (dl === s.answerDeadline) return s.settings.answerTimerMs;
  if (dl === s.showdownDeadline) return s.settings.showdownDisplayMs;
  if (dl === s.standingsDeadline) return s.settings.standingsDisplayMs;
  return 0;
}

render();
