import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Seed chỉ dựng cấu hình game. Tài khoản người chơi tạo qua /auth/register,
// tài khoản quản trị tạo bằng: npm run db:admin -- <tài_khoản> <mật_khẩu>

const games = [
  { key: 'SLOT' as const, name: 'NỔ HŨ HOÀNG KIM', subtitle: 'Kho báu đang chờ bạn', sortOrder: 0, minBet: 1000n, maxBet: 1000000n, config: { jackpotBp: 2, bigWinBp: 80, smallWinBp: 1400, jackpotX: 250, bigWinX: 25, smallWinX: 5 } },
  { key: 'DICE' as const, name: 'ĐẠI CHIẾN TÀI XỈU', subtitle: 'Thử vận may ngay', sortOrder: 1, minBet: 1000n, maxBet: 10000000n, config: { payoutX: 1.98 } },
  { key: 'FISH' as const, name: 'BẮN CÁ ĐẠI DƯƠNG', subtitle: 'Chinh phục thủy cung', sortOrder: 2, minBet: 100n, maxBet: 10000n, config: { powerBonus: 0.55, rtp: 0.98 } },
];

// update rỗng: seed chạy lại không được ghi đè cấu hình admin đã chỉnh.
for (const g of games) {
  await prisma.game.upsert({ where: { key: g.key }, update: {}, create: g });
}
console.log(`seeded ${games.length} games`);

await prisma.$disconnect();
