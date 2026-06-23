// Бот для ручной проверки UI: присоединяется к лобби по коду и авто-играет.
// node scripts/bot.mjs <CODE> <PORT> <ANSWER>
import { io } from 'socket.io-client';
const [code, port = '3000', answer = '50'] = process.argv.slice(2);
const sock = io(`http://localhost:${port}`, { transports: ['websocket'] });
let id = null;
sock.on('joined', (j) => { id = j.playerId; console.log('bot joined', j.code); });
sock.on('state', (s) => {
  if (s.phase === 'ANSWERING') {
    const me = s.players.find((p) => p.isYou);
    if (me && !me.answerLocked && !me.folded) sock.emit('lockAnswer', { value: Number(answer) });
  } else if (s.phase === 'BETTING' && s.toActId === id && s.you) {
    const a = s.you.legalActions;
    const move = a.includes('check') ? 'check' : 'call';
    setTimeout(() => sock.emit('action', { type: move }), 300);
  }
});
sock.on('error', (e) => console.log('bot error', e.message));
sock.emit('joinRoom', { code, name: 'Бот-Борис' });
process.on('SIGTERM', () => sock.close());
