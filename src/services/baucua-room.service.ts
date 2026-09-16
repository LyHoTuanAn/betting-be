import type {WebSocket} from 'ws';
import {
  baucuaRoomRoll,
  baucuaRoomOutcome,
  isBauCuaBetKey,
  BAUCUA_MASCOTS,
  play
} from './game.service.js';
import {loadGames, gameDefaults, type GameConfig} from './game-catalog.service.js';

export const ROOM_CAPACITY = 10;
export const READY_TO_START = 6;
export const START_COUNTDOWN_MS = 5_000;
const BETTING_TIME_MS = 20_000;
/** Khớp hoạt ảnh của bàn: 4 nhịp quay 1,1s rồi 1s cho xúc xắc đáp xuống. */
const SHAKE_TIME_MS = 5_400;
const RESULT_TIME_MS = 8_000;
/** Phòng tụt dưới 6 người thì treo bàn chừng này để chờ ghép thêm. */
const INSUFFICIENT_TIMEOUT_MS = 30_000;
const HISTORY_SIZE = 6;
/**
 * Mất mạng hay máy ngủ thì socket không kịp báo `close`, nên người chơi cứ ngồi
 * lì giữ ghế và tính vào đủ 6 người — bàn "đang chơi" với toàn người vắng mặt.
 * Cứ 15 giây ping một vòng; ai không đáp trước lần ping sau thì cắt.
 */
const HEARTBEAT_TICKS = 15;

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
  /** Đã đáp pong kể từ lần ping gần nhất chưa; xem HEARTBEAT_TICKS. */
  alive: boolean;
};

export type RoundWinner = {
  userId: string;
  displayName: string;
  avatar: string;
  seatIndex: number;
  betAmount: number;
  winAmount: number;
};

export type BauCuaRoom = {
  id: string;
  code: string;
  name: string;
  minBet: number;
  maxBet: number;
  paytable: GameConfig<'BAUCUA'>;
  status: 'waiting' | 'playing';
  players: Map<string, Player>;
  countdownEndsAt: number | null;
  stage: 'betting' | 'shaking' | 'result';
  stageEndsAt: number;
  roundNo: number;
  dice: number[] | null;
  isTriple: boolean;
  history: number[][];
  lastWinners: RoundWinner[];
  insufficientSince: number | null;
  ticks: number;
};

const rooms = new Map<string, BauCuaRoom>();
let nextRoomNumber = 1000 + Math.floor(Math.random() * 8000);

export type RoomLimits = {minBet: number; maxBet: number; paytable: GameConfig<'BAUCUA'>};

function createRoom(limits: RoomLimits): BauCuaRoom {
  const code = String(nextRoomNumber++);
  const room: BauCuaRoom = {
    id: `baucua-${code}`,
    code,
    name: `Phòng Bầu Cua #${code}`,
    minBet: limits.minBet,
    maxBet: limits.maxBet,
    paytable: limits.paytable,
    status: 'waiting',
    players: new Map(),
    countdownEndsAt: null,
    stage: 'betting',
    stageEndsAt: 0,
    roundNo: 0,
    dice: null,
    isTriple: false,
    history: [],
    lastWinners: [],
    insufficientSince: null,
    ticks: 0
  };
  rooms.set(room.id, room);
  return room;
}

/**
 * Ưu tiên nhét người mới vào phòng đang chờ để nhóm đủ 6 nhanh nhất; chỉ khi
 * không còn phòng chờ nào mới cho ghép vào bàn đang chơi (vào giữa chừng vẫn
 * đặt được ván kế tiếp). Hết cả hai thì mở phòng mới.
 */
function findRoom(limits: RoomLimits): BauCuaRoom {
  for (const room of rooms.values()) {
    if (room.status === 'waiting' && room.players.size < ROOM_CAPACITY) return room;
  }
  for (const room of rooms.values()) {
    if (room.status === 'playing' && room.players.size < ROOM_CAPACITY) return room;
  }
  return createRoom(limits);
}

const send = (socket: WebSocket, message: unknown) => {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
};

const broadcast = (room: BauCuaRoom, message: unknown) => {
  room.players.forEach(player => send(player.socket, message));
};

const totalOf = (bets: Record<string, number>) => Object.values(bets).reduce((sum, amount) => sum + amount, 0);

const publicPlayer = (player: Player) => ({
  id: player.id,
  userId: player.userId,
  username: player.username,
  displayName: player.displayName,
  avatar: player.avatar,
  seatIndex: player.seatIndex,
  ready: player.ready,
  currentBets: player.currentBets,
  totalBet: totalOf(player.currentBets)
});

export const lobbyView = (room: BauCuaRoom) => ({
  type: 'lobby',
  roomId: room.id,
  code: room.code,
  name: room.name,
  status: room.status,
  capacity: ROOM_CAPACITY,
  needReady: READY_TO_START,
  minBet: room.minBet,
  maxBet: room.maxBet,
  paytable: room.paytable,
  players: [...room.players.values()].map(publicPlayer),
  readyCount: [...room.players.values()].filter(player => player.ready).length,
  countdownMs: room.countdownEndsAt ? Math.max(0, room.countdownEndsAt - Date.now()) : null
});

export const stateView = (room: BauCuaRoom) => ({
  type: 'state',
  roomId: room.id,
  code: room.code,
  name: room.name,
  status: room.status,
  capacity: ROOM_CAPACITY,
  needReady: READY_TO_START,
  minBet: room.minBet,
  maxBet: room.maxBet,
  paytable: room.paytable,
  stage: room.stage,
  stageMs: Math.max(0, room.stageEndsAt - Date.now()),
  roundNo: room.roundNo,
  dice: room.dice,
  isTriple: room.isTriple,
  history: room.history,
  lastWinners: room.lastWinners,
  insufficientCountdownSecs: room.insufficientSince
    ? Math.max(1, Math.ceil((INSUFFICIENT_TIMEOUT_MS - (Date.now() - room.insufficientSince)) / 1000))
    : null,
  players: [...room.players.values()].map(publicPlayer),
  tableBets: tableTotals(room)
});

/** Tổng tiền THẬT cả bàn đang đặt mỗi cửa — thay cho dãy số ngẫu nhiên cũ. */
function tableTotals(room: BauCuaRoom) {
  const totals: Record<string, number> = {TRIPLE_ANY: 0};
  for (const key of BAUCUA_MASCOTS) totals[key] = 0;
  for (const player of room.players.values()) {
    for (const [key, amount] of Object.entries(player.currentBets)) {
      totals[key] = (totals[key] || 0) + amount;
    }
  }
  return totals;
}

type UserMeta = {id: string; username?: string; displayName?: string; avatar?: string; balance?: number};

export function joinBauCuaRoom(user: UserMeta, socket: WebSocket, limits: RoomLimits) {
  const room = findRoom(limits);
  // Hạn mức và bảng tỉ lệ luôn lấy theo cấu hình mới nhất, kể cả với phòng đã
  // mở từ trước khi admin chỉnh.
  room.minBet = limits.minBet;
  room.maxBet = limits.maxBet;
  room.paytable = limits.paytable;

  const takenSeats = new Set([...room.players.values()].map(player => player.seatIndex));
  let seatIndex = 0;
  for (let seat = 0; seat < ROOM_CAPACITY; seat++) {
    if (!takenSeats.has(seat)) {
      seatIndex = seat;
      break;
    }
  }

  const player: Player = {
    id: `p${seatIndex}-${Math.random().toString(36).slice(2, 7)}`,
    userId: user.id,
    username: user.username || `player_${user.id.slice(0, 5)}`,
    displayName: user.displayName || user.username || 'Người chơi',
    avatar: user.avatar || '/assets/home-avatar.webp',
    seatIndex,
    socket,
    ready: false,
    currentBets: {},
    balance: Number(user.balance || 0),
    alive: true
  };

  room.players.set(player.id, player);

  // Người mới vào kéo bàn trở lại đủ quân thì mở lại ván ngay, không bắt những
  // người còn ngồi phải chờ hết 30 giây.
  if (room.status === 'playing' && room.players.size >= READY_TO_START && room.insufficientSince) {
    room.insufficientSince = null;
    room.stage = 'betting';
    room.stageEndsAt = Date.now() + BETTING_TIME_MS;
    broadcast(room, {type: 'insufficient-resolved', message: 'Đã có người chơi mới ghép vào phòng!'});
    broadcast(room, {...stateView(room), type: 'round-start', stageMs: BETTING_TIME_MS});
  }

  send(socket, {...lobbyView(room), type: 'joined', playerId: player.id, seatIndex: player.seatIndex});
  if (room.status === 'playing') send(socket, stateView(room));
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
    if (room.status === 'playing' && room.players.size < READY_TO_START && !room.insufficientSince) {
      room.insufficientSince = Date.now();
      broadcast(room, {
        type: 'player-left-insufficient',
        remainingSeconds: INSUFFICIENT_TIMEOUT_MS / 1000,
        message: `Có người chơi rời phòng. Đang chờ ghép đủ ${READY_TO_START} người (${INSUFFICIENT_TIMEOUT_MS / 1000}s)... Nếu không đủ sẽ tự động quay về sảnh chờ.`
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
      return send(socket, {type: 'error', message: 'Thời gian đặt cược đã kết thúc'});
    }
    if (!isBauCuaBetKey(target) || !Number.isInteger(amount) || amount <= 0) {
      return send(socket, {type: 'error', message: 'Cửa cược không hợp lệ'});
    }
    const next = totalOf(player.currentBets) + amount;
    // Trần cược tính trên TỔNG cả ván, đúng chỗ `assertBet` chặn lúc quyết toán —
    // chặn ngay đây để người chơi không đặt thừa rồi mới mất cả ván.
    if (next > room.maxBet) {
      return send(socket, {type: 'error', message: `Tối đa ${room.maxBet.toLocaleString('vi-VN')} vàng mỗi ván`});
    }
    if (next > player.balance) {
      return send(socket, {type: 'error', message: 'Số dư khả dụng không đủ'});
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
      totalBet: totalOf(player.currentBets),
      tableBets: tableTotals(room)
    });
  };

  const clearBets = () => {
    if (room.status !== 'playing' || room.stage !== 'betting') return;
    player.currentBets = {};
    broadcast(room, {
      type: 'clear-bets',
      playerId: player.id,
      userId: player.userId,
      seatIndex: player.seatIndex,
      tableBets: tableTotals(room)
    });
  };

  const markAlive = () => { player.alive = true; };

  return {player, room, leave, setReady, placeBet, clearBets, markAlive};
}

/**
 * Cắt những socket đã chết im lặng rồi ping vòng mới. `terminate()` làm sự kiện
 * `close` nổ, và chính handler đó gọi `leave` — nên ghế được nhả, phòng rỗng
 * được xoá, và bàn thiếu quân bắt đầu đếm ngược đúng như người chơi tự thoát.
 */
function reapDeadSockets(room: BauCuaRoom) {
  for (const player of [...room.players.values()]) {
    if (player.socket.readyState !== 1) {
      player.socket.terminate();
      continue;
    }
    if (!player.alive) {
      player.socket.terminate();
      continue;
    }
    player.alive = false;
    try { player.socket.ping(); } catch (_) {}
  }
}

function startGame(room: BauCuaRoom) {
  const now = Date.now();
  room.status = 'playing';
  room.countdownEndsAt = null;
  room.insufficientSince = null;
  room.stage = 'betting';
  room.stageEndsAt = now + BETTING_TIME_MS;
  room.roundNo = 1;
  room.dice = null;
  room.isTriple = false;
  room.lastWinners = [];
  room.players.forEach(player => { player.currentBets = {}; });

  broadcast(room, {type: 'game-start', roomId: room.id});
  broadcast(room, stateView(room));
}

/**
 * Quyết toán cả bàn trên đúng một lần lắc. Mỗi người là một `play()` riêng nên
 * ví ai nấy chịu: một người hết tiền chỉ làm hỏng phần cược của chính họ, ván
 * của những người còn lại vẫn tính bình thường.
 */
async function settleRound(room: BauCuaRoom) {
  const games = await loadGames();
  const config = (games.get('BAUCUA')?.config || gameDefaults.BAUCUA.config) as GameConfig<'BAUCUA'>;
  room.paytable = config;

  const roll = baucuaRoomRoll(room.id, room.roundNo);
  room.dice = roll.dice;
  room.isTriple = roll.dice[0] === roll.dice[1] && roll.dice[1] === roll.dice[2];
  room.history = [roll.dice, ...room.history].slice(0, HISTORY_SIZE);

  const winners: RoundWinner[] = [];
  for (const player of room.players.values()) {
    const bets = player.currentBets;
    const totalBet = totalOf(bets);
    // Dưới mức tối thiểu thì coi như ngồi xem ván này: không trừ, không trả.
    if (totalBet < room.minBet) continue;

    const outcome = baucuaRoomOutcome(bets, roll, room.id, room.roundNo, config);
    const requestId = `bc-${room.code}-${room.roundNo}-${player.userId.slice(0, 8)}`;
    try {
      const data = await play(player.userId, requestId, outcome);
      player.balance = data.balance;
      send(player.socket, {
        type: 'wallet',
        balance: player.balance,
        bet: totalBet,
        payout: outcome.payout,
        roundId: data.round.id,
        proof: data.round.serverProof
      });
      if (outcome.payout > 0) {
        winners.push({
          userId: player.userId,
          displayName: player.displayName,
          avatar: player.avatar,
          seatIndex: player.seatIndex,
          betAmount: totalBet,
          winAmount: outcome.payout
        });
      }
    } catch (error: any) {
      // Hết tiền hoặc tài khoản bị khoá: báo riêng người đó, bàn vẫn chạy tiếp.
      send(player.socket, {
        type: 'settle-failed',
        message: error?.message || 'Không quyết toán được ván này',
        code: error?.code || 'SETTLE_FAILED'
      });
      console.error(`Bầu cua: quyết toán lỗi cho ${player.userId}`, error);
    }
  }

  winners.sort((a, b) => b.winAmount - a.winAmount);
  room.lastWinners = winners;
  return roll;
}

export async function tickBauCuaRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    room.ticks++;
    if (room.ticks % HEARTBEAT_TICKS === 0) reapDeadSockets(room);

    if (room.status === 'waiting') {
      const readyCount = [...room.players.values()].filter(player => player.ready).length;
      const everyoneReady = readyCount === room.players.size && room.players.size >= READY_TO_START;

      if (readyCount >= READY_TO_START && room.countdownEndsAt === null) {
        room.countdownEndsAt = now + START_COUNTDOWN_MS;
        broadcast(room, {type: 'countdown', ms: START_COUNTDOWN_MS});
      }
      // Bàn chật cứng mà ai cũng sẵn sàng thì vào luôn, khỏi đếm nốt 5 giây.
      if (room.countdownEndsAt !== null && (now >= room.countdownEndsAt || (room.players.size >= ROOM_CAPACITY && everyoneReady))) {
        startGame(room);
        continue;
      }
      if (room.ticks % 2 === 0) broadcast(room, lobbyView(room));
      continue;
    }

    // Thiếu quân thì đóng băng ở pha đặt cược: không lắc, không trừ tiền ai.
    if (room.players.size < READY_TO_START) {
      if (!room.insufficientSince) {
        room.insufficientSince = now;
        broadcast(room, {
          type: 'player-left-insufficient',
          remainingSeconds: INSUFFICIENT_TIMEOUT_MS / 1000,
          message: `Có người chơi rời phòng. Đang chờ ghép đủ ${READY_TO_START} người (${INSUFFICIENT_TIMEOUT_MS / 1000}s)... Nếu không đủ sẽ tự động quay về sảnh chờ.`
        });
      } else if (now - room.insufficientSince >= INSUFFICIENT_TIMEOUT_MS) {
        room.status = 'waiting';
        room.countdownEndsAt = null;
        room.insufficientSince = null;
        room.dice = null;
        room.lastWinners = [];
        room.players.forEach(player => { player.ready = false; player.currentBets = {}; });
        broadcast(room, {
          type: 'room-dissolved',
          message: `Không đủ ${READY_TO_START} người chơi sau ${INSUFFICIENT_TIMEOUT_MS / 1000}s chờ ghép. Tất cả quay về sảnh chờ!`
        });
        broadcast(room, lobbyView(room));
        continue;
      } else if (room.ticks % 2 === 0) {
        broadcast(room, {
          type: 'insufficient-countdown',
          remainingSeconds: Math.max(1, Math.ceil((INSUFFICIENT_TIMEOUT_MS - (now - room.insufficientSince)) / 1000))
        });
      }
      room.stage = 'betting';
      room.stageEndsAt = now + BETTING_TIME_MS;
      continue;
    }
    if (room.insufficientSince) room.insufficientSince = null;

    if (room.stage === 'betting' && now >= room.stageEndsAt) {
      room.stage = 'shaking';
      room.stageEndsAt = now + SHAKE_TIME_MS;
      const roll = await settleRound(room);
      // Gửi kèm ba mặt để bàn chạy hoạt ảnh rơi đúng kết quả; cược đã khoá từ
      // trước nên biết sớm cũng không đặt thêm được.
      broadcast(room, {
        type: 'shake',
        dice: roll.dice,
        isTriple: room.isTriple,
        durationMs: SHAKE_TIME_MS,
        stageMs: SHAKE_TIME_MS
      });
      continue;
    }

    if (room.stage === 'shaking' && now >= room.stageEndsAt) {
      room.stage = 'result';
      room.stageEndsAt = now + RESULT_TIME_MS;
      broadcast(room, {
        ...stateView(room),
        type: 'result',
        dice: room.dice,
        isTriple: room.isTriple,
        winners: room.lastWinners,
        stageMs: RESULT_TIME_MS
      });
      continue;
    }

    if (room.stage === 'result' && now >= room.stageEndsAt) {
      room.stage = 'betting';
      room.stageEndsAt = now + BETTING_TIME_MS;
      room.roundNo++;
      room.dice = null;
      room.isTriple = false;
      room.lastWinners = [];
      room.players.forEach(player => { player.currentBets = {}; });
      broadcast(room, {...stateView(room), type: 'round-start', stageMs: BETTING_TIME_MS});
      continue;
    }
  }
}

/** Dùng cho kiểm thử: dọn sạch phòng giữa các lần chạy. */
export const __rooms = rooms;
