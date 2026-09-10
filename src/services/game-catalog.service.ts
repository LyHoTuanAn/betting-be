import type {GameType} from '@prisma/client';
import {z} from 'zod';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';

/**
 * Mỗi game có một bộ tham số riêng nên config được lưu dạng JSON và chỉ được
 * ghi sau khi qua đúng schema của game đó. Cửa vào duy nhất là `gameConfig`,
 * vì vậy một bản ghi hỏng trong DB vẫn không thể đẩy tham số rác vào phần
 * tính thưởng — nó rơi về mặc định bên dưới.
 */
export const configSchemas = {
  SLOT: z.object({
    jackpotBp: z.number().int().min(0).max(10_000),
    bigWinBp: z.number().int().min(0).max(10_000),
    smallWinBp: z.number().int().min(0).max(10_000),
    jackpotX: z.number().min(0).max(10_000),
    bigWinX: z.number().min(0).max(1_000),
    smallWinX: z.number().min(0).max(100)
  }).refine(c => c.jackpotBp + c.bigWinBp + c.smallWinBp <= 10_000, {message: 'Tổng tỉ lệ thắng không được vượt 100%'}),
  DICE: z.object({payoutX: z.number().min(1).max(10)}),
  FISH: z.object({powerBonus: z.number().min(0).max(5), rtp: z.number().min(.5).max(1)}),
  // Roulette European: tỉ lệ trả của ba nhóm cửa. Bộ chuẩn 36/3/2 cho RTP
  // 36/37 ở mọi nhóm; hạ một hệ số xuống là hạ RTP đúng nhóm cửa đó.
  ROULETTE: z.object({
    straightX: z.number().min(1).max(50),
    dozenX: z.number().min(1).max(10),
    evenMoneyX: z.number().min(1).max(5)
  })
} satisfies Record<GameType, z.ZodType>;

export type GameConfig<K extends GameType = GameType> = z.infer<(typeof configSchemas)[K]>;

export const gameDefaults = {
  SLOT: {key:'SLOT',name:'NỔ HŨ HOÀNG KIM',subtitle:'Kho báu đang chờ bạn',sortOrder:0,minBet:1_000,maxBet:1_000_000,config:{jackpotBp:2,bigWinBp:80,smallWinBp:1400,jackpotX:250,bigWinX:25,smallWinX:5}},
  DICE: {key:'DICE',name:'ĐẠI CHIẾN TÀI XỈU',subtitle:'Thử vận may ngay',sortOrder:1,minBet:1_000,maxBet:10_000_000,config:{payoutX:1.98}},
  FISH: {key:'FISH',name:'BẮN CÁ ĐẠI DƯƠNG',subtitle:'Chinh phục thủy cung',sortOrder:2,minBet:100,maxBet:10_000,config:{powerBonus:.55,rtp:.98}},
  ROULETTE: {key:'ROULETTE',name:'VÒNG QUAY CHÂU ÂU',subtitle:'Đặt cửa, quay là ăn',sortOrder:3,minBet:1_000,maxBet:10_000_000,config:{straightX:36,dozenX:3,evenMoneyX:2}}
} as const;

export type Game = {
  key: GameType; name: string; subtitle: string; enabled: boolean; sortOrder: number;
  minBet: number; maxBet: number; maintenanceNote: string | null; config: GameConfig;
  updatedAt: Date | null;
};

const fallback = (key: GameType): Game => ({...gameDefaults[key], enabled: true, maintenanceNote: null, updatedAt: null, config: gameDefaults[key].config as GameConfig});

let cache: {games: Map<GameType, Game>; expiresAt: number} | null = null;
const TTL_MS = 5_000;

export function invalidateGameCache() { cache = null; }

/** Bản ghi thiếu hoặc config sai schema đều rơi về mặc định thay vì làm sập ván chơi. */
export async function loadGames(): Promise<Map<GameType, Game>> {
  if (cache && cache.expiresAt > Date.now()) return cache.games;
  const rows = await prisma.game.findMany();
  const games = new Map<GameType, Game>();
  for (const key of Object.keys(gameDefaults) as GameType[]) {
    const row = rows.find(r => r.key === key);
    if (!row) { games.set(key, fallback(key)); continue; }
    const parsed = configSchemas[key].safeParse(row.config);
    if (!parsed.success) console.error(`Config game ${key} không hợp lệ, dùng mặc định`, parsed.error.issues);
    games.set(key, {
      key, name: row.name, subtitle: row.subtitle, enabled: row.enabled, sortOrder: row.sortOrder,
      minBet: Number(row.minBet), maxBet: Number(row.maxBet), maintenanceNote: row.maintenanceNote,
      config: (parsed.success ? parsed.data : gameDefaults[key].config) as GameConfig, updatedAt: row.updatedAt
    });
  }
  cache = {games, expiresAt: Date.now() + TTL_MS};
  return games;
}

async function getGame(key: GameType): Promise<Game> {
  return (await loadGames()).get(key) ?? fallback(key);
}

/**
 * Chốt chặn thật của việc ẩn game: sảnh chỉ không vẽ thẻ game, còn ở đây một
 * request gõ thẳng vào API của game đã tắt vẫn bị chặn.
 */
export async function requireEnabledGame(key: GameType): Promise<Game> {
  const game = await getGame(key);
  if (!game.enabled) throw new AppError(403, game.maintenanceNote || `${game.name} đang tạm đóng để bảo trì`, 'GAME_DISABLED');
  return game;
}

export function assertBet(game: Game, bet: number) {
  if (!Number.isInteger(bet) || bet < game.minBet || bet > game.maxBet)
    throw new AppError(422, `Mức cược phải từ ${game.minBet.toLocaleString('vi-VN')} đến ${game.maxBet.toLocaleString('vi-VN')} vàng`, 'BET_OUT_OF_RANGE');
  return bet;
}
