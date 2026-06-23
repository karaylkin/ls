// Общие типы игры «Числовой покер».

export type Phase =
  | 'LOBBY'
  | 'ANSWERING'
  | 'BETTING'
  | 'SHOWDOWN'
  | 'STANDINGS'
  | 'TOURNAMENT_END';

export type ActionType = 'check' | 'call' | 'raise' | 'fold' | 'allin';

export interface Settings {
  startingChips: number;
  ante: number;
  anteDoubleEveryRounds: number;
  anteCap: number | null;
  turnTimerMs: number;
  answerTimerMs: number;
  maxRaisesPerRound: number;
  showdownDisplayMs: number;
  standingsDisplayMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  startingChips: 25000,
  ante: 500,
  anteDoubleEveryRounds: 1,
  anteCap: null,
  turnTimerMs: 60_000,
  answerTimerMs: 180_000,
  maxRaisesPerRound: 3,
  showdownDisplayMs: 4_000,
  standingsDisplayMs: 5_500,
};

export interface Question {
  id: number;
  text: string;
  hints: string[]; // ровно 2
  answer: number;
  comment?: string | null;
}

export interface Player {
  id: string;
  sessionToken: string;
  name: string;
  seat: number;

  chips: number;
  connected: boolean;
  eliminated: boolean;
  ready: boolean; // готовность в лобби

  // Состояние раунда:
  folded: boolean;
  allIn: boolean;
  committed: number; // суммарный вклад за раунд (анте + все ставки)
  roundBet: number; // вклад в текущем круге ставок
  answer: number | null;
  answerLocked: boolean;
  showCard: boolean;
  hasActedOnce: boolean; // ходил ли вообще в текущем круге

  chipsAtRoundStart: number; // для расчёта delta на STANDINGS
  socketId: string | null;
}

// Результат раздачи (для SHOWDOWN / STANDINGS).
export interface PotLayer {
  amount: number;
  eligible: string[]; // id игроков, претендовавших на слой
  winners: string[]; // id победителей слоя
  refunded: boolean; // слой возвращён (не было претендентов)
}

export interface RoundResult {
  correctAnswer: number;
  unopposed: boolean;
  winnings: Record<string, number>;
  layers: Array<{ amount: number; eligible: string[]; winners: string[] }>;
  chipsAfter: Record<string, number>;
  delta: Record<string, number>;
}

// --- Протокол: клиент -> сервер ---
export interface CreateRoomPayload {
  name: string;
  settings?: Partial<Settings>;
}
export interface JoinRoomPayload {
  code: string;
  name: string;
  sessionToken?: string;
}
export interface ActionPayload {
  type: ActionType;
  amount?: number; // итоговый roundBet для raise
}

// --- Протокол: сервер -> клиент: персонализированное состояние (раздел 15) ---
export interface ClientPlayerView {
  id: string;
  name: string;
  seat: number;
  chips: number;
  connected: boolean;
  eliminated: boolean;
  ready: boolean;
  folded: boolean;
  allIn: boolean;
  committed: number;
  roundBet: number;
  answerLocked: boolean;
  answer: number | null;
  showCard: boolean;
  isYou: boolean;
  isDealer: boolean;
  isToAct: boolean;
}

export interface ClientYouHints {
  legalActions: ActionType[];
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface ClientState {
  phase: Phase;
  code: string;
  youId: string;
  hostId: string;
  isHost: boolean;
  roundNumber: number;
  settings: Settings;
  currentAnte: number;
  pot: number;
  currentBet: number;
  bettingRoundIndex: number;
  hintsRevealed: number;
  answerRevealed: boolean;
  dealerSeat: number;
  toActId: string | null;
  turnDeadline: number | null;
  answerDeadline: number | null;
  showdownDeadline: number | null;
  standingsDeadline: number | null;
  question: {
    text: string;
    hints: string[];
    answer: number | null;
    comment?: string | null;
  } | null;
  players: ClientPlayerView[];
  you: ClientYouHints | null;
  lastResult: RoundResult | null;
  message: string | null;
}
