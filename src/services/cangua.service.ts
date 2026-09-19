import {createHash, createHmac, randomBytes} from 'node:crypto';

/**
 * Luật Cờ Cá Ngựa chuẩn 48 ô, viết thuần tuý không phụ thuộc phòng hay ví, để
 * kiểm thử được bằng trạng thái dựng tay. Mọi nước đi hợp lệ đều phải đi qua
 * `legalMoves`; `applyMove` chỉ thi hành, không tự phán xét luật.
 */

export const CANGUA_COLORS = ['red', 'green', 'gold', 'blue'] as const;
export type Color = typeof CANGUA_COLORS[number];

/** Ô xuất quân của từng nhà, khớp đúng số ô mà bàn cờ phía client đang vẽ. */
export const START_TILE: Record<Color, number> = {red: 1, green: 13, gold: 25, blue: 37};

export const TRACK_TILES = 48;
export const HOMERUN_STEPS = 6;
/** Đi hết một vòng là 47 bước, cộng 6 bậc về đích; tới 53 là về chuồng đích. */
export const LAST_TRACK_PROGRESS = TRACK_TILES - 1;
export const MAX_PROGRESS = LAST_TRACK_PROGRESS + HOMERUN_STEPS;
export const HORSES_PER_PLAYER = 4;
/** Chỉ mặt 6 mới mở được cửa chuồng. */
export const DEPLOY_FACE = 6;

export type HorseState = 'stable' | 'track' | 'homerun' | 'finished';

export type Horse = {
  id: string;
  color: Color;
  index: number;
  state: HorseState;
  /** 0 = đang đứng ở ô xuất quân; chỉ có nghĩa khi đã rời chuồng. */
  progress: number;
};

export type Board = Record<Color, Horse[]>;

export const createHorses = (color: Color): Horse[] =>
  Array.from({length: HORSES_PER_PLAYER}, (_, index) => ({
    id: `${color}_${index}`, color, index, state: 'stable' as HorseState, progress: 0
  }));

export const createBoard = (): Board =>
  Object.fromEntries(CANGUA_COLORS.map(color => [color, createHorses(color)])) as Board;

/**
 * Ô trên vòng ngoài mà một con ngựa đang đứng, hoặc null nếu nó đang trong
 * chuồng / đã vào đường về đích. Đây là chỗ duy nhất quy đổi tiến độ sang số ô,
 * nên đổi hướng chạy của bàn cờ chỉ phải sửa ở đây.
 */
export function tileOf(horse: Horse): number | null {
  if (horse.state !== 'track') return null;
  return ((START_TILE[horse.color] - 1 + horse.progress) % TRACK_TILES) + 1;
}

/** Bậc về đích 1..6, hoặc null nếu chưa vào đường về. */
export function homerunStepOf(horse: Horse): number | null {
  if (horse.state !== 'homerun' && horse.state !== 'finished') return null;
  return horse.progress - LAST_TRACK_PROGRESS;
}

const stateForProgress = (progress: number): HorseState =>
  progress >= MAX_PROGRESS ? 'finished' : progress > LAST_TRACK_PROGRESS ? 'homerun' : 'track';

export type Move = {
  horseId: string;
  die: number;
  /** Dùng mặt 6 để mở cửa chuồng thay vì đi tới. */
  deploy: boolean;
  fromProgress: number;
  toProgress: number;
  toTile: number | null;
  toHomerunStep: number | null;
  /** Con ngựa địch sẽ bị đá văng về chuồng nếu đi nước này. */
  kicks: string | null;
};

const horseAt = (board: Board, tile: number, exclude?: string): Horse | null => {
  for (const color of CANGUA_COLORS) {
    for (const horse of board[color]) {
      if (horse.id !== exclude && horse.state === 'track' && tileOf(horse) === tile) return horse;
    }
  }
  return null;
};

/** Ngựa của chính mình đang chắn một bậc về đích thì không ai chồng lên được. */
const ownHorseAtHomerun = (board: Board, color: Color, step: number, exclude?: string): Horse | null =>
  board[color].find(h => h.id !== exclude && h.state === 'homerun' && homerunStepOf(h) === step) || null;

/**
 * Mọi nước đi hợp lệ cho một mặt xúc xắc. Trả về cả nước bị chặn lẫn nước ăn
 * quân dưới cùng một dạng để giao diện chỉ việc vẽ, không phải tính lại luật.
 */
export function movesForDie(board: Board, color: Color, die: number): Move[] {
  const moves: Move[] = [];

  for (const horse of board[color]) {
    if (horse.state === 'finished') continue;

    if (horse.state === 'stable') {
      // Ra quân: chỉ mặt 6, và cửa chuồng phải trống hoặc đang có quân địch để đá.
      if (die !== DEPLOY_FACE) continue;
      const gate = START_TILE[color];
      const blocker = horseAt(board, gate);
      if (blocker && blocker.color === color) continue;
      moves.push({
        horseId: horse.id, die, deploy: true,
        fromProgress: 0, toProgress: 0, toTile: gate, toHomerunStep: null,
        kicks: blocker ? blocker.id : null
      });
      continue;
    }

    const toProgress = horse.progress + die;
    // Về đích phải đúng số nút, dư một bước là không đi được.
    if (toProgress > MAX_PROGRESS) continue;

    const toState = stateForProgress(toProgress);
    if (toState === 'track') {
      const tile = ((START_TILE[color] - 1 + toProgress) % TRACK_TILES) + 1;
      const blocker = horseAt(board, tile, horse.id);
      if (blocker && blocker.color === color) continue;
      moves.push({
        horseId: horse.id, die, deploy: false,
        fromProgress: horse.progress, toProgress, toTile: tile, toHomerunStep: null,
        kicks: blocker ? blocker.id : null
      });
      continue;
    }

    // Trong đường về đích không có chuyện ăn quân — mỗi nhà một lối đi riêng.
    const step = toProgress - LAST_TRACK_PROGRESS;
    if (ownHorseAtHomerun(board, color, step, horse.id)) continue;
    // Không được nhảy qua đầu quân nhà đang đứng chắn trong đường về.
    const from = Math.max(horse.progress, LAST_TRACK_PROGRESS) + 1;
    let blocked = false;
    for (let p = from; p < toProgress; p++) {
      if (ownHorseAtHomerun(board, color, p - LAST_TRACK_PROGRESS, horse.id)) {blocked = true; break;}
    }
    if (blocked) continue;

    moves.push({
      horseId: horse.id, die, deploy: false,
      fromProgress: horse.progress, toProgress, toTile: null, toHomerunStep: step,
      kicks: null
    });
  }

  return moves;
}

/** Gộp nước đi của mọi mặt xúc xắc còn lại trong lượt. */
export function legalMoves(board: Board, color: Color, dice: number[]): Move[] {
  const seen = new Set<number>();
  const moves: Move[] = [];
  for (const die of dice) {
    // Hai mặt giống nhau cho cùng một tập nước đi, liệt kê một lần là đủ.
    if (seen.has(die)) continue;
    seen.add(die);
    moves.push(...movesForDie(board, color, die));
  }
  return moves;
}

export type MoveResult = {
  board: Board;
  move: Move;
  /** Con ngựa vừa bị đá về chuồng, nếu có. */
  kicked: Horse | null;
  finished: boolean;
};

/** Thi hành một nước đã được `legalMoves` chấp nhận. Không kiểm luật lại. */
export function applyMove(board: Board, color: Color, move: Move): MoveResult {
  const next: Board = Object.fromEntries(
    CANGUA_COLORS.map(c => [c, board[c].map(h => ({...h}))])
  ) as Board;

  const horse = next[color].find(h => h.id === move.horseId)!;
  let kicked: Horse | null = null;

  if (move.kicks) {
    for (const c of CANGUA_COLORS) {
      const victim = next[c].find(h => h.id === move.kicks);
      if (victim) {
        victim.state = 'stable';
        victim.progress = 0;
        kicked = victim;
        break;
      }
    }
  }

  if (move.deploy) {
    horse.state = 'track';
    horse.progress = 0;
  } else {
    horse.progress = move.toProgress;
    horse.state = stateForProgress(move.toProgress);
  }

  return {board: next, move, kicked, finished: horse.state === 'finished'};
}

export const hasWon = (board: Board, color: Color) =>
  board[color].every(horse => horse.state === 'finished');

/** Tổng tiến độ, dùng để xếp hạng khi bàn hết giờ mà chưa ai về đủ 4 con. */
export const totalProgress = (board: Board, color: Color) =>
  board[color].reduce((sum, horse) => sum + (horse.state === 'stable' ? 0 : horse.progress + 1), 0);

export const finishedCount = (board: Board, color: Color) =>
  board[color].filter(horse => horse.state === 'finished').length;

/**
 * Một lần thảy xúc xắc kiểm chứng được: seed sinh ngẫu nhiên, proof là băm của
 * seed, hai mặt suy ra từ HMAC nên ai cũng dựng lại được sau khi ván kết thúc.
 */
export function rollDice(roomId: string, roundNo: number, turnNo: number) {
  const seed = randomBytes(32).toString('hex');
  const proof = createHash('sha256').update(seed).digest('hex');
  const digest = createHmac('sha256', seed).update(`${roomId}:${roundNo}:${turnNo}`).digest();
  const dice = [0, 1].map(i => (digest.readUInt32BE(i * 4) % 6) + 1);
  return {dice, seed, proof};
}
