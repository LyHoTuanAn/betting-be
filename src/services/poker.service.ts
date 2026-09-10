import {createHash, createHmac, randomBytes} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';
import type {GameConfig} from './game-catalog.service.js';

export type Card = {
  suit: 's' | 'h' | 'd' | 'c';
  symbol: string;
  name: string;
  color: string;
  rank: number; // 2 .. 14
  label: string;
  id: string;
};

export const SUITS: {key: 's'|'h'|'d'|'c'; symbol: string; name: string; color: string}[] = [
  { key: 's', symbol: '♠', name: 'Bích', color: '#1a1f2c' },
  { key: 'h', symbol: '♥', name: 'Cơ', color: '#ef4444' },
  { key: 'd', symbol: '♦', name: 'Rô', color: '#f59e0b' },
  { key: 'c', symbol: '♣', name: 'Chuồn', color: '#10b981' }
];

export const RANKS = [
  { rank: 2, label: '2' },
  { rank: 3, label: '3' },
  { rank: 4, label: '4' },
  { rank: 5, label: '5' },
  { rank: 6, label: '6' },
  { rank: 7, label: '7' },
  { rank: 8, label: '8' },
  { rank: 9, label: '9' },
  { rank: 10, label: '10' },
  { rank: 11, label: 'J' },
  { rank: 12, label: 'Q' },
  { rank: 13, label: 'K' },
  { rank: 14, label: 'A' }
];

export const HAND_NAMES: Record<number, string> = {
  10: 'Thùng Phá Sảnh (Royal Flush)',
  9: 'Sảnh Rồng (Straight Flush)',
  8: 'Tứ Quý (Four of a Kind)',
  7: 'Cù Lũ (Full House)',
  6: 'Đồng Chất (Flush)',
  5: 'Sảnh (Straight)',
  4: 'Sám Cô (Three of a Kind)',
  3: 'Thú (Two Pair)',
  2: 'Một Đôi (One Pair)',
  1: 'Mậu Thầu (High Card)'
};

export function createFullDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({
        suit: s.key,
        symbol: s.symbol,
        name: s.name,
        color: s.color,
        rank: r.rank,
        label: r.label,
        id: `${r.label}${s.key}`
      });
    }
  }
  return deck;
}

/** Xáo bài bằng HMAC-SHA256 provably fair. */
export function shuffleDeckWithSeed(seed: string): Card[] {
  const deck = createFullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const hash = createHmac('sha256', seed).update(`poker-shuffle-${i}`).digest();
    const j = hash.readUInt32BE(0) % (i + 1);
    const temp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = temp;
  }
  return deck;
}

export type HandEval = {
  score: number;
  rankTier: number;
  name: string;
};

export function evaluate7Cards(cards: Card[]): HandEval {
  if (!cards || cards.length < 5) return { score: 0, rankTier: 0, name: 'Chưa đủ bài' };
  const combos = getCombinations(cards, 5);
  let best: HandEval = { score: -1, rankTier: 0, name: '' };

  for (const combo of combos) {
    const evalResult = evaluate5Cards(combo);
    if (evalResult.score > best.score) {
      best = evalResult;
    }
  }
  return best;
}

function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === arr.length) return [arr];
  if (k === 1) return arr.map(e => [e]);
  const result: T[][] = [];
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr.slice(i, i + 1);
    const tailCombos = getCombinations(arr.slice(i + 1), k - 1);
    for (const tail of tailCombos) {
      result.push(head.concat(tail));
    }
  }
  return result;
}

function evaluate5Cards(hand: Card[]): HandEval {
  const sorted = [...hand].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);
  let isStraight = false;
  let straightHigh = 0;

  if (ranks[0]! - ranks[4]! === 4 && new Set(ranks).size === 5) {
    isStraight = true;
    straightHigh = ranks[0]!;
  } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
    // A-2-3-4-5 wheel straight
    isStraight = true;
    straightHigh = 5;
  }

  // Count frequencies
  const counts: Record<number, number> = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, count]) => ({ rank: Number(r), count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  let rankTier = 1;
  let score = 0;

  if (isStraight && isFlush) {
    if (straightHigh === 14) rankTier = 10; // Royal Flush
    else { rankTier = 9; score = straightHigh; } // Straight Flush
  } else if (groups[0]?.count === 4) {
    rankTier = 8; // Four of a kind
    score = groups[0].rank * 100 + groups[1]!.rank;
  } else if (groups[0]?.count === 3 && groups[1]?.count === 2) {
    rankTier = 7; // Full House
    score = groups[0].rank * 100 + groups[1].rank;
  } else if (isFlush) {
    rankTier = 6; // Flush
    score = ranks[0]! * 10000 + ranks[1]! * 1000 + ranks[2]! * 100 + ranks[3]! * 10 + ranks[4]!;
  } else if (isStraight) {
    rankTier = 5; // Straight
    score = straightHigh;
  } else if (groups[0]?.count === 3) {
    rankTier = 4; // Three of a kind
    score = groups[0].rank * 1000 + groups[1]!.rank * 10 + groups[2]!.rank;
  } else if (groups[0]?.count === 2 && groups[1]?.count === 2) {
    rankTier = 3; // Two Pair
    score = groups[0].rank * 1000 + groups[1].rank * 100 + groups[2]!.rank;
  } else if (groups[0]?.count === 2) {
    rankTier = 2; // One Pair
    score = groups[0].rank * 10000 + groups[1]!.rank * 1000 + groups[2]!.rank * 100 + groups[3]!.rank;
  } else {
    rankTier = 1; // High Card
    score = ranks[0]! * 10000 + ranks[1]! * 1000 + ranks[2]! * 100 + ranks[3]! * 10 + ranks[4]!;
  }

  const finalScore = rankTier * 1e10 + score;
  return { score: finalScore, rankTier, name: HAND_NAMES[rankTier] || 'Bài lạ' };
}

export type ActivePokerHand = {
  id: string;
  userId: string;
  ante: number;
  totalBet: number;
  pot: number;
  currentBet: number;
  stage: 'flop' | 'turn' | 'river' | 'showdown' | 'folded';
  heroCards: Card[];
  dealerCards: Card[];
  communityCards: Card[]; // Full 5 community cards
  revealedCount: number; // 3 on flop, 4 on turn, 5 on river/showdown
  serverSeed: string;
  serverProof: string;
  createdAt: Date;
  updatedAt: Date;
};

// In-memory store for active hands with 1-hour TTL
const activeHands = new Map<string, ActivePokerHand>();

function cleanupStaleHands() {
  const now = Date.now();
  for (const [id, hand] of activeHands.entries()) {
    if (now - hand.updatedAt.getTime() > 3_600_000) {
      activeHands.delete(id);
    }
  }
}

export function getActiveHandForUser(userId: string): ActivePokerHand | null {
  cleanupStaleHands();
  for (const hand of activeHands.values()) {
    if (hand.userId === userId && !['showdown', 'folded'].includes(hand.stage)) {
      return hand;
    }
  }
  return null;
}

/** Bắt đầu ván mới: trừ Ante, chia bài và mở Flop (3 lá đầu). */
export async function dealHand(userId: string, ante: number, gameConfig: GameConfig<'POKER'>) {
  if (ante < 5_000) throw new AppError(422, 'Mức cược tối thiểu là 5.000 vàng', 'BET_TOO_SMALL');
  if (ante > 50_000_000) throw new AppError(422, 'Mức cược tối đa là 50.000.000 vàng', 'BET_TOO_LARGE');

  // Đóng ván cũ nếu chưa kết thúc
  const existing = getActiveHandForUser(userId);
  if (existing) {
    activeHands.delete(existing.id);
  }

  const seed = randomBytes(32).toString('hex');
  const proof = createHash('sha256').update(seed).digest('hex');
  const deck = shuffleDeckWithSeed(seed);

  const heroCards = [deck[0]!, deck[1]!];
  const dealerCards = [deck[2]!, deck[3]!];
  const communityCards = [deck[4]!, deck[5]!, deck[6]!, deck[7]!, deck[8]!];

  const pot = ante * 2; // Người chơi + Nhà cái khớp cược

  // Trừ Ante trong CSDL
  const anteBig = BigInt(ante);
  const updatedUser = await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') throw new AppError(403, 'Tài khoản không hợp lệ', 'USER_INVALID');
    if (user.balance < anteBig) throw new AppError(409, 'Số dư không đủ để đặt cược', 'INSUFFICIENT_BALANCE');

    const updated = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: anteBig }, version: { increment: 1 } }
    });
    await tx.walletLedger.create({
      data: {
        userId,
        type: 'GAME_BET',
        amount: -anteBig,
        balanceAfter: updated.balance,
        description: `Đặt cược Poker Texas Hold'em (Ante: ${ante})`
      }
    });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  const handId = `poker_${randomBytes(12).toString('hex')}`;
  const hand: ActivePokerHand = {
    id: handId,
    userId,
    ante,
    totalBet: ante,
    pot,
    currentBet: ante,
    stage: 'flop',
    heroCards,
    dealerCards,
    communityCards,
    revealedCount: 3,
    serverSeed: seed,
    serverProof: proof,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  activeHands.set(handId, hand);

  const evalFlop = evaluate7Cards([...heroCards, ...communityCards.slice(0, 3)]);

  return {
    handId,
    stage: hand.stage,
    heroHand: heroCards,
    communityCards: communityCards.slice(0, 3),
    handRank: evalFlop.name,
    pot,
    currentBet: hand.currentBet,
    totalBet: hand.totalBet,
    balance: Number(updatedUser.balance),
    serverProof: proof
  };
}

export type ActionInput = {
  handId: string;
  action: 'check' | 'call' | 'raise' | 'allin' | 'fold';
  amount?: number;
};

/** Xử lý hành động trong ván (Check, Call, Raise, All-in, Fold). */
export async function actionHand(userId: string, input: ActionInput, gameConfig: GameConfig<'POKER'>) {
  const hand = activeHands.get(input.handId);
  if (!hand || hand.userId !== userId) throw new AppError(404, 'Không tìm thấy ván bài hợp lệ', 'HAND_NOT_FOUND');
  if (['showdown', 'folded'].includes(hand.stage)) throw new AppError(409, 'Ván bài đã kết thúc', 'HAND_ENDED');

  hand.updatedAt = new Date();

  // 1. Xử lý FOLD
  if (input.action === 'fold') {
    hand.stage = 'folded';
    activeHands.delete(hand.id);

    // Lưu GameRound ghi nhận thua
    await prisma.$transaction(async tx => {
      await tx.gameRound.create({
        data: {
          userId,
          game: 'POKER',
          bet: BigInt(hand.totalBet),
          payout: 0n,
          net: -BigInt(hand.totalBet),
          requestId: hand.id,
          serverProof: hand.serverProof,
          result: {
            action: 'fold',
            serverSeed: hand.serverSeed,
            heroCards: hand.heroCards,
            communityCards: hand.communityCards.slice(0, hand.revealedCount),
            pot: hand.pot
          }
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
    return {
      handId: hand.id,
      stage: 'folded',
      payout: 0,
      balance: Number(user.balance),
      message: 'Bạn đã Fold (Bỏ bài)'
    };
  }

  // 2. Xử lý thêm cược (CALL, RAISE, ALLIN)
  let extraBet = 0;
  if (input.action === 'call') {
    extraBet = hand.currentBet;
  } else if (input.action === 'raise') {
    const raiseAmt = input.amount || hand.currentBet * 2;
    if (raiseAmt <= 0) throw new AppError(422, 'Số tiền tố không hợp lệ', 'INVALID_RAISE');
    extraBet = raiseAmt;
    hand.currentBet = raiseAmt;
  } else if (input.action === 'allin') {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
    extraBet = Math.min(Number(user.balance), 50_000_000);
    if (extraBet <= 0) throw new AppError(409, 'Số dư không đủ để All-in', 'INSUFFICIENT_BALANCE');
  }

  let userBalance = 0;
  if (extraBet > 0) {
    const extraBig = BigInt(extraBet);
    const updated = await prisma.$transaction(async tx => {
      const u = await tx.user.findUnique({ where: { id: userId } });
      if (!u || u.status !== 'ACTIVE') throw new AppError(403, 'Tài khoản không hợp lệ', 'USER_INVALID');
      if (u.balance < extraBig) throw new AppError(409, 'Số dư không đủ cho hành động này', 'INSUFFICIENT_BALANCE');

      const userUp = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: extraBig }, version: { increment: 1 } }
      });
      await tx.walletLedger.create({
        data: {
          userId,
          type: 'GAME_BET',
          amount: -extraBig,
          balanceAfter: userUp.balance,
          description: `Poker ${input.action.toUpperCase()} (${extraBet})`
        }
      });
      return userUp;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    hand.totalBet += extraBet;
    hand.pot += extraBet * 2; // Nhà cái đối ứng pot
    userBalance = Number(updated.balance);
  } else {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
    userBalance = Number(u.balance);
  }

  // 3. Tiến trình bàn bài (Advance Stage)
  if (input.action === 'allin') {
    hand.stage = 'showdown';
    hand.revealedCount = 5;
  } else if (hand.stage === 'flop') {
    hand.stage = 'turn';
    hand.revealedCount = 4;
  } else if (hand.stage === 'turn') {
    hand.stage = 'river';
    hand.revealedCount = 5;
  } else if (hand.stage === 'river') {
    hand.stage = 'showdown';
  }

  // 4. Nếu chưa đến SHOWDOWN: trả về lá bài tiếp theo
  if (hand.stage !== 'showdown') {
    const curEval = evaluate7Cards([...hand.heroCards, ...hand.communityCards.slice(0, hand.revealedCount)]);
    return {
      handId: hand.id,
      stage: hand.stage,
      heroHand: hand.heroCards,
      communityCards: hand.communityCards.slice(0, hand.revealedCount),
      handRank: curEval.name,
      pot: hand.pot,
      currentBet: hand.currentBet,
      totalBet: hand.totalBet,
      balance: userBalance
    };
  }

  // 5. SHOWDOWN: Phân định thắng thua
  activeHands.delete(hand.id);

  const heroEval = evaluate7Cards([...hand.heroCards, ...hand.communityCards]);
  const dealerEval = evaluate7Cards([...hand.dealerCards, ...hand.communityCards]);

  let winner: 'hero' | 'dealer' | 'tie' = 'dealer';
  let payout = 0;

  if (heroEval.score > dealerEval.score) {
    winner = 'hero';
    const rake = Math.floor((hand.pot * (gameConfig.rakeBp || 250)) / 10_000);
    payout = hand.pot - rake;
  } else if (heroEval.score === dealerEval.score) {
    winner = 'tie';
    payout = hand.totalBet; // Hoà thì hoàn lại tiền đã cược
  } else {
    winner = 'dealer';
    payout = 0;
  }

  // Ghi nhận kết quả ván vào CSDL
  const finalUser = await prisma.$transaction(async tx => {
    let finalBal = BigInt(userBalance);
    if (payout > 0) {
      const payoutBig = BigInt(payout);
      const u = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: payoutBig }, version: { increment: 1 } }
      });
      await tx.walletLedger.create({
        data: {
          userId,
          type: 'GAME_PAYOUT',
          amount: payoutBig,
          balanceAfter: u.balance,
          description: `Thắng Poker Texas Hold'em (+${payout})`
        }
      });
      finalBal = u.balance;
    }

    await tx.gameRound.create({
      data: {
        userId,
        game: 'POKER',
        bet: BigInt(hand.totalBet),
        payout: BigInt(payout),
        net: BigInt(payout - hand.totalBet),
        requestId: hand.id,
        serverProof: hand.serverProof,
        result: {
          winner,
          payout,
          pot: hand.pot,
          serverSeed: hand.serverSeed,
          heroCards: hand.heroCards,
          dealerCards: hand.dealerCards,
          communityCards: hand.communityCards,
          heroRank: heroEval.name,
          dealerRank: dealerEval.name,
          heroScore: heroEval.score,
          dealerScore: dealerEval.score
        }
      }
    });

    return finalBal;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  return {
    handId: hand.id,
    stage: 'showdown',
    winner,
    payout,
    pot: hand.pot,
    heroHand: hand.heroCards,
    dealerHand: hand.dealerCards,
    communityCards: hand.communityCards,
    heroRank: heroEval.name,
    dealerRank: dealerEval.name,
    balance: Number(finalUser),
    serverProof: hand.serverProof
  };
}
