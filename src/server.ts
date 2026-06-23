import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RoomManager } from './game/roomManager.js';
import { loadQuestions } from './game/questions.js';
import type {
  ActionPayload,
  CreateRoomPayload,
  JoinRoomPayload,
  Settings,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, questions: loadQuestions().length }));

const manager = new RoomManager(io);

function err(socket: import('socket.io').Socket, message: string) {
  socket.emit('error', { message });
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload: CreateRoomPayload) => {
    try {
      const name = String(payload?.name ?? '').trim();
      if (!name) return err(socket, 'Введите имя');
      const room = manager.createRoom(payload?.settings);
      const result = room.addPlayer(name, socket.id);
      if ('error' in result) {
        manager.removeRoom(room.code);
        return err(socket, result.error);
      }
      const player = result.player;
      manager.registerSocket(socket.id, room.code, player.id);
      socket.join(room.code);
      socket.emit('joined', {
        playerId: player.id,
        sessionToken: player.sessionToken,
        code: room.code,
      });
      manager.broadcastRoom(room.code, []);
    } catch (e) {
      err(socket, 'Не удалось создать лобби');
    }
  });

  socket.on('joinRoom', (payload: JoinRoomPayload) => {
    try {
      const code = String(payload?.code ?? '').trim().toUpperCase();
      const room = manager.get(code);
      if (!room) return err(socket, 'Лобби не найдено');

      // Переподключение по токену.
      if (payload?.sessionToken) {
        const p = room.reconnect(payload.sessionToken, socket.id);
        if (p) {
          manager.registerSocket(socket.id, code, p.id);
          socket.join(code);
          socket.emit('joined', { playerId: p.id, sessionToken: p.sessionToken, code });
          manager.broadcastRoom(code, []);
          return;
        }
      }

      const name = String(payload?.name ?? '').trim();
      if (!name) return err(socket, 'Введите имя');
      const result = room.addPlayer(name, socket.id);
      if ('error' in result) return err(socket, result.error);
      const player = result.player;
      manager.registerSocket(socket.id, code, player.id);
      socket.join(code);
      socket.emit('joined', {
        playerId: player.id,
        sessionToken: player.sessionToken,
        code,
      });
      manager.broadcastRoom(code, []);
    } catch (e) {
      err(socket, 'Не удалось войти в лобби');
    }
  });

  const withRoom = (fn: (room: import('./game/room.js').Room, playerId: string) => void) => {
    const info = manager.lookupSocket(socket.id);
    if (!info) return err(socket, 'Вы не в лобби');
    const room = manager.get(info.code);
    if (!room) return err(socket, 'Лобби больше не существует');
    fn(room, info.playerId);
  };

  socket.on('setReady', (p: { ready: boolean }) =>
    withRoom((room, id) => room.setReady(id, !!p?.ready)),
  );

  socket.on('startGame', () =>
    withRoom((room, id) => {
      const e = room.startGame(id);
      if (e) err(socket, e);
    }),
  );

  socket.on('updateSettings', (p: { settings: Partial<Settings> }) =>
    withRoom((room, id) => {
      const e = room.updateSettings(id, p?.settings ?? {});
      if (e) err(socket, e);
    }),
  );

  socket.on('lockAnswer', (p: { value: number }) =>
    withRoom((room, id) => {
      if (typeof p?.value !== 'number' || !Number.isFinite(p.value))
        return err(socket, 'Введите число');
      room.lockAnswer(id, p.value);
    }),
  );

  socket.on('action', (p: ActionPayload) =>
    withRoom((room, id) => {
      const e = room.handleAction(id, p?.type, p?.amount);
      if (e) err(socket, e);
    }),
  );

  socket.on('showCard', () => withRoom((room, id) => room.showCard(id)));

  socket.on('closeLobby', () =>
    withRoom((room, id) => {
      if (room.closeLobby(id)) manager.closeLobby(room.code, 'Хост закрыл лобби');
      else err(socket, 'Только хост может закрыть лобби');
    }),
  );

  socket.on('disconnect', () => manager.handleDisconnect(socket.id));
});

const count = loadQuestions().length;
httpServer.listen(PORT, () => {
  console.log(`\n  ♠ Числовой покер — сервер запущен`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → вопросов в базе: ${count}\n`);
});
