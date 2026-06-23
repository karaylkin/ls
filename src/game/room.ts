import {
  type ActionType,
  type ClientState,
  type ClientPlayerView,
  type ClientYouHints,
  type Phase,
  type Player,
  type Question,
  type RoundResult,
  type Settings,
  DEFAULT_SETTINGS,
} from '../types.js';
import { computeSidePots, type PotPlayer } from './sidepots.js';
import { pickQuestion } from './questions.js';
import { makeId, makeToken, clamp } from '../util.js';

export interface RoomHooks {
  broadcast: () => void;
  sfx: (name: string, targetId?: string) => void;
  onEmpty: () => void; // комната опустела — менеджер удалит
}

const MAX_PLAYERS = 6;

export class Room {
  code: string;
  settings: Settings;
  players: Player[] = [];
  hostId: string | null = null;

  phase: Phase = 'LOBBY';
  roundNumber = 0;
  question: Question | null = null;
  usedQuestionIds = new Set<number>();

  currentAnte = 0;
  currentBet = 0;
  bettingRoundIndex = 0;
  hintsRevealed = 0;
  answerRevealed = false;
  dealerSeat = -1;
  toActId: string | null = null;

  minRaiseStep = 0;
  raisesThisRound = 0;
  private actedSinceRaise = new Set<string>();

  lastResult: RoundResult | null = null;
  message: string | null = null;

  turnDeadline: number | null = null;
  answerDeadline: number | null = null;
  showdownDeadline: number | null = null;
  standingsDeadline: number | null = null;

  private turnTimer: NodeJS.Timeout | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;

  private hooks: RoomHooks;

  constructor(code: string, settings: Settings, hooks: RoomHooks) {
    this.code = code;
    this.settings = settings;
    this.hooks = hooks;
  }

  // ----------------------------------------------------------------- helpers

  private participants(): Player[] {
    return this.players.filter((p) => !p.eliminated);
  }

  private byId(id: string | null): Player | undefined {
    if (!id) return undefined;
    return this.players.find((p) => p.id === id);
  }

  private eligible(p: Player): boolean {
    return !p.eliminated && !p.folded && !p.allIn && p.chips > 0;
  }

  private contenders(): Player[] {
    return this.participants().filter((p) => !p.folded);
  }

  private pot(): number {
    return this.players.reduce((s, p) => s + p.committed, 0);
  }

  /** Игроки по часовой стрелке, начиная сразу после `afterSeat`. */
  private clockwiseFrom(afterSeat: number, pred: (p: Player) => boolean): Player | null {
    const sorted = [...this.participants()].sort((a, b) => a.seat - b.seat);
    const after = sorted.filter((p) => p.seat > afterSeat);
    const before = sorted.filter((p) => p.seat <= afterSeat);
    return [...after, ...before].find(pred) ?? null;
  }

  private needsToAct(p: Player): boolean {
    return this.eligible(p) && (!this.actedSinceRaise.has(p.id) || p.roundBet < this.currentBet);
  }

  // ---------------------------------------------------------------- timers

  private clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnDeadline = null;
  }
  private clearPhaseTimer() {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
  }
  private clearAllTimers() {
    this.clearTurnTimer();
    this.clearPhaseTimer();
    this.answerDeadline = null;
    this.showdownDeadline = null;
    this.standingsDeadline = null;
  }

  // ---------------------------------------------------------------- lobby

  addPlayer(name: string, socketId: string): { player: Player } | { error: string } {
    if (this.phase !== 'LOBBY') return { error: 'Игра уже идёт' };
    if (this.participants().length >= MAX_PLAYERS) return { error: 'Лобби заполнено' };
    const usedSeats = new Set(this.players.map((p) => p.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;
    const player: Player = {
      id: makeId(),
      sessionToken: makeToken(),
      name: name.slice(0, 20) || `Игрок ${seat + 1}`,
      seat,
      chips: this.settings.startingChips,
      connected: true,
      eliminated: false,
      ready: false,
      folded: false,
      allIn: false,
      committed: 0,
      roundBet: 0,
      answer: null,
      answerLocked: false,
      showCard: false,
      hasActedOnce: false,
      chipsAtRoundStart: this.settings.startingChips,
      socketId,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    this.hooks.sfx('lobby_join');
    this.hooks.broadcast();
    return { player };
  }

  reconnect(sessionToken: string, socketId: string): Player | null {
    const p = this.players.find((x) => x.sessionToken === sessionToken);
    if (!p) return null;
    p.connected = true;
    p.socketId = socketId;
    this.hooks.broadcast();
    return p;
  }

  setReady(playerId: string, ready: boolean) {
    const p = this.byId(playerId);
    if (!p || this.phase !== 'LOBBY') return;
    p.ready = ready;
    this.hooks.broadcast();
  }

  updateSettings(playerId: string, patch: Partial<Settings>): string | null {
    if (playerId !== this.hostId) return 'Только хост может менять настройки';
    if (this.phase !== 'LOBBY') return 'Настройки меняются только в лобби';
    const s = this.settings;
    const next: Settings = { ...s };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (patch[k] === undefined || patch[k] === null) {
        if (k === 'anteCap' && patch[k] === null) next.anteCap = null;
        continue;
      }
      const v = patch[k] as number;
      if (typeof v === 'number' && Number.isFinite(v)) (next[k] as number) = v;
    }
    // Стартовый стек применяем сразу к сидящим игрокам.
    if (next.startingChips !== s.startingChips) {
      for (const p of this.players) {
        p.chips = next.startingChips;
        p.chipsAtRoundStart = next.startingChips;
      }
    }
    this.settings = next;
    this.hooks.broadcast();
    return null;
  }

  startGame(playerId: string): string | null {
    if (playerId !== this.hostId) return 'Только хост может начать игру';
    if (this.phase !== 'LOBBY') return 'Игра уже идёт';
    if (this.participants().length < 2) return 'Нужно минимум 2 игрока';
    this.startRound();
    return null;
  }

  // ---------------------------------------------------------------- round flow

  private anteForRound(r: number): number {
    const { ante, anteDoubleEveryRounds, anteCap } = this.settings;
    const steps = Math.floor((r - 1) / Math.max(1, anteDoubleEveryRounds));
    let value = ante * Math.pow(2, steps);
    if (anteCap != null) value = Math.min(anteCap, value);
    return Math.floor(value);
  }

  private rotateDealer() {
    const next = this.clockwiseFrom(this.dealerSeat, () => true);
    this.dealerSeat = next ? next.seat : 0;
  }

  private startRound() {
    this.clearAllTimers();
    const parts = this.participants();
    if (parts.length <= 1) return this.tournamentEnd();

    const q = pickQuestion(this.usedQuestionIds);
    if (!q) return this.tournamentEnd();
    this.usedQuestionIds.add(q.id);
    this.question = q;

    this.roundNumber++;
    this.rotateDealer();
    this.currentAnte = this.anteForRound(this.roundNumber);
    this.lastResult = null;
    this.message = null;
    this.currentBet = 0;
    this.bettingRoundIndex = 0;
    this.hintsRevealed = 0;
    this.answerRevealed = false;
    this.toActId = null;

    for (const p of parts) {
      p.folded = false;
      p.allIn = false;
      p.committed = 0;
      p.roundBet = 0;
      p.answer = null;
      p.answerLocked = false;
      p.showCard = false;
      p.hasActedOnce = false;
      p.chipsAtRoundStart = p.chips;
    }

    // Взимаем анте.
    for (const p of parts) {
      const pay = Math.min(this.currentAnte, p.chips);
      p.chips -= pay;
      p.committed += pay;
      if (p.chips === 0) p.allIn = true;
    }

    this.phase = 'ANSWERING';
    this.answerDeadline = Date.now() + this.settings.answerTimerMs;
    this.phaseTimer = setTimeout(() => this.onAnswerTimeout(), this.settings.answerTimerMs);
    this.hooks.sfx('round_start');
    this.hooks.broadcast();
  }

  lockAnswer(playerId: string, value: number) {
    if (this.phase !== 'ANSWERING') return;
    const p = this.byId(playerId);
    if (!p || p.eliminated || p.answerLocked || p.folded) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    p.answer = Math.round(value);
    p.answerLocked = true;
    this.hooks.sfx('answer_lock', p.id);
    // Если все участники зафиксировали — стартуем досрочно.
    if (this.participants().every((x) => x.answerLocked)) {
      this.proceedAfterAnswering();
    } else {
      this.hooks.broadcast();
    }
  }

  private onAnswerTimeout() {
    for (const p of this.participants()) {
      if (!p.answerLocked) p.folded = true; // авто-пас, анте сгорает
    }
    this.proceedAfterAnswering();
  }

  private proceedAfterAnswering() {
    this.clearPhaseTimer();
    this.answerDeadline = null;
    const contenders = this.contenders();
    if (contenders.length === 0) {
      // Никто не вписал — раунд несостоявшийся, анте возвращается всем.
      for (const p of this.participants()) {
        p.chips += p.committed;
        p.committed = 0;
      }
      this.message = 'Никто не вписал ответ — раунд отменён, анте возвращено.';
      this.lastResult = null;
      return this.goStandings();
    }
    this.beginBetting(0);
  }

  private beginBetting(index: number) {
    this.clearTurnTimer();
    this.bettingRoundIndex = index;
    this.currentBet = 0;
    this.minRaiseStep = this.currentAnte;
    this.raisesThisRound = 0;
    this.actedSinceRaise = new Set();
    for (const p of this.participants()) {
      p.roundBet = 0;
      p.hasActedOnce = false;
    }

    const contenders = this.contenders();
    if (contenders.length <= 1) {
      // Остался один — забирает банк без вскрытия.
      if (contenders.length === 1) return this.endHandUnopposed(contenders[0]);
      return this.doShowdown();
    }

    const ableToAct = this.participants().filter((p) => this.eligible(p));
    if (ableToAct.length <= 1) {
      // Ставить некому (все, кроме одного, в олл-ине) — круг проходит без ставок.
      this.phase = 'BETTING';
      this.toActId = null;
      this.message = 'Все в олл-ине — ставки невозможны, открываем дальше…';
      this.hooks.broadcast();
      this.phaseTimer = setTimeout(() => this.closeBettingRound(), 1600);
      return;
    }

    this.phase = 'BETTING';
    this.message = null;
    const first = this.clockwiseFrom(this.dealerSeat, (p) => this.eligible(p));
    this.setToAct(first);
    this.hooks.broadcast();
  }

  private setToAct(p: Player | null) {
    this.clearTurnTimer();
    if (!p) {
      this.toActId = null;
      return;
    }
    this.toActId = p.id;
    this.turnDeadline = Date.now() + this.settings.turnTimerMs;
    this.turnTimer = setTimeout(() => this.onTurnTimeout(), this.settings.turnTimerMs);
    this.hooks.sfx('your_turn', p.id);
  }

  private onTurnTimeout() {
    const p = this.byId(this.toActId);
    if (!p) return;
    const toCall = this.currentBet - p.roundBet;
    if (toCall <= 0) this.applyAction(p, 'check');
    else this.applyAction(p, 'fold');
  }

  // ---------------------------------------------------------------- actions

  handleAction(playerId: string, type: ActionType, amount?: number): string | null {
    if (this.phase !== 'BETTING') return 'Сейчас не время ставок';
    const p = this.byId(playerId);
    if (!p) return 'Игрок не найден';
    if (this.toActId !== p.id) return 'Сейчас не ваш ход';
    return this.applyAction(p, type, amount);
  }

  /** Возвращает строку с ошибкой либо null при успехе. */
  private applyAction(p: Player, type: ActionType, amount?: number): string | null {
    const toCall = this.currentBet - p.roundBet;

    switch (type) {
      case 'check': {
        if (toCall !== 0) return 'Нельзя чекнуть: есть ставка для уравнивания';
        this.markActed(p);
        this.hooks.sfx('check');
        break;
      }
      case 'call': {
        if (toCall <= 0) return 'Уравнивать нечего — используйте чек';
        const pay = Math.min(toCall, p.chips);
        this.commit(p, pay);
        this.markActed(p);
        this.hooks.sfx('chip_call');
        break;
      }
      case 'fold': {
        p.folded = true;
        this.actedSinceRaise.delete(p.id);
        this.hooks.sfx('fold');
        break;
      }
      case 'raise': {
        const maxRaiseTo = p.roundBet + p.chips;
        const target = Math.floor(amount ?? 0);
        if (target >= maxRaiseTo) {
          // Это фактически олл-ин.
          return this.applyAction(p, 'allin');
        }
        if (this.raisesThisRound >= this.settings.maxRaisesPerRound)
          return 'Лимит повышений исчерпан';
        const minRaiseTo = this.currentBet + this.minRaiseStep;
        if (target < minRaiseTo) return `Минимальное повышение до ${minRaiseTo}`;
        const delta = target - p.roundBet;
        if (delta > p.chips) return 'Недостаточно фишек';
        const prevBet = this.currentBet;
        this.commit(p, delta);
        this.currentBet = p.roundBet;
        this.minRaiseStep = Math.max(this.currentAnte, this.currentBet - prevBet);
        this.raisesThisRound++;
        this.reopen(p);
        this.hooks.sfx('chip_bet');
        break;
      }
      case 'allin': {
        if (p.chips <= 0) return 'Нет фишек для олл-ина';
        const prevBet = this.currentBet;
        const allInTo = p.roundBet + p.chips;
        this.commit(p, p.chips);
        if (allInTo > prevBet) {
          this.currentBet = allInTo;
          this.minRaiseStep = Math.max(this.currentAnte, allInTo - prevBet);
          this.reopen(p); // олл-ин открывает круг заново (лимит повышений не тратит)
        } else {
          this.markActed(p); // олл-ин-колл на меньшую сумму
        }
        this.hooks.sfx('all_in');
        break;
      }
      default:
        return 'Неизвестное действие';
    }

    this.advanceTurn(p);
    return null;
  }

  private commit(p: Player, amount: number) {
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.roundBet += pay;
    p.committed += pay;
    if (p.chips === 0) p.allIn = true;
  }

  private markActed(p: Player) {
    this.actedSinceRaise.add(p.id);
    p.hasActedOnce = true;
  }

  private reopen(p: Player) {
    this.actedSinceRaise = new Set([p.id]);
    p.hasActedOnce = true;
  }

  private advanceTurn(actor: Player) {
    this.clearTurnTimer();
    const contenders = this.contenders();
    if (contenders.length <= 1) {
      if (contenders.length === 1) return this.endHandUnopposed(contenders[0]);
      return this.doShowdown();
    }
    const next = this.clockwiseFrom(actor.seat, (x) => this.needsToAct(x));
    if (next) {
      this.setToAct(next);
      this.hooks.broadcast();
    } else {
      this.closeBettingRound();
    }
  }

  private closeBettingRound() {
    this.clearTurnTimer();
    this.clearPhaseTimer();
    this.toActId = null;

    const contenders = this.contenders();
    if (contenders.length <= 1) {
      if (contenders.length === 1) return this.endHandUnopposed(contenders[0]);
      return this.doShowdown();
    }

    switch (this.bettingRoundIndex) {
      case 0:
        this.hintsRevealed = 1;
        this.hooks.sfx('hint_reveal');
        this.beginBetting(1);
        break;
      case 1:
        this.hintsRevealed = 2;
        this.hooks.sfx('hint_reveal');
        this.beginBetting(2);
        break;
      case 2:
        this.answerRevealed = true;
        this.hooks.sfx('answer_reveal');
        this.beginBetting(3);
        break;
      default:
        this.doShowdown();
        break;
    }
  }

  // ---------------------------------------------------------------- resolution

  private endHandUnopposed(winner: Player) {
    this.clearAllTimers();
    const pot = this.pot();
    const before: Record<string, number> = {};
    for (const p of this.players) before[p.id] = p.chips;
    winner.chips += pot;

    const chipsAfter: Record<string, number> = {};
    const delta: Record<string, number> = {};
    for (const p of this.players) {
      chipsAfter[p.id] = p.chips;
      delta[p.id] = p.chips - p.chipsAtRoundStart;
    }
    this.lastResult = {
      correctAnswer: this.question!.answer,
      unopposed: true,
      winnings: { [winner.id]: pot },
      layers: [{ amount: pot, eligible: [winner.id], winners: [winner.id] }],
      chipsAfter,
      delta,
    };
    this.message = `${winner.name} забирает банк — все спасовали.`;
    this.phase = 'SHOWDOWN';
    this.toActId = null;
    this.showdownDeadline = Date.now() + this.settings.showdownDisplayMs;
    this.phaseTimer = setTimeout(() => this.goStandings(), this.settings.showdownDisplayMs);
    this.hooks.sfx('pot_win');
    this.hooks.broadcast();
  }

  private doShowdown() {
    this.clearAllTimers();
    this.answerRevealed = true;
    const correct = this.question!.answer;

    const potPlayers: PotPlayer[] = this.participants()
      .filter((p) => p.committed > 0)
      .map((p) => ({
        id: p.id,
        seat: p.seat,
        committed: p.committed,
        folded: p.folded,
        answer: p.answerLocked ? p.answer : null,
      }));

    const { winnings, layers } = computeSidePots(potPlayers, correct);

    for (const p of this.players) {
      const w = winnings[p.id] ?? 0;
      p.chips += w;
    }

    const chipsAfter: Record<string, number> = {};
    const delta: Record<string, number> = {};
    for (const p of this.players) {
      chipsAfter[p.id] = p.chips;
      delta[p.id] = p.chips - p.chipsAtRoundStart;
    }

    this.lastResult = {
      correctAnswer: correct,
      unopposed: false,
      winnings,
      layers: layers.map((l) => ({
        amount: l.amount,
        eligible: l.eligible,
        winners: l.winners,
      })),
      chipsAfter,
      delta,
    };
    this.message = null;
    this.phase = 'SHOWDOWN';
    this.toActId = null;
    this.showdownDeadline = Date.now() + this.settings.showdownDisplayMs;
    this.phaseTimer = setTimeout(() => this.goStandings(), this.settings.showdownDisplayMs);
    this.hooks.sfx('pot_win');
    this.hooks.broadcast();
  }

  private goStandings() {
    this.clearAllTimers();
    this.phase = 'STANDINGS';
    this.toActId = null;
    this.standingsDeadline = Date.now() + this.settings.standingsDisplayMs;
    this.phaseTimer = setTimeout(() => this.nextRoundOrEnd(), this.settings.standingsDisplayMs);
    this.hooks.broadcast();
  }

  private nextRoundOrEnd() {
    this.clearAllTimers();
    for (const p of this.participants()) {
      if (p.chips <= 0) {
        p.eliminated = true;
        this.hooks.sfx('player_out');
      }
    }
    const remaining = this.participants();
    if (remaining.length <= 1) return this.tournamentEnd();
    this.startRound();
  }

  private tournamentEnd() {
    this.clearAllTimers();
    this.phase = 'TOURNAMENT_END';
    this.toActId = null;
    const alive = this.participants();
    const winner = [...this.players].sort((a, b) => b.chips - a.chips)[0];
    const champ = alive.length === 1 ? alive[0] : winner;
    this.message = champ ? `🏆 Победитель турнира: ${champ.name}` : 'Турнир окончен';
    this.hooks.sfx('tournament_win');
    this.hooks.broadcast();
  }

  // ---------------------------------------------------------------- showCard

  showCard(playerId: string) {
    if (this.phase !== 'SHOWDOWN') return;
    const p = this.byId(playerId);
    if (!p) return;
    // Раскрыть карту можно при победе без вскрытия (unopposed).
    if (this.lastResult?.unopposed && this.lastResult.winnings[p.id]) {
      p.showCard = true;
      this.hooks.broadcast();
    }
  }

  // ---------------------------------------------------------------- connection

  onDisconnect(socketId: string) {
    const p = this.players.find((x) => x.socketId === socketId);
    if (!p) return;
    p.connected = false;
    p.socketId = null;

    // В лобби отключившийся до старта игрок убирается с места.
    if (this.phase === 'LOBBY') {
      this.players = this.players.filter((x) => x.id !== p.id);
    }

    // Передача роли хоста.
    if (this.hostId === p.id) {
      const next = this.players.find((x) => x.connected && !x.eliminated);
      this.hostId = next ? next.id : this.players.find((x) => x.connected)?.id ?? null;
    }

    if (!this.players.some((x) => x.connected)) {
      this.clearAllTimers();
      this.hooks.onEmpty();
      return;
    }
    this.hooks.broadcast();
  }

  closeLobby(playerId: string): boolean {
    if (playerId !== this.hostId) return false;
    this.clearAllTimers();
    return true;
  }

  isEmpty(): boolean {
    return !this.players.some((x) => x.connected);
  }

  // ---------------------------------------------------------------- serialization

  buildState(viewerId: string): ClientState {
    const revealAll =
      (this.phase === 'SHOWDOWN' || this.phase === 'STANDINGS') &&
      !!this.lastResult &&
      !this.lastResult.unopposed;

    const players: ClientPlayerView[] = [...this.players]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => {
        const showAnswer =
          p.id === viewerId || p.showCard || (revealAll && !p.folded);
        return {
          id: p.id,
          name: p.name,
          seat: p.seat,
          chips: p.chips,
          connected: p.connected,
          eliminated: p.eliminated,
          ready: p.ready,
          folded: p.folded,
          allIn: p.allIn,
          committed: p.committed,
          roundBet: p.roundBet,
          answerLocked: p.answerLocked,
          answer: showAnswer ? p.answer : null,
          showCard: p.showCard,
          isYou: p.id === viewerId,
          isDealer: p.seat === this.dealerSeat,
          isToAct: p.id === this.toActId,
        };
      });

    const viewer = this.byId(viewerId);
    const you = viewer ? this.computeYou(viewer) : null;

    const question = this.question
      ? {
          text: this.question.text,
          hints: this.question.hints.slice(0, this.hintsRevealed),
          answer: this.answerRevealed ? this.question.answer : null,
          comment: this.answerRevealed ? this.question.comment ?? null : null,
        }
      : null;

    return {
      phase: this.phase,
      code: this.code,
      youId: viewerId,
      hostId: this.hostId ?? '',
      isHost: viewerId === this.hostId,
      roundNumber: this.roundNumber,
      settings: this.settings,
      currentAnte: this.currentAnte,
      pot: this.pot(),
      currentBet: this.currentBet,
      bettingRoundIndex: this.bettingRoundIndex,
      hintsRevealed: this.hintsRevealed,
      answerRevealed: this.answerRevealed,
      dealerSeat: this.dealerSeat,
      toActId: this.toActId,
      turnDeadline: this.turnDeadline,
      answerDeadline: this.answerDeadline,
      showdownDeadline: this.showdownDeadline,
      standingsDeadline: this.standingsDeadline,
      question,
      players,
      you,
      lastResult: this.lastResult,
      message: this.message,
    };
  }

  private computeYou(p: Player): ClientYouHints | null {
    if (this.phase !== 'BETTING' || this.toActId !== p.id) return null;
    const toCall = Math.max(0, this.currentBet - p.roundBet);
    const maxRaiseTo = p.roundBet + p.chips;
    const minRaiseTo = this.currentBet + this.minRaiseStep;
    const canRaise =
      this.raisesThisRound < this.settings.maxRaisesPerRound &&
      p.chips > 0 &&
      maxRaiseTo > this.currentBet &&
      maxRaiseTo >= minRaiseTo;

    const legal: ActionType[] = [];
    if (toCall === 0) legal.push('check');
    else if (p.chips > 0) legal.push('call');
    if (canRaise) legal.push('raise');
    if (p.chips > 0) legal.push('allin');
    legal.push('fold');

    return {
      legalActions: legal,
      toCall,
      minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
      maxRaiseTo,
    };
  }
}
