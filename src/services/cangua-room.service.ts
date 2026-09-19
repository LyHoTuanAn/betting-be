import type {WebSocket} from 'ws';
import {
  CANGUA_COLORS, createBoard, legalMoves, movesForDie, applyMove,
  hasWon, totalProgress, finishedCount, rollDice, tileOf, homerunStepOf,
  HORSES_PER_PLAYER,
  type Board, type Color, type Move
} from './cangua.service.js';
import {play, type Outcome} from './game.service.js';
import {loadGames, gameDefaults, type GameConfig} from './game-catalog.service.js';

/** Bàn cờ cá ngựa luôn đúng bốn nhà, nên phòng đầy cũng là phòng đủ để mở. */
export const ROOM_CAPACITY = CANGUA_COLORS.length;
export const READY_TO_START = CANGUA_COLORS.length;
export const START_COUNTDOWN_MS = 5_000;
/** Hết giờ mà chưa đi thì bỏ lượt, không để một người treo cả bàn. */
const TURN_TIME_MS = 20_000;
const ROLL_ANIM_MS = 1_200;
const RESULT_TIME_MS = 12_000;
/** Bàn cá ngựa có thể dài vô tận; cắt ở đây rồi xếp hạng theo tiến độ. */
const MAX_TURNS = 400;
const HEARTBEAT_TICKS = 15;
/** Bỏ lượt liên tiếp quá số này thì coi như bỏ bàn, nhường chỗ cho người khác. */
const MAX_IDLE_TURNS = 3;
/** Biểu cảm chỉ đi một vòng broadcast; giãn nhịp để không ai spam che bàn cờ. */
const EMOJI_MIN_GAP_MS = 1_500;
const EMOJI_WHITELIST = new Set(['🐎', '🍷', '🎲', '💰', '😂', '👍', '🔥', '😭', '🎉', '😮', '😡', '🤝']);
/** Ngồi phòng chờ mà không sẵn sàng quá lâu thì mời ra, nhường ghế cho người khác. */
const WAITING_IDLE_MS = 120_000;

export type Player = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  color: Color;
  socket: WebSocket;
  ready: boolean;
  balance: number;
  /** Vé đã trừ khi bàn mở; cũng là căn cứ tính thưởng. */
  stake: number;
  kicks: number;
  bounty: number;
  idleTurns: number;
  alive: boolean;
  /** Chống spam biểu cảm: chỉ cho một emoji mỗi nhịp EMOJI_MIN_GAP_MS. */
  lastEmojiAt: number;
  /** Mốc bắt đầu ngồi chờ chưa sẵn sàng; null khi đã sẵn sàng. */
  unreadySince: number | null;
};

export type CanGuaRoom = {
  id: string;
  code: string;
  name: string;
  stake: number;
  minBet: number;
  maxBet: number;
  config: GameConfig<'CANGUA'>;
  status: 'waiting' | 'playing' | 'finished';
  players: Map<string, Player>;
  countdownEndsAt: number | null;
  board: Board;
  /** Thứ tự đi, cố định khi bàn mở. */
  order: Color[];
  turnIndex: number;
  turnNo: number;
  roundNo: number;
  stage: 'rolling' | 'moving' | 'result';
  stageEndsAt: number;
  dice: number[];
  /** Mặt xúc xắc chưa dùng của lượt hiện tại. */
  diceLeft: number[];
  lastProof: string | null;
  lastSeed: string | null;
  /** Số lần đổ liên tiếp do ra đôi, để chặn đổ mãi không dứt. */
  doublesRun: number;
  pot: number;
  prizePool: number;
  bountyPaid: number;
  winner: Color | null;
  ranking: Array<{color: Color; userId: string; displayName: string; finished: number; progress: number; payout: number; kicks: number}>;
  log: Array<{turn: number; text: string}>;
  ticks: number;
};

const rooms = new Map<string, CanGuaRoom>();
let nextRoomNumber = 1000 + Math.floor(Math.random() * 8000);

export type RoomLimits = {minBet: number; maxBet: number; config: GameConfig<'CANGUA'>};

function createRoom(stake: number, limits: RoomLimits): CanGuaRoom {
  const code = String(nextRoomNumber++);
  const room: CanGuaRoom = {
    id: `cangua-${code}`,
    code,
    name: `Phòng Cá Ngựa #${code}`,
    stake,
    minBet: limits.minBet,
    maxBet: limits.maxBet,
    config: limits.config,
    status: 'waiting',
    players: new Map(),
    countdownEndsAt: null,
    board: createBoard(),
    order: [],
    turnIndex: 0,
    turnNo: 0,
    roundNo: 0,
    stage: 'rolling',
    stageEndsAt: 0,
    dice: [],
    diceLeft: [],
    lastProof: null,
    lastSeed: null,
    doublesRun: 0,
    pot: 0,
    prizePool: 0,
    bountyPaid: 0,
    winner: null,
    ranking: [],
    log: [],
    ticks: 0
  };
  rooms.set(room.id, room);
  return room;
}

/**
 * Ghép theo đúng mức vé: hai người đặt vé khác nhau không thể ngồi chung bàn vì
 * hũ sẽ lệch. Chỉ nhận vào phòng còn chỗ và chưa khai cuộc — cá ngựa không cho
 * vào giữa ván như bầu cua, bàn đang đi mà thêm người thì thứ tự lượt vỡ.
 */
function findRoom(stake: number, limits: RoomLimits): CanGuaRoom {
  for (const room of rooms.values()) {
    if (room.status === 'waiting' && room.stake === stake && room.players.size < ROOM_CAPACITY) return room;
  }
  return createRoom(stake, limits);
}

const send = (socket: WebSocket, message: unknown) => {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
};
const broadcast = (room: CanGuaRoom, message: unknown) => {
  room.players.forEach(player => send(player.socket, message));
};

const playerByColor = (room: CanGuaRoom, color: Color) =>
  [...room.players.values()].find(player => player.color === color) || null;

const currentColor = (room: CanGuaRoom): Color | null => room.order[room.turnIndex] ?? null;

const publicPlayer = (room: CanGuaRoom, player: Player) => ({
  id: player.id,
  userId: player.userId,
  username: player.username,
  displayName: player.displayName,
  avatar: player.avatar,
  color: player.color,
  ready: player.ready,
  stake: player.stake,
  kicks: player.kicks,
  bounty: player.bounty,
  /** Số dư đủ vé hay không — để phòng chờ báo "thiếu vé" trước cả khi đếm ngược. */
  canPay: player.balance >= room.stake
});

/** Bàn cờ phẳng hoá cho client vẽ: mỗi con ngựa kèm sẵn ô và bậc về đích. */
const boardView = (board: Board) =>
  Object.fromEntries(CANGUA_COLORS.map(color => [color, board[color].map(horse => ({
    id: horse.id,
    color: horse.color,
    index: horse.index,
    state: horse.state,
    progress: horse.progress,
    tile: tileOf(horse),
    homerunStep: homerunStepOf(horse)
  }))]));

export const lobbyView = (room: CanGuaRoom) => ({
  type: 'lobby',
  roomId: room.id,
  code: room.code,
  name: room.name,
  status: room.status,
  capacity: ROOM_CAPACITY,
  needReady: READY_TO_START,
  stake: room.stake,
  minBet: room.minBet,
  maxBet: room.maxBet,
  config: room.config,
  players: [...room.players.values()].map(player => publicPlayer(room, player)),
  readyCount: [...room.players.values()].filter(player => player.ready).length,
  countdownMs: room.countdownEndsAt ? Math.max(0, room.countdownEndsAt - Date.now()) : null
});

export const stateView = (room: CanGuaRoom) => {
  const color = currentColor(room);
  return {
    type: 'state',
    roomId: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    capacity: ROOM_CAPACITY,
    stake: room.stake,
    config: room.config,
    board: boardView(room.board),
    order: room.order,
    turnColor: color,
    turnUserId: color ? playerByColor(room, color)?.userId ?? null : null,
    turnNo: room.turnNo,
    stage: room.stage,
    stageMs: Math.max(0, room.stageEndsAt - Date.now()),
    dice: room.dice,
    diceLeft: room.diceLeft,
    pot: room.pot,
    prizePool: room.prizePool,
    bountyPaid: room.bountyPaid,
    winner: room.winner,
    ranking: room.ranking,
    log: room.log.slice(-12),
    players: [...room.players.values()].map(player => publicPlayer(room, player)),
    proof: room.lastProof
  };
};

/** Nước đi khả dụng chỉ gửi riêng cho người đang tới lượt, không lộ cho bàn. */
const sendTurnOptions = (room: CanGuaRoom) => {
  const color = currentColor(room);
  if (!color) return;
  const player = playerByColor(room, color);
  if (!player) return;
  const moves = legalMoves(room.board, color, room.diceLeft);
  send(player.socket, {type: 'your-turn', dice: room.dice, diceLeft: room.diceLeft, moves, turnNo: room.turnNo});
};

const pushLog = (room: CanGuaRoom, text: string) => {
  room.log.push({turn: room.turnNo, text});
  if (room.log.length > 60) room.log.shift();
};

type UserMeta = {id: string; username?: string; displayName?: string; avatar?: string; balance?: number};

export function joinCanGuaRoom(user: UserMeta, socket: WebSocket, stake: number, limits: RoomLimits) {
  const room = findRoom(stake, limits);
  room.minBet = limits.minBet;
  room.maxBet = limits.maxBet;
  room.config = limits.config;

  const takenColors = new Set([...room.players.values()].map(p => p.color));
  const color = CANGUA_COLORS.find(c => !takenColors.has(c))!;

  const player: Player = {
    id: `${color}-${Math.random().toString(36).slice(2, 7)}`,
    userId: user.id,
    username: user.username || `player_${user.id.slice(0, 5)}`,
    displayName: user.displayName || user.username || 'Người chơi',
    avatar: user.avatar || '/assets/home-avatar.webp',
    color,
    socket,
    ready: false,
    balance: Number(user.balance || 0),
    stake: room.stake,
    kicks: 0,
    bounty: 0,
    idleTurns: 0,
    alive: true,
    lastEmojiAt: 0,
    unreadySince: Date.now()
  };
  room.players.set(player.id, player);

  send(socket, {...lobbyView(room), type: 'joined', playerId: player.id, color});
  broadcast(room, lobbyView(room));

  const leave = () => {
    room.players.delete(player.id);
    if (!room.players.size) {
      rooms.delete(room.id);
      return;
    }
    if (room.status === 'waiting') {
      if ([...room.players.values()].filter(p => p.ready).length < READY_TO_START) room.countdownEndsAt = null;
      broadcast(room, lobbyView(room));
      return;
    }
    // Bàn đang chơi mà mất người: quân của họ đứng yên tại chỗ, lượt tự bỏ qua.
    // Vé đã trừ nên phần hũ của họ vẫn nằm đó, người còn lại tranh nhau.
    if (room.status === 'playing') {
      pushLog(room, `${player.displayName} đã rời bàn, quân ${player.color} đứng im.`);
      broadcast(room, {type: 'player-left', color: player.color, displayName: player.displayName});
      if (currentColor(room) === player.color) advanceTurn(room);
      // Chỉ còn một người thì kết thúc luôn, không bắt họ tự đi với chính mình.
      if (room.players.size <= 1) void finishGame(room, 'Không còn đủ người chơi.');
      else broadcast(room, stateView(room));
    }
  };

  const setReady = (ready: boolean) => {
    if (room.status !== 'waiting') return;
    player.ready = ready;
    player.unreadySince = ready ? null : Date.now();
    if (!ready) room.countdownEndsAt = null;
    broadcast(room, lobbyView(room));
  };

  const roll = () => {
    if (room.status !== 'playing' || room.stage !== 'rolling') return;
    if (currentColor(room) !== player.color) return send(socket, {type: 'error', message: 'Chưa tới lượt bạn'});
    doRoll(room);
  };

  const move = (horseId: string, die: number) => {
    if (room.status !== 'playing' || room.stage !== 'moving') {
      return send(socket, {type: 'error', message: 'Chưa tới lúc đi quân'});
    }
    if (currentColor(room) !== player.color) return send(socket, {type: 'error', message: 'Chưa tới lượt bạn'});
    if (!room.diceLeft.includes(die)) return send(socket, {type: 'error', message: 'Mặt xúc xắc này đã dùng rồi'});

    const chosen = movesForDie(room.board, player.color, die).find(m => m.horseId === horseId);
    if (!chosen) return send(socket, {type: 'error', message: 'Nước đi không hợp lệ'});
    void commitMove(room, player, chosen);
  };

  /** Emoji chỉ được đi từ whitelist; ngoài danh sách thì bỏ lặng, khỏi báo lỗi. */
  const emoji = (value: string) => {
    const clean = String(value || '').trim().slice(0, 8);
    if (!EMOJI_WHITELIST.has(clean)) return;
    if (Date.now() - player.lastEmojiAt < EMOJI_MIN_GAP_MS) return;
    player.lastEmojiAt = Date.now();
    broadcast(room, {type: 'emoji', color: player.color, displayName: player.displayName, emoji: clean});
  };

  const markAlive = () => { player.alive = true; };

  return {player, room, leave, setReady, roll, move, emoji, markAlive};
}

/* ------------------------------------------------------------------ *
 * Vòng đời ván
 * ------------------------------------------------------------------ */

async function startGame(room: CanGuaRoom) {
  const games = await loadGames();
  room.config = (games.get('CANGUA')?.config || gameDefaults.CANGUA.config) as GameConfig<'CANGUA'>;

  // Trừ vé trước khi khai cuộc. Ai không đủ tiền thì bàn không mở, trả mọi
  // người về sảnh chờ — thà hoãn còn hơn mở bàn với hũ thiếu.
  const players = [...room.players.values()];
  const charged: Player[] = [];
  for (const player of players) {
    try {
      const outcome: Outcome = {
        game: 'CANGUA', bet: room.stake, payout: 0,
        result: {kind: 'entry', roomId: room.id, stake: room.stake, color: player.color},
        serverProof: ''
      };
      const data = await play(player.userId, `cg-${room.code}-${room.roundNo}-in-${player.userId.slice(0, 8)}`, outcome);
      player.balance = data.balance;
      player.stake = room.stake;
      charged.push(player);
      send(player.socket, {type: 'wallet', balance: player.balance, reason: 'entry', amount: -room.stake});
    } catch (error: any) {
      broadcast(room, {
        type: 'start-failed',
        message: `${player.displayName} không đủ vé ${room.stake.toLocaleString('vi-VN')} vàng. Bàn chưa thể mở.`
      });
      // Hoàn vé cho những người đã bị trừ trước đó.
      for (const paid of charged) await refund(room, paid, room.stake, 'start-failed');
      room.players.forEach(p => { p.ready = false; p.unreadySince = Date.now(); });
      room.countdownEndsAt = null;
      broadcast(room, lobbyView(room));
      return;
    }
  }

  room.status = 'playing';
  room.countdownEndsAt = null;
  room.board = createBoard();
  room.order = players.map(p => p.color);
  room.turnIndex = 0;
  room.turnNo = 1;
  room.roundNo++;
  room.dice = [];
  room.diceLeft = [];
  room.doublesRun = 0;
  room.winner = null;
  room.ranking = [];
  room.log = [];
  room.bountyPaid = 0;
  room.pot = room.stake * players.length;
  room.prizePool = room.pot - Math.floor(room.pot * room.config.rakeBp / 10_000);
  room.stage = 'rolling';
  room.stageEndsAt = Date.now() + TURN_TIME_MS;
  players.forEach(p => { p.kicks = 0; p.bounty = 0; p.idleTurns = 0; });

  pushLog(room, `Bàn mở! Hũ ${room.prizePool.toLocaleString('vi-VN')} vàng.`);
  broadcast(room, {type: 'game-start', roomId: room.id});
  broadcast(room, stateView(room));
  sendTurnOptions(room);
}

async function refund(room: CanGuaRoom, player: Player, amount: number, reason: string) {
  try {
    const outcome: Outcome = {
      game: 'CANGUA', bet: 0, payout: amount,
      result: {kind: 'refund', roomId: room.id, reason},
      serverProof: ''
    };
    const data = await play(player.userId, `cg-${room.code}-${room.roundNo}-rf-${player.userId.slice(0, 8)}`, outcome);
    player.balance = data.balance;
    send(player.socket, {type: 'wallet', balance: player.balance, reason: 'refund', amount});
  } catch (error) {
    console.error('Cá ngựa: hoàn vé lỗi', error);
  }
}

function doRoll(room: CanGuaRoom) {
  const color = currentColor(room);
  if (!color) return;
  const {dice, seed, proof} = rollDice(room.id, room.roundNo, room.turnNo);
  room.dice = dice;
  room.diceLeft = [...dice];
  room.lastSeed = seed;
  room.lastProof = proof;
  room.stage = 'moving';
  room.stageEndsAt = Date.now() + ROLL_ANIM_MS + TURN_TIME_MS;

  const player = playerByColor(room, color);
  pushLog(room, `${player?.displayName || color} thảy được ${dice[0]} và ${dice[1]}.`);
  broadcast(room, {type: 'roll', color, dice, proof, turnNo: room.turnNo, animMs: ROLL_ANIM_MS});

  // Không còn nước nào đi được thì mất lượt luôn, khỏi bắt người chơi bấm bỏ.
  if (legalMoves(room.board, color, room.diceLeft).length === 0) {
    pushLog(room, `${player?.displayName || color} không có nước đi, mất lượt.`);
    // `stuck` = cả chuồng còn trong stable: client giải thích là cần mặt 6,
    // chứ không chỉ nói "không có nước đi" chung chung.
    const stuck = room.board[color].every(h => h.state === 'stable');
    broadcast(room, {type: 'no-moves', color, dice, stuck});
    advanceTurn(room);
    broadcast(room, stateView(room));
    sendTurnOptions(room);
    return;
  }
  broadcast(room, stateView(room));
  sendTurnOptions(room);
}

async function commitMove(room: CanGuaRoom, player: Player, move: Move) {
  const result = applyMove(room.board, player.color, move);
  room.board = result.board;
  player.idleTurns = 0;

  // Mặt vừa dùng bị gạch khỏi lượt; hai mặt giống nhau chỉ gạch một.
  const used = room.diceLeft.indexOf(move.die);
  if (used >= 0) room.diceLeft.splice(used, 1);

  if (result.kicked) {
    const victim = playerByColor(room, result.kicked.color);
    const bounty = await payBounty(room, player);
    player.kicks++;
    pushLog(room, `${player.displayName} đá văng ngựa ${result.kicked.color} của ${victim?.displayName || '—'}${bounty ? ` (+${bounty.toLocaleString('vi-VN')})` : ''}.`);
    broadcast(room, {
      type: 'kick',
      byColor: player.color, byName: player.displayName,
      victimColor: result.kicked.color, victimName: victim?.displayName || null,
      victimHorseId: result.kicked.id, bounty
    });
  }

  broadcast(room, {type: 'move', color: player.color, move, board: boardView(room.board)});

  if (hasWon(room.board, player.color)) {
    pushLog(room, `${player.displayName} đã đưa cả 4 ngựa về đích!`);
    await finishGame(room, `${player.displayName} về nhất!`, player.color);
    return;
  }

  if (room.diceLeft.length > 0 && legalMoves(room.board, player.color, room.diceLeft).length > 0) {
    room.stage = 'moving';
    broadcast(room, stateView(room));
    sendTurnOptions(room);
    return;
  }

  // Ra đôi được đi thêm lượt, nhưng chỉ hai lần liên tiếp để bàn không kẹt.
  const isDouble = room.dice.length === 2 && room.dice[0] === room.dice[1];
  if (isDouble && room.doublesRun < 2) {
    room.doublesRun++;
    room.turnNo++;
    room.stage = 'rolling';
    room.stageEndsAt = Date.now() + TURN_TIME_MS;
    pushLog(room, `${player.displayName} ra đôi, được thảy thêm.`);
    broadcast(room, {type: 'extra-turn', color: player.color});
    broadcast(room, stateView(room));
    sendTurnOptions(room);
    return;
  }

  advanceTurn(room);
  broadcast(room, stateView(room));
  sendTurnOptions(room);
}

/** Thưởng đá ngựa lấy từ hũ và bị chặn trần, không in thêm tiền vào ván. */
async function payBounty(room: CanGuaRoom, player: Player): Promise<number> {
  const perKick = Math.floor(room.stake * room.config.kickBountyBp / 10_000);
  if (perKick <= 0) return 0;
  const budget = Math.floor(room.prizePool * room.config.maxBountyShareBp / 10_000);
  const remaining = budget - room.bountyPaid;
  const bounty = Math.min(perKick, Math.max(0, remaining));
  if (bounty <= 0) return 0;

  room.bountyPaid += bounty;
  player.bounty += bounty;
  try {
    const outcome: Outcome = {
      game: 'CANGUA', bet: 0, payout: bounty,
      result: {kind: 'kick-bounty', roomId: room.id, roundNo: room.roundNo, turnNo: room.turnNo, color: player.color},
      serverProof: room.lastProof || ''
    };
    const data = await play(player.userId, `cg-${room.code}-${room.roundNo}-kick-${room.turnNo}-${player.userId.slice(0, 8)}`, outcome);
    player.balance = data.balance;
    send(player.socket, {type: 'wallet', balance: player.balance, reason: 'kick', amount: bounty});
  } catch (error) {
    console.error('Cá ngựa: trả thưởng đá ngựa lỗi', error);
  }
  return bounty;
}

function advanceTurn(room: CanGuaRoom) {
  room.doublesRun = 0;
  room.dice = [];
  room.diceLeft = [];
  room.turnNo++;
  if (!room.order.length) return;

  // Nhảy qua những nhà đã rời bàn hoặc đã về đủ 4 ngựa.
  for (let i = 0; i < room.order.length; i++) {
    room.turnIndex = (room.turnIndex + 1) % room.order.length;
    const color = room.order[room.turnIndex]!;
    if (playerByColor(room, color) && !hasWon(room.board, color)) break;
  }
  room.stage = 'rolling';
  room.stageEndsAt = Date.now() + TURN_TIME_MS;
}

async function finishGame(room: CanGuaRoom, reason: string, winner?: Color) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  room.winner = winner ?? null;
  room.stage = 'result';
  room.stageEndsAt = Date.now() + RESULT_TIME_MS;

  // Xếp hạng: về đủ 4 con trước, rồi tới số ngựa đã về, rồi tới tổng tiến độ.
  const standings = [...room.players.values()].map(player => ({
    player,
    finished: finishedCount(room.board, player.color),
    progress: totalProgress(room.board, player.color)
  })).sort((a, b) =>
    (b.player.color === winner ? 1 : 0) - (a.player.color === winner ? 1 : 0) ||
    b.finished - a.finished || b.progress - a.progress
  );

  const prize = Math.max(0, room.prizePool - room.bountyPaid);
  const champion = standings[0];
  room.ranking = [];

  for (const [rank, row] of standings.entries()) {
    const payout = rank === 0 ? prize : 0;
    if (payout > 0) {
      try {
        const outcome: Outcome = {
          game: 'CANGUA', bet: 0, payout,
          result: {
            kind: 'prize', roomId: room.id, roundNo: room.roundNo, color: row.player.color,
            pot: room.pot, prizePool: room.prizePool, bountyPaid: room.bountyPaid,
            serverSeed: room.lastSeed, algorithm: 'HMAC-SHA256'
          },
          serverProof: room.lastProof || ''
        };
        const data = await play(row.player.userId, `cg-${room.code}-${room.roundNo}-win-${row.player.userId.slice(0, 8)}`, outcome);
        row.player.balance = data.balance;
        send(row.player.socket, {type: 'wallet', balance: row.player.balance, reason: 'prize', amount: payout});
      } catch (error) {
        console.error('Cá ngựa: trả thưởng về nhất lỗi', error);
      }
    }
    room.ranking.push({
      color: row.player.color, userId: row.player.userId, displayName: row.player.displayName,
      finished: row.finished, progress: row.progress, payout, kicks: row.player.kicks
    });
  }

  pushLog(room, reason);
  broadcast(room, {
    ...stateView(room),
    type: 'game-over',
    reason,
    winner: room.winner,
    championUserId: champion?.player.userId ?? null,
    prize,
    ranking: room.ranking,
    serverSeed: room.lastSeed
  });
}

function reapDeadSockets(room: CanGuaRoom) {
  for (const player of [...room.players.values()]) {
    if (player.socket.readyState !== 1 || !player.alive) {
      player.socket.terminate();
      continue;
    }
    player.alive = false;
    try { player.socket.ping(); } catch (_) {}
  }
}

export async function tickCanGuaRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    room.ticks++;
    if (room.ticks % HEARTBEAT_TICKS === 0) reapDeadSockets(room);

    if (room.status === 'waiting') {
      // Ngồi chờ chưa sẵn sàng quá WAITING_IDLE_MS thì mời ra, không để một tab
      // treo chiếm ghế mãi mà matchmaking đứng yên.
      for (const player of [...room.players.values()]) {
        if (!player.ready && player.unreadySince !== null && now - player.unreadySince > WAITING_IDLE_MS) {
          send(player.socket, {type: 'error', message: 'Bạn ngồi chờ quá lâu nên bị mời ra khỏi phòng.'});
          // 4001 = mã riêng để client hiển thị nút "Kết nối lại" thay vì tự
          // reconnect — tránh tab treo bị đá rồi tự vào lại lặp vô hạn.
          player.socket.close(4001, 'idle-waiting');
        }
      }

      const readyCount = [...room.players.values()].filter(p => p.ready).length;
      if (readyCount >= READY_TO_START && room.players.size >= READY_TO_START && room.countdownEndsAt === null) {
        room.countdownEndsAt = now + START_COUNTDOWN_MS;
        broadcast(room, {type: 'countdown', ms: START_COUNTDOWN_MS});
      }
      if (room.countdownEndsAt !== null && now >= room.countdownEndsAt) {
        await startGame(room);
        continue;
      }
      if (room.ticks % 2 === 0) broadcast(room, lobbyView(room));
      continue;
    }

    if (room.status === 'finished') {
      if (now >= room.stageEndsAt) {
        // Về lại sảnh chờ để bàn cũ chơi tiếp ván mới mà không phải ghép lại.
        room.status = 'waiting';
        room.countdownEndsAt = null;
        room.board = createBoard();
        room.players.forEach(p => { p.ready = false; p.kicks = 0; p.bounty = 0; p.unreadySince = Date.now(); });
        broadcast(room, {type: 'back-to-lobby'});
        broadcast(room, lobbyView(room));
      }
      continue;
    }

    if (room.turnNo > MAX_TURNS) {
      await finishGame(room, 'Bàn đã đạt giới hạn lượt, xếp hạng theo tiến độ.');
      continue;
    }

    if (now < room.stageEndsAt) continue;

    // Hết giờ lượt: tự thảy hộ, hoặc bỏ lượt nếu đã tới lúc đi mà không đi.
    const color = currentColor(room);
    if (!color) { advanceTurn(room); continue; }
    const player = playerByColor(room, color);
    if (!player) { advanceTurn(room); broadcast(room, stateView(room)); sendTurnOptions(room); continue; }

    if (room.stage === 'rolling') {
      player.idleTurns++;
      pushLog(room, `${player.displayName} quá giờ, hệ thống thảy hộ.`);
      doRoll(room);
      continue;
    }

    if (room.stage === 'moving') {
      // Quá giờ đi quân: chọn hộ nước đầu tiên để ván không đứng.
      const moves = legalMoves(room.board, color, room.diceLeft);
      if (moves.length > 0) {
        player.idleTurns++;
        pushLog(room, `${player.displayName} quá giờ, hệ thống đi hộ.`);
        await commitMove(room, player, moves[0]!);
      } else {
        advanceTurn(room);
        broadcast(room, stateView(room));
        sendTurnOptions(room);
      }
      if (player.idleTurns >= MAX_IDLE_TURNS) {
        pushLog(room, `${player.displayName} bỏ bàn quá lâu.`);
        broadcast(room, {type: 'idle-kick', color, displayName: player.displayName});
        send(player.socket, {type: 'error', message: 'Bạn bỏ lượt quá nhiều lần nên bị rời bàn.'});
        player.socket.close(1000, 'idle');
      }
      continue;
    }
  }
}

export const __rooms = rooms;
