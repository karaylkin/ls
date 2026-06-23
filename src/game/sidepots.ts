// Алгоритм побочных банков (раздел 6.4 ТЗ). Реализован строго по описанию.

export interface PotPlayer {
  id: string;
  seat: number;
  committed: number; // суммарный вклад за раунд
  folded: boolean;
  answer: number | null; // null => не вписал ответ (не может выиграть)
}

export interface PotLayerResult {
  amount: number;
  eligible: string[]; // id игроков, претендовавших на слой (не спасовавшие, с ответом)
  winners: string[]; // id победителей слоя
  refunded: boolean; // true, если в слое не было претендентов и он возвращён вкладчикам
}

export interface SidePotResult {
  winnings: Record<string, number>; // id -> сколько фишек получено
  layers: PotLayerResult[];
}

function distance(answer: number | null, correct: number): number {
  return answer === null ? Number.POSITIVE_INFINITY : Math.abs(answer - correct);
}

/**
 * Делит банк на слои по уровням вкладов и распределяет каждый слой
 * ближайшему(им) по модулю среди не спасовавших участников слоя.
 * Ничья — поровну, неделимый остаток — игрокам с меньшим номером места.
 * Слой без претендентов (все спасовали/без ответа) возвращается вкладчикам.
 */
export function computeSidePots(players: PotPlayer[], correct: number): SidePotResult {
  const winnings: Record<string, number> = {};
  for (const p of players) winnings[p.id] = 0;

  const levels = Array.from(
    new Set(players.filter((p) => p.committed > 0).map((p) => p.committed)),
  ).sort((a, b) => a - b);

  const layers: PotLayerResult[] = [];
  let prev = 0;

  for (const level of levels) {
    const slice = level - prev;
    const inLayer = players.filter((p) => p.committed >= level);
    const amount = slice * inLayer.length;

    const eligible = inLayer.filter((p) => !p.folded && p.answer !== null);

    if (eligible.length === 0) {
      // Невостребованный слой: возвращаем вкладчикам их долю (slice каждому).
      for (const p of inLayer) winnings[p.id] += slice;
      layers.push({ amount, eligible: [], winners: [], refunded: true });
      prev = level;
      continue;
    }

    let minDist = Number.POSITIVE_INFINITY;
    for (const p of eligible) minDist = Math.min(minDist, distance(p.answer, correct));

    const winners = eligible
      .filter((p) => distance(p.answer, correct) === minDist)
      .sort((a, b) => a.seat - b.seat);

    const base = Math.floor(amount / winners.length);
    const remainder = amount - base * winners.length;
    winners.forEach((w, i) => {
      winnings[w.id] += base + (i < remainder ? 1 : 0); // остаток — игрокам с меньшим местом
    });

    layers.push({
      amount,
      eligible: eligible.map((p) => p.id),
      winners: winners.map((p) => p.id),
      refunded: false,
    });
    prev = level;
  }

  return { winnings, layers };
}
