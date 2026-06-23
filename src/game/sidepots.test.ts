import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSidePots, type PotPlayer } from './sidepots.js';

const P = (
  id: string,
  seat: number,
  committed: number,
  answer: number | null,
  folded = false,
): PotPlayer => ({ id, seat, committed, answer, folded });

// Сценарии из раздела 6.4 ТЗ — исполнитель обязан их пройти.

test('6.4 #1 — все вложили поровну, ближайший берёт всё', () => {
  const { winnings } = computeSidePots(
    [P('A', 0, 20, 24), P('B', 1, 20, 30), P('C', 2, 20, 50)],
    26,
  );
  assert.equal(winnings.A, 60);
  assert.equal(winnings.B, 0);
  assert.equal(winnings.C, 0);
});

test('6.4 #2 — олл-ин 20 (ближайший) берёт основной, побочный уходит B', () => {
  const { winnings } = computeSidePots(
    [P('A', 0, 20, 25), P('B', 1, 100, 30), P('C', 2, 100, 40)],
    26,
  );
  assert.equal(winnings.A, 60); // основной банк
  assert.equal(winnings.B, 160); // побочный
  assert.equal(winnings.C, 0);
});

test('6.4 #3 — олл-ин 20 (далёкий), B забирает оба слоя = 220', () => {
  const { winnings } = computeSidePots(
    [P('A', 0, 20, 50), P('B', 1, 100, 27), P('C', 2, 100, 40)],
    26,
  );
  assert.equal(winnings.A, 0);
  assert.equal(winnings.B, 220);
  assert.equal(winnings.C, 0);
});

test('6.4 #4 — ничья по расстоянию, банк делится поровну 30/30', () => {
  const { winnings } = computeSidePots([P('A', 0, 30, 24), P('B', 1, 30, 28)], 26);
  assert.equal(winnings.A, 30);
  assert.equal(winnings.B, 30);
});

test('6.4 #5 — ничья с неделимым остатком, лишняя фишка игроку с меньшим местом', () => {
  // Три по 25, A и B в ничью (dist 2), C далёк. Слой 75, делим на 2 -> 38/37.
  const { winnings } = computeSidePots(
    [P('A', 0, 25, 24), P('B', 1, 25, 28), P('C', 2, 25, 100)],
    26,
  );
  assert.equal(winnings.A, 38); // меньшее место получает остаток
  assert.equal(winnings.B, 37);
  assert.equal(winnings.C, 0);
});

test('6.4 #6 — спасовавший с лучшим ответом выиграть не может', () => {
  const { winnings } = computeSidePots(
    [P('A', 0, 20, 24, true), P('B', 1, 20, 30), P('C', 2, 20, 50)],
    26,
  );
  assert.equal(winnings.A, 0); // спасовал — банк уходит ближайшему из оставшихся
  assert.equal(winnings.B, 60);
  assert.equal(winnings.C, 0);
});

test('доп. — невостребованный олл-ин-овербет возвращается вкладчику', () => {
  // A переставил всех, но один остался и спасовал ниже — верхний слой A не востребован.
  const { winnings, layers } = computeSidePots(
    [P('A', 0, 200, 27), P('B', 1, 50, 30, true)],
    26,
  );
  // Слой до 50: 100 фишек, претендент только A (B спасовал) -> A берёт 100.
  // Слой 50..200: 150 фишек, только A, не спасовал -> A берёт 150. Итого 250 (вернулись его же).
  assert.equal(winnings.A, 250);
  assert.equal(winnings.B, 0);
  assert.equal(layers.length, 2);
});
