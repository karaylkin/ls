// Интеграционный прогон: два бота играют полный раунд через реальный сокет.
// Запуск: node scripts/smoke.mjs  (сервер поднимается автоматически)
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3411;
const URL = `http://localhost:${PORT}`;

const server = spawn('npx', ['tsx', 'src/server.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error('❌ ' + msg);
  console.error('--- server log ---\n' + serverLog);
  server.kill();
  process.exit(1);
};

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(URL + '/health');
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  fail('сервер не поднялся');
}

function bot(name) {
  const sock = io(URL, { transports: ['websocket'] });
  const b = { sock, name, state: null, joined: null, errors: [], sfx: [] };
  sock.on('state', (s) => (b.state = s));
  sock.on('joined', (j) => (b.joined = j));
  sock.on('error', (e) => b.errors.push(e.message));
  sock.on('sfx', (s) => b.sfx.push(s.name));
  return b;
}

const until = async (pred, label, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(50);
  }
  fail('таймаут ожидания: ' + label);
};

async function main() {
  await waitHealth();

  const a = bot('Алиса');
  const c = bot('Боб');

  a.sock.emit('createRoom', { name: 'Алиса', settings: { answerTimerMs: 60000, turnTimerMs: 30000, showdownDisplayMs: 800, standingsDisplayMs: 800 } });
  await until(() => a.joined, 'A joined');
  const code = a.joined.code;
  console.log('  лобби:', code);

  c.sock.emit('joinRoom', { code, name: 'Боб' });
  await until(() => c.joined, 'C joined');

  await until(() => a.state && a.state.players.length === 2, 'оба в лобби');
  if (a.state.hostId !== a.joined.playerId) fail('Алиса должна быть хостом');

  // Старт
  a.sock.emit('startGame');
  await until(() => a.state.phase === 'ANSWERING', 'фаза ANSWERING');
  console.log('  раунд', a.state.roundNumber, 'анте', a.state.currentAnte, 'банк', a.state.pot);
  if (a.state.pot !== a.state.currentAnte * 2) fail('банк после анте неверный');

  // Никто не должен видеть чужой ответ
  // Фиксируем ответы
  a.sock.emit('lockAnswer', { value: 25 });
  c.sock.emit('lockAnswer', { value: 40 });
  await until(() => a.state.phase === 'BETTING', 'фаза BETTING #1');

  // Проверка скрытия: Алиса не видит ответ Боба
  const bobView = a.state.players.find((p) => !p.isYou);
  if (bobView.answer !== null) fail('чужой ответ утёк до вскрытия!');

  // Прогон 4 кругов ставок: каждый чек/колл, доводим до вскрытия
  let guard = 0;
  while (a.state.phase === 'BETTING' && guard++ < 40) {
    const actor = [a, c].find((b) => b.state.toActId === b.joined.playerId && b.state.you);
    if (!actor) {
      await sleep(60);
      continue;
    }
    const legal = actor.state.you.legalActions;
    const move = legal.includes('check') ? 'check' : 'call';
    actor.sock.emit('action', { type: move });
    await sleep(80);
  }

  await until(() => a.state.phase === 'SHOWDOWN' || a.state.phase === 'STANDINGS', 'вскрытие');
  // На вскрытии правильный ответ виден
  if (!a.state.lastResult) fail('нет результата раздачи');
  const correct = a.state.lastResult.correctAnswer;
  console.log('  правильный ответ:', correct);

  // Ближайший к правильному выигрывает (25 vs 40)
  const winnerId = Object.entries(a.state.lastResult.winnings).sort((x, y) => y[1] - x[1])[0][0];
  const distA = Math.abs(25 - correct);
  const distC = Math.abs(40 - correct);
  const expected = distA <= distC ? a.joined.playerId : c.joined.playerId;
  if (winnerId !== expected) fail(`победитель неверный: ожидался ${expected}, получен ${winnerId}`);
  console.log('  победитель верный ✓ выигрыш', a.state.lastResult.winnings[winnerId]);

  // На вскрытии чужой ответ теперь виден
  await until(() => {
    const bv = a.state.players.find((p) => !p.isYou);
    return bv && bv.answer === 40;
  }, 'ответ Боба раскрыт на вскрытии');

  // Дожидаемся следующего раунда (авто-старт)
  await until(() => a.state.phase === 'ANSWERING' && a.state.roundNumber === 2, 'авто-старт раунда 2', 8000);
  console.log('  авто-старт раунда 2 ✓ анте', a.state.currentAnte);
  if (a.state.currentAnte !== 1000) fail('анте не удвоилось (ожидалось 1000)');

  if (a.errors.length || c.errors.length) {
    console.log('  ⚠ ошибки:', [...a.errors, ...c.errors]);
  }

  console.log('\n✅ Интеграционный прогон пройден');
  a.sock.close();
  c.sock.close();
  server.kill();
  process.exit(0);
}

main().catch((e) => fail('исключение: ' + (e?.stack || e)));
