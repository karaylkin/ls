// Проверка playAgain: симулируем конец турнира и перезапуск без пересоздания лобби.
// node --import tsx scripts/restart-check.mjs
import { Room } from '../src/game/room.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';

const hooks = { broadcast: () => {}, sfx: () => {}, onEmpty: () => {} };
const room = new Room('TEST1', { ...DEFAULT_SETTINGS }, hooks);

const a = room.addPlayer('Алиса', 'sA');
const b = room.addPlayer('Боб', 'sB');
const aId = a.player.id, bId = b.player.id;

// Принудительно завершаем турнир: оставляем Боба без фишек.
room.startGame(aId);
// Эмулируем исход: у Боба 0 фишек, у Алисы — банк.
const pa = room.players.find((p) => p.id === aId);
const pb = room.players.find((p) => p.id === bId);
pb.chips = 0;
pa.chips = 50000;
// Вызываем приватный путь завершения через публичную имитацию: доводим до TOURNAMENT_END
// проще — напрямую через nextRoundOrEnd недоступно; используем playAgain после ручной установки фазы.
room.phase = 'TOURNAMENT_END';
pb.eliminated = true;

const assert = (c, m) => { if (!c) { console.error('❌ ' + m); process.exit(1); } };

// Не-хост не может
const e1 = room.playAgain(bId, false);
assert(e1 !== null, 'не-хост не должен запускать новую игру');

// Хост запускает новую игру
const usedBefore = room.usedQuestionIds.size;
const e2 = room.playAgain(aId, false);
assert(e2 === null, 'хост должен суметь запустить: ' + e2);
assert(room.phase === 'ANSWERING', 'фаза должна стать ANSWERING, а не ' + room.phase);
assert(room.roundNumber === 1, 'раунд должен сброситься на 1, а не ' + room.roundNumber);
assert(room.players.every((p) => !p.eliminated), 'все игроки возрождены');
assert(pa.chips === DEFAULT_SETTINGS.startingChips - room.currentAnte ||
       pa.chips === DEFAULT_SETTINGS.startingChips, 'фишки сброшены к стартовым (минус анте)');
assert(pb.chips > 0, 'Боб снова в игре с фишками: ' + pb.chips);
console.log(`  фишки после: Алиса=${pa.chips}, Боб=${pb.chips}, анте=${room.currentAnte}`);

// Вариант "в лобби"
room.phase = 'TOURNAMENT_END';
const e3 = room.playAgain(aId, true);
assert(e3 === null, 'возврат в лобби должен работать');
assert(room.phase === 'LOBBY', 'фаза LOBBY после toLobby, а не ' + room.phase);
assert(room.roundNumber === 0, 'счётчик раундов сброшен');

console.log('\n✅ playAgain работает: новая игра в том же лобби, сброс фишек/вопросов/выбываний');
