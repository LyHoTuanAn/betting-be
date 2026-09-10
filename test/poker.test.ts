import { describe, expect, it } from 'vitest';
import {
  createFullDeck,
  shuffleDeckWithSeed,
  evaluate7Cards,
  type Card
} from '../src/services/poker.service.js';

describe('Poker Engine & Evaluator', () => {
  it('tạo bộ bài 52 lá chuẩn không trùng lặp', () => {
    const deck = createFullDeck();
    expect(deck.length).toBe(52);
    const ids = new Set(deck.map(c => c.id));
    expect(ids.size).toBe(52);
  });

  it('xáo bài bằng HMAC-SHA256 tạo thứ tự ngẫu nhiên nhưng xác định theo seed', () => {
    const seed = 'test-seed-1234567890abcdef1234567890abcdef';
    const deck1 = shuffleDeckWithSeed(seed);
    const deck2 = shuffleDeckWithSeed(seed);
    expect(deck1.length).toBe(52);
    expect(deck1.map(c => c.id)).toEqual(deck2.map(c => c.id));

    const diffSeed = 'another-seed-0987654321fedcba0987654321fedcba';
    const deck3 = shuffleDeckWithSeed(diffSeed);
    expect(deck1.map(c => c.id)).not.toEqual(deck3.map(c => c.id));
  });

  it('nhận diện đúng Thùng Phá Sảnh (Royal Flush)', () => {
    const cards: Card[] = [
      { rank: 14, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: 'A', id: 'As' },
      { rank: 13, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: 'K', id: 'Ks' },
      { rank: 12, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: 'Q', id: 'Qs' },
      { rank: 11, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: 'J', id: 'Js' },
      { rank: 10, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '10', id: '10s' },
      { rank: 2, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '2', id: '2h' },
      { rank: 3, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '3', id: '3c' }
    ];
    const res = evaluate7Cards(cards);
    expect(res.rankTier).toBe(10);
    expect(res.name).toContain('Royal Flush');
  });

  it('nhận diện đúng Tứ Quý (Four of a Kind)', () => {
    const cards: Card[] = [
      { rank: 9, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '9', id: '9s' },
      { rank: 9, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '9', id: '9h' },
      { rank: 9, suit: 'd', symbol: '♦', name: 'Rô', color: '#ff0', label: '9', id: '9d' },
      { rank: 9, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '9', id: '9c' },
      { rank: 14, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: 'A', id: 'As' },
      { rank: 2, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '2', id: '2h' },
      { rank: 3, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '3', id: '3c' }
    ];
    const res = evaluate7Cards(cards);
    expect(res.rankTier).toBe(8);
    expect(res.name).toContain('Tứ Quý');
  });

  it('nhận diện đúng Cù Lũ (Full House)', () => {
    const cards: Card[] = [
      { rank: 10, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '10', id: '10s' },
      { rank: 10, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '10', id: '10h' },
      { rank: 10, suit: 'd', symbol: '♦', name: 'Rô', color: '#ff0', label: '10', id: '10d' },
      { rank: 4, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '4', id: '4c' },
      { rank: 4, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '4', id: '4s' },
      { rank: 2, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '2', id: '2h' },
      { rank: 7, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '7', id: '7c' }
    ];
    const res = evaluate7Cards(cards);
    expect(res.rankTier).toBe(7);
    expect(res.name).toContain('Cù Lũ');
  });

  it('nhận diện đúng Sảnh Nhỏ A-2-3-4-5 (Wheel Straight)', () => {
    const cards: Card[] = [
      { rank: 14, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: 'A', id: 'As' },
      { rank: 2, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '2', id: '2h' },
      { rank: 3, suit: 'd', symbol: '♦', name: 'Rô', color: '#ff0', label: '3', id: '3d' },
      { rank: 4, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '4', id: '4c' },
      { rank: 5, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '5', id: '5s' },
      { rank: 9, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '9', id: '9h' },
      { rank: 11, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: 'J', id: 'Jc' }
    ];
    const res = evaluate7Cards(cards);
    expect(res.rankTier).toBe(5);
    expect(res.name).toContain('Sảnh');
  });

  it('so sánh thứ hạng chuẩn xác (Cù Lũ thắng Đồng Chất)', () => {
    const fullHouseCards: Card[] = [
      { rank: 8, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '8', id: '8s' },
      { rank: 8, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '8', id: '8h' },
      { rank: 8, suit: 'd', symbol: '♦', name: 'Rô', color: '#ff0', label: '8', id: '8d' },
      { rank: 2, suit: 'c', symbol: '♣', name: 'Chuồn', color: '#0f0', label: '2', id: '2c' },
      { rank: 2, suit: 's', symbol: '♠', name: 'Bích', color: '#000', label: '2', id: '2s' }
    ];
    const flushCards: Card[] = [
      { rank: 14, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: 'A', id: 'Ah' },
      { rank: 11, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: 'J', id: 'Jh' },
      { rank: 9, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '9', id: '9h' },
      { rank: 6, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '6', id: '6h' },
      { rank: 3, suit: 'h', symbol: '♥', name: 'Cơ', color: '#f00', label: '3', id: '3h' }
    ];
    const fhEval = evaluate7Cards(fullHouseCards);
    const flEval = evaluate7Cards(flushCards);
    expect(fhEval.score).toBeGreaterThan(flEval.score);
  });
});
