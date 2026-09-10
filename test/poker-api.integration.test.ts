import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();

describe('Poker API Integration', () => {
  let userToken: string;
  let userId: string;
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (createdUserIds.length) {
      await prisma.$transaction([
        prisma.walletLedger.deleteMany({ where: { userId: { in: createdUserIds } } }),
        prisma.gameRound.deleteMany({ where: { userId: { in: createdUserIds } } }),
        prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }),
        prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      ]);
    }
  });

  beforeEach(async () => {
    // Tạo user test với 500.000 vàng
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        username: `poker_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        displayName: 'Poker Tester',
        password: 'password123'
      });
    expect([200, 201]).toContain(regRes.status);
    userToken = regRes.body.token;
    userId = regRes.body.user.id;
    createdUserIds.push(userId);

    // Cộng thêm 500.000 vàng để test
    await prisma.user.update({
      where: { id: userId },
      data: { balance: 500_000n }
    });
  });

  it('bắt đầu ván Poker (/poker/deal) trừ Ante và chia Flop 3 lá', async () => {
    const dealRes = await request(app)
      .post('/api/games/poker/deal')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ante: 10_000 });

    expect(dealRes.status).toBe(200);
    expect(dealRes.body.handId).toBeDefined();
    expect(dealRes.body.stage).toBe('flop');
    expect(dealRes.body.heroHand.length).toBe(2);
    expect(dealRes.body.communityCards.length).toBe(3);
    expect(dealRes.body.pot).toBe(20_000);
    expect(dealRes.body.balance).toBe(490_000); // 500k - 10k ante
  });

  it('xử lý chuỗi hành động Check qua Turn -> River -> Showdown', async () => {
    const dealRes = await request(app)
      .post('/api/games/poker/deal')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ante: 10_000 });

    const handId = dealRes.body.handId;

    // Check ở Flop -> lên Turn (4 lá)
    const turnRes = await request(app)
      .post('/api/games/poker/action')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ handId, action: 'check' });

    expect(turnRes.status).toBe(200);
    expect(turnRes.body.stage).toBe('turn');
    expect(turnRes.body.communityCards.length).toBe(4);

    // Check ở Turn -> lên River (5 lá)
    const riverRes = await request(app)
      .post('/api/games/poker/action')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ handId, action: 'check' });

    expect(riverRes.status).toBe(200);
    expect(riverRes.body.stage).toBe('river');
    expect(riverRes.body.communityCards.length).toBe(5);

    // Check ở River -> lên Showdown (kết thúc ván)
    const showdownRes = await request(app)
      .post('/api/games/poker/action')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ handId, action: 'check' });

    expect(showdownRes.status).toBe(200);
    expect(showdownRes.body.stage).toBe('showdown');
    expect(['hero', 'dealer', 'tie']).toContain(showdownRes.body.winner);
    expect(showdownRes.body.dealerHand.length).toBe(2);
    expect(showdownRes.body.heroRank).toBeDefined();
    expect(showdownRes.body.dealerRank).toBeDefined();

    // Kiểm tra GameRound đã được lưu vào CSDL
    const round = await prisma.gameRound.findFirst({
      where: { userId, game: 'POKER' }
    });
    expect(round).toBeDefined();
    expect(round?.game).toBe('POKER');
    expect(round?.bet).toBe(10_000n);
  });

  it('hành động Fold kết thúc ván ngay và ghi nhận thua', async () => {
    const dealRes = await request(app)
      .post('/api/games/poker/deal')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ ante: 10_000 });

    const handId = dealRes.body.handId;

    const foldRes = await request(app)
      .post('/api/games/poker/action')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ handId, action: 'fold' });

    expect(foldRes.status).toBe(200);
    expect(foldRes.body.stage).toBe('folded');
    expect(foldRes.body.payout).toBe(0);

    const round = await prisma.gameRound.findFirst({
      where: { userId, game: 'POKER' }
    });
    expect(round).toBeDefined();
    expect(round?.payout).toBe(0n);
    expect(round?.net).toBe(-10_000n);
  });
});
