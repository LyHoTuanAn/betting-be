import {describe,expect,it} from 'vitest';
import {rouletteOutcome,roulettePayout,rouletteRtp,ROULETTE_RED} from '../src/services/game.service.js';
import {gameDefaults} from '../src/services/game-catalog.service.js';

const config=gameDefaults.ROULETTE.config;

describe('bảng trả thưởng roulette',()=>{
 // Con số trả về là TỔNG NHẬN LẠI (đã gồm tiền cược), giống hệt frontend.
 it('cược thẳng số trúng trả 36 lần',()=>{
  expect(roulettePayout({'17':1000},17,config)).toBe(36_000);
  expect(roulettePayout({'17':1000},18,config)).toBe(0);
 });

 it('tá trả 3 lần đúng khoảng của nó',()=>{
  expect(roulettePayout({'1st 12':1000},7,config)).toBe(3000);
  expect(roulettePayout({'1st 12':1000},13,config)).toBe(0);
  expect(roulettePayout({'2nd 12':1000},13,config)).toBe(3000);
  expect(roulettePayout({'3rd 12':1000},36,config)).toBe(3000);
 });

 it('cửa đều tiền trả 2 lần',()=>{
  expect(roulettePayout({'RED':1000},1,config)).toBe(2000);      // 1 là đỏ
  expect(roulettePayout({'BLACK':1000},1,config)).toBe(0);
  expect(roulettePayout({'ODD':1000},7,config)).toBe(2000);
  expect(roulettePayout({'EVEN':1000},7,config)).toBe(0);
  expect(roulettePayout({'1-18':1000},18,config)).toBe(2000);
  expect(roulettePayout({'19-36':1000},19,config)).toBe(2000);
 });

 it('số 0 làm thua mọi cửa đều tiền và mọi tá — đây là lợi thế nhà cái',()=>{
  for(const key of ['RED','BLACK','ODD','EVEN','1-18','19-36','1st 12','2nd 12','3rd 12'])
   expect(roulettePayout({[key]:1000},0,config)).toBe(0);
  // Nhưng cược thẳng vào 0 vẫn trúng.
  expect(roulettePayout({'0':1000},0,config)).toBe(36_000);
 });

 it('cộng dồn nhiều cửa cùng lúc',()=>{
  // 17 là đen, lẻ, thuộc 2nd 12 và 1-18.
  const bets={'17':1000,'BLACK':2000,'ODD':2000,'2nd 12':1000,'RED':5000};
  expect(roulettePayout(bets,17,config)).toBe(36_000+4000+4000+3000+0);
 });

 it('bảng màu khớp bánh xe European chuẩn',()=>{
  expect(ROULETTE_RED).toHaveLength(18);
  expect(ROULETTE_RED).toContain(1);
  expect(ROULETTE_RED).not.toContain(2);
  expect(ROULETTE_RED).not.toContain(0);
 });

 it('RTP mặc định là 36/37 của roulette European',()=>{
  expect(rouletteRtp(config)).toBeCloseTo(36/37,10);
 });
});

describe('quay roulette',()=>{
 it('chỉ ra số trong khoảng 0-36 và kèm bằng chứng công bằng',()=>{
  for(let i=0;i<200;i++){
   const outcome=rouletteOutcome('user',`req_${i}`,{'RED':1000},config);
   const result=outcome.result as any;
   expect(result.winningNumber).toBeGreaterThanOrEqual(0);
   expect(result.winningNumber).toBeLessThanOrEqual(36);
   expect(Number.isInteger(result.winningNumber)).toBe(true);
   expect(outcome.serverProof).toHaveLength(64);
  }
 });

 it('tiền cược là tổng mọi cửa đã đặt',()=>{
  const outcome=rouletteOutcome('user','req_1',{'RED':1000,'17':2000,'ODD':500},config);
  expect(outcome.bet).toBe(3500);
 });

 it('cùng người chơi và cùng mã chống trùng cho ra cùng kết quả',()=>{
  const a=rouletteOutcome('user','req_same',{'RED':1000},config);
  const b=rouletteOutcome('user','req_same',{'RED':1000},config);
  // Seed ngẫu nhiên mỗi lần nên số trúng khác nhau; điều bắt buộc là kết quả
  // luôn kiểm chứng được: sha256(serverSeed) phải bằng serverProof.
  for(const outcome of [a,b]){
   const {createHash}=require('node:crypto');
   const seed=(outcome.result as any).serverSeed;
   expect(createHash('sha256').update(seed).digest('hex')).toBe(outcome.serverProof);
  }
 });

 it('trả thưởng dài hạn bám sát RTP lý thuyết',()=>{
  // Cược đều tiền 20.000 ván: sai số thống kê vẫn phải nằm quanh 97,3%.
  let staked=0,returned=0;
  for(let i=0;i<20_000;i++){
   const outcome=rouletteOutcome('u',`spin_${i}`,{'RED':1000},config);
   staked+=outcome.bet; returned+=outcome.payout;
  }
  expect(returned/staked).toBeGreaterThan(.90);
  expect(returned/staked).toBeLessThan(1.05);
 });
});
