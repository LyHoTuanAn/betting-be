import type {WebSocket} from 'ws';
import crypto from 'crypto';
import {prisma} from '../lib/prisma.js';
import {
  roulettePayout,
  isRouletteBetKey,
  ROULETTE_RED,
  play
} from './game.service.js';
import {loadGames, type GameConfig} from './game-catalog.service.js';

export const ROOM_CAPACITY = 10;
export const READY_TO_START = 6;
export const START_COUNTDOWN_MS = 5_000;
const BETTING_TIME_MS = 20_000;
const SPIN_TIME_MS = 7_000;
const RESULT_TIME_MS = 8_000;
const INSUFFICIENT_TIMEOUT_MS = 30_000; // 30 seconds wait for replacement players

export type Player = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  seatIndex: number;
  socket: WebSocket;
  ready: boolean;
  currentBets: Record<string, number>;
  balance: number;
};

export type RouletteRoom = {
  id: string;
  code: string;
  name: string;
  minBet: number;
  maxBet: number;
  status: 'waiting' | 'playing';
  players: Map<string, Player>;
  startedAt: number;
  countdownEndsAt: number | null;
  stage: 'betting' | 'spinning' | 'result';
  stageEndsAt: number;
  winningNumber: number | null;
  winningColor: 'red' | 'black' | 'green' | null;
  lastWinners: Array<{
    userId: string;
    displayName: string;
    avatar: string;
    winAmount: number;
    betAmount: number;
  }>;
  insufficientSince: number | null;
  ticks: number;
};

const rooms = new Map<string, RouletteRoom>();
let nextRoomNumber = 1000 + Math.floor(Math.random() * 8000);

function createRoom(): RouletteRoom {
  const code = String(nextRoomNumber++);
  const room: RouletteRoom = {
    id: `roulette-${code}`,
    code,
    name: `Phòng Roulette #${code}`,
    minBet: 1000,
    maxBet: 10000000,
    status: 'waiting',
    players: new Map(),
    startedAt: 0,
    countdownEndsAt: null,
    stage: 'betting',
    stageEndsAt: 0,
    winningNumber: null,
    winningColor: null,
    lastWinners: [],
    insufficientSince: null,
    ticks: 0
  };
  rooms.set(room.id, room);
  return room;
}

function findRoom(): RouletteRoom {
  for (const r of rooms.values()) {
    if (r.status === 'waiting' && r.players.size < ROOM_CAPACITY) return r;
  }
  for (const r of rooms.values()) {
    if (r.status === 'playing' && r.players.size < ROOM_CAPACITY) return r;
  }
  return createRoom();
}

const send = (socket: WebSocket, message: unknown) => {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
};

const broadcast = (room: RouletteRoom, message: unknown) => {
  room.players.forEach(p => send(p.socket, message));
};

export const lobbyView = (room: RouletteRoom) => ({
  type: 'lobby',
  roomId: room.id,
  code: room.code,
  name: room.name,
  status: room.status,
  capacity: ROOM_CAPACITY,
  needReady: READY_TO_START,
  minBet: room.minBet,
  maxBet: room.maxBet,
  players: [...room.players.values()].map(p => ({
    id: p.id,
    userId: p.userId,
    username: p.username,
    displayName: p.displayName,
    avatar: p.avatar,
    seatIndex: p.seatIndex,
    ready: p.ready,
    balance: p.balance,
    currentBets: p.currentBets,
    totalBet: Object.values(p.currentBets).reduce((a, b) => a + b, 0)
  })),
  readyCount: [...room.players.values()].filter(p => p.ready).length,
  countdownMs: room.countdownEndsAt ? Math.max(0, room.countdownEndsAt - Date.now()) : null
});

export const stateView = (room: RouletteRoom) => ({
  type: 'state',
  roomId: room.id,
  code: room.code,
  name: room.name,
  status: room.status,
  capacity: ROOM_CAPACITY,
  stage: room.stage,
  stageMs: Math.max(0, room.stageEndsAt - Date.now()),
  winningNumber: room.winningNumber,
  winningColor: room.winningColor,
  lastWinners: room.lastWinners,
  insufficientCountdownSecs: room.insufficientSince ? Math.max(1, Math.ceil((INSUFFICIENT_TIMEOUT_MS - (Date.now() - room.insufficientSince)) / 1000)) : null,
  players: [...room.players.values()].map(p => ({
    id: p.id,
    userId: p.userId,
    username: p.username,
    displayName: p.displayName,
    avatar: p.avatar,
    seatIndex: p.seatIndex,
    balance: p.balance,
    currentBets: p.currentBets,
    totalBet: Object.values(p.currentBets).reduce((a, b) => a + b, 0)
  }))
});

type UserMeta = {
  id: string;
  username?: string;
  displayName?: string;
  avatar?: string;
  balance?: number;
};

export function joinRouletteRoom(user: UserMeta | string, socket: WebSocket) {
  const room = findRoom();
  const userId = typeof user === 'string' ? user : user.id;
  const username = typeof user === 'string' ? `player_${userId.slice(0, 5)}` : (user.username || 'player');
  const displayName = typeof user === 'string' ? 'Người chơi' : (user.displayName || user.username || 'Người chơi');
  const avatar = typeof user === 'string' ? '/assets/home-avatar.webp' : (user.avatar || '/assets/home-avatar.webp');
  const balance = typeof user === 'string' ? 0 : Number(user.balance || 0);

  const takenSeats = new Set([...room.players.values()].map(p => p.seatIndex));
  let seatIndex = 0;
  for (let s = 0; s < ROOM_CAPACITY; s++) {
    if (!takenSeats.has(s)) {
      seatIndex = s;
      break;
    }
  }

  const player: Player = {
    id: `p${room.players.size + 1}-${Math.random().toString(36).slice(2, 7)}`,
    userId,
    username,
    displayName,
    avatar,
    seatIndex,
    socket,
    ready: false,
    currentBets: {},
    balance
  };

  room.players.set(player.id, player);

  // If a player joined and brought room back to sufficient count
  if (room.players.size >= READY_TO_START && room.insufficientSince) {
    room.insufficientSince = null;
    room.stage = 'betting';
    room.stageEndsAt = Date.now() + BETTING_TIME_MS;
    broadcast(room, {
      type: 'insufficient-resolved',
      message: 'Đã có người chơi mới ghép vào phòng!'
    });
    broadcast(room, {
      ...stateView(room),
      type: 'round-start',
      stageMs: BETTING_TIME_MS
    });
  }

  send(socket, {
    ...lobbyView(room),
    type: 'joined',
    playerId: player.id,
    seatIndex: player.seatIndex
  });

  if (room.status === 'playing') {
    send(socket, stateView(room));
  }

  broadcast(room, lobbyView(room));

  const leave = () => {
    room.players.delete(player.id);
    if (!room.players.size) {
      rooms.delete(room.id);
      return;
    }

    if (room.status === 'waiting' && [...room.players.values()].filter(p => p.ready).length < READY_TO_START) {
      room.countdownEndsAt = null;
    }

    // If room is playing and drops below 6, start 30s countdown
    if (room.status === 'playing' && room.players.size < READY_TO_START) {
      if (!room.insufficientSince) {
        room.insufficientSince = Date.now();
      }
      broadcast(room, {
        type: 'player-left-insufficient',
        remainingSeconds: 30,
        message: 'Có người chơi rời phòng. Đang chờ ghép đủ 6 người (30s)... Nếu không đủ sẽ tự động quay về sảnh chờ.'
      });
    }

    broadcast(room, lobbyView(room));
  };

  const setReady = (ready: boolean) => {
    if (room.status !== 'waiting') return;
    player.ready = ready;
    if (!ready && [...room.players.values()].filter(p => p.ready).length < READY_TO_START) {
      room.countdownEndsAt = null;
    }
    broadcast(room, lobbyView(room));
  };

  const placeBet = (target: string, amount: number) => {
    if (room.status !== 'playing' || room.stage !== 'betting') {
      return send(socket, { type: 'error', message: 'Thời gian đặt cược đã kết thúc' });
    }
    if (!isRouletteBetKey(target) || !Number.isInteger(amount) || amount <= 0) {
      return send(socket, { type: 'error', message: 'Cửa cược không hợp lệ' });
    }
    const currentTotal = Object.values(player.currentBets).reduce((a, b) => a + b, 0);
    if (currentTotal + amount > player.balance) {
      return send(socket, { type: 'error', message: 'Số dư khả dụng không đủ' });
    }

    player.currentBets[target] = (player.currentBets[target] || 0) + amount;
    broadcast(room, {
      type: 'bet',
      playerId: player.id,
      userId: player.userId,
      seatIndex: player.seatIndex,
      target,
      amount,
      currentBets: player.currentBets,
      totalBet: Object.values(player.currentBets).reduce((a, b) => a + b, 0)
    });
  };

  const clearBets = () => {
    if (room.status !== 'playing' || room.stage !== 'betting') return;
    player.currentBets = {};
    broadcast(room, {
      type: 'clear-bets',
      playerId: player.id,
      userId: player.userId,
      seatIndex: player.seatIndex
    });
  };

  return { player, room, leave, setReady, placeBet, clearBets };
}

function startRouletteGame(room: RouletteRoom) {
  const now = Date.now();
  room.status = 'playing';
  room.startedAt = now;
  room.countdownEndsAt = null;
  room.insufficientSince = null;
  room.stage = 'betting';
  room.stageEndsAt = now + BETTING_TIME_MS;
  room.players.forEach(p => { p.currentBets = {}; });

  broadcast(room, { type: 'game-start', roomId: room.id });
  broadcast(room, stateView(room));
}

export async function tickRouletteRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    room.ticks++;

    // 1. Waiting room tick
    if (room.status === 'waiting') {
      const readyCount = [...room.players.values()].filter(p => p.ready).length;
      const everyoneReady = readyCount === room.players.size && room.players.size >= READY_TO_START;

      if (readyCount >= READY_TO_START && room.countdownEndsAt === null) {
        room.countdownEndsAt = now + START_COUNTDOWN_MS;
        broadcast(room, { type: 'countdown', ms: START_COUNTDOWN_MS });
      }

      if (room.countdownEndsAt !== null && (now >= room.countdownEndsAt || (room.players.size >= ROOM_CAPACITY && everyoneReady))) {
        startRouletteGame(room);
        continue;
      }

      if (room.ticks % 2 === 0) {
        broadcast(room, lobbyView(room));
      }
      continue;
    }

    // 2. Playing room state machine
    if (room.status === 'playing') {
      // Check if room dropped below minimum players during play
      if (room.players.size < READY_TO_START) {
        if (!room.insufficientSince) {
          room.insufficientSince = now;
          broadcast(room, {
            type: 'player-left-insufficient',
            remainingSeconds: 30,
            message: 'Có người chơi rời phòng. Đang chờ ghép đủ 6 người (30s)... Nếu không đủ sẽ tự động quay về sảnh chờ.'
          });
        } else {
          const elapsed = now - room.insufficientSince;
          if (elapsed >= INSUFFICIENT_TIMEOUT_MS) {
            // 30 seconds timeout reached with no replacement! Dissolve back to waiting room!
            room.status = 'waiting';
            room.countdownEndsAt = null;
            room.insufficientSince = null;
            room.players.forEach(p => {
              p.ready = false;
              p.currentBets = {};
            });
            broadcast(room, {
              type: 'room-dissolved',
              message: 'Không đủ 6 người chơi sau 30s chờ ghép. Tất cả người chơi quay về sảnh chờ!'
            });
            broadcast(room, lobbyView(room));
            continue;
          } else {
            const remainingSecs = Math.max(1, Math.ceil((INSUFFICIENT_TIMEOUT_MS - elapsed) / 1000));
            if (room.ticks % 2 === 0) {
              broadcast(room, {
                type: 'insufficient-countdown',
                remainingSeconds: remainingSecs
              });
            }
          }
        }

        // Room is insufficient (< 6 players), DO NOT SPIN OR ADVANCE STAGE!
        // Freeze stage at 'betting' and extend betting timer while waiting for players
        room.stage = 'betting';
        room.stageEndsAt = now + BETTING_TIME_MS;
        continue;
      } else {
        if (room.insufficientSince) {
          room.insufficientSince = null;
        }
      }

      // Transition from 'betting' -> 'spinning'
      if (room.stage === 'betting' && now >= room.stageEndsAt) {
        room.stage = 'spinning';
        room.stageEndsAt = now + SPIN_TIME_MS;

        // Pick fair random number 0..36
        const randBuffer = crypto.randomBytes(4);
        const winningNumber = randBuffer.readUInt32BE(0) % 37;
        const color = winningNumber === 0 ? 'green' : ((ROULETTE_RED as readonly number[]).includes(winningNumber) ? 'red' : 'black');
        room.winningNumber = winningNumber;
        room.winningColor = color;

        // Settle bets for players in room
        const games = await loadGames();
        const rouletteConfig = (games.get('ROULETTE')?.config || {
          straightX: 36,
          dozenX: 3,
          evenMoneyX: 2
        }) as GameConfig<'ROULETTE'>;

        const roundWinners: RouletteRoom['lastWinners'] = [];

        for (const player of room.players.values()) {
          const totalBet = Object.values(player.currentBets).reduce((a, b) => a + b, 0);
          if (totalBet <= 0) continue;

          const payout = roulettePayout(player.currentBets, winningNumber, rouletteConfig);
          const reqId = `rl-${Date.now()}-${player.userId.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;

          try {
            const outcome = {
              game: 'ROULETTE' as const,
              bet: totalBet,
              payout,
              result: {
                winningNumber,
                color,
                bets: player.currentBets,
                serverSeed: crypto.randomBytes(16).toString('hex'),
                algorithm: 'HMAC-SHA256',
                rtp: 0.973
              },
              serverProof: crypto.randomBytes(32).toString('hex')
            };

            const data = await play(player.userId, reqId, outcome);
            player.balance = data.balance;

            // Send individual wallet update
            send(player.socket, { type: 'wallet', balance: player.balance });

            if (payout > 0) {
              roundWinners.push({
                userId: player.userId,
                displayName: player.displayName,
                avatar: player.avatar,
                winAmount: payout,
                betAmount: totalBet
              });
            }
          } catch (err) {
            console.error(`Error executing roulette bet for user ${player.userId}:`, err);
          }
        }

        roundWinners.sort((a, b) => b.winAmount - a.winAmount);
        room.lastWinners = roundWinners;

        broadcast(room, {
          type: 'spin',
          winningNumber,
          color,
          durationMs: SPIN_TIME_MS,
          stageMs: SPIN_TIME_MS
        });
        continue;
      }

      // Transition from 'spinning' -> 'result'
      if (room.stage === 'spinning' && now >= room.stageEndsAt) {
        room.stage = 'result';
        room.stageEndsAt = now + RESULT_TIME_MS;

        broadcast(room, {
          ...stateView(room),
          type: 'result',
          winningNumber: room.winningNumber,
          color: room.winningColor,
          winners: room.lastWinners,
          stageMs: RESULT_TIME_MS
        });
        continue;
      }

      // Transition from 'result' -> 'betting' (next round)
      if (room.stage === 'result' && now >= room.stageEndsAt) {
        room.stage = 'betting';
        room.stageEndsAt = now + BETTING_TIME_MS;
        room.winningNumber = null;
        room.winningColor = null;
        room.players.forEach(p => { p.currentBets = {}; });

        broadcast(room, {
          ...stateView(room),
          type: 'round-start',
          stageMs: BETTING_TIME_MS
        });
        continue;
      }
    }
  }
}
