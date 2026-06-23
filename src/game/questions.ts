import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Question } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = join(__dirname, '..', '..', 'questions.json');

let cache: Question[] | null = null;

/** Загружает вопросы из questions.json в память (один раз при старте). */
export function loadQuestions(): Question[] {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8'));
  const list: any[] = Array.isArray(raw) ? raw : raw.questions;
  if (!Array.isArray(list)) {
    throw new Error('questions.json: ожидался массив questions');
  }
  cache = list
    .filter((q) => typeof q.answer === 'number' && q.text)
    .map((q) => ({
      id: q.id,
      text: String(q.text),
      hints: Array.isArray(q.hints) ? q.hints.slice(0, 2).map(String) : [],
      answer: q.answer,
      comment: q.comment ?? null,
    }));
  if (cache.length === 0) throw new Error('questions.json: нет валидных вопросов');
  return cache;
}

/** Случайный вопрос, ещё не использованный в этом турнире (или null, если закончились). */
export function pickQuestion(used: Set<number>): Question | null {
  const all = loadQuestions();
  const pool = all.filter((q) => !used.has(q.id));
  if (pool.length === 0) return null;
  const q = pool[Math.floor(Math.random() * pool.length)];
  return q;
}
