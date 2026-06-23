import type { Server } from 'socket.io';
import { Room } from './room.js';
import { DEFAULT_SETTINGS, type Settings } from '../types.js';
import { makeCode } from '../util.js';

interface SfxJob {
  name: string;
  targetId?: string;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private io: Server;
  // socketId -> { code, playerId }
  private sockets = new Map<string, { code: string; playerId: string }>();

  constructor(io: Server) {
    this.io = io;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  private newCode(): string {
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    return code;
  }

  createRoom(settingsPatch?: Partial<Settings>): Room {
    const code = this.newCode();
    const settings: Settings = { ...DEFAULT_SETTINGS };
    if (settingsPatch) {
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const v = settingsPatch[k];
        if (v === null && k === 'anteCap') settings.anteCap = null;
        else if (typeof v === 'number' && Number.isFinite(v)) (settings[k] as number) = v;
      }
    }
    let pendingSfx: SfxJob[] = [];
    const room = new Room(code, settings, {
      broadcast: () => this.broadcastRoom(code, pendingSfx.splice(0)),
      sfx: (name, targetId) => pendingSfx.push({ name, targetId }),
      onEmpty: () => this.removeRoom(code),
    });
    this.rooms.set(code, room);
    return room;
  }

  registerSocket(socketId: string, code: string, playerId: string) {
    this.sockets.set(socketId, { code, playerId });
  }

  lookupSocket(socketId: string) {
    return this.sockets.get(socketId);
  }

  /** Рассылает каждому подключённому персонализированное состояние + накопленные звуки. */
  broadcastRoom(code: string, sfx: SfxJob[]) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const p of room.players) {
      if (!p.connected || !p.socketId) continue;
      this.io.to(p.socketId).emit('state', room.buildState(p.id));
      for (const job of sfx) {
        if (!job.targetId || job.targetId === p.id) {
          this.io.to(p.socketId).emit('sfx', { name: job.name });
        }
      }
    }
  }

  closeLobby(code: string, reason: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const p of room.players) {
      if (p.socketId) this.io.to(p.socketId).emit('lobbyClosed', { reason });
    }
    this.removeRoom(code);
  }

  removeRoom(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    for (const [sid, info] of this.sockets) {
      if (info.code === code) this.sockets.delete(sid);
    }
    this.rooms.delete(code);
  }

  handleDisconnect(socketId: string) {
    const info = this.sockets.get(socketId);
    this.sockets.delete(socketId);
    if (!info) return;
    const room = this.rooms.get(info.code);
    if (!room) return;
    room.onDisconnect(socketId);
    if (room.isEmpty()) this.removeRoom(info.code);
  }
}
