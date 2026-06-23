import { randomBytes, randomUUID } from 'node:crypto';

// Без неоднозначных символов (нет O/0/I/1).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(len = 5): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function makeId(): string {
  return randomUUID();
}

export function makeToken(): string {
  return randomBytes(24).toString('hex');
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
