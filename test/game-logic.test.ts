import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {diceOutcome,fishCatalog,fishOutcome,slotOutcome,slotRtp} from '../src/services/game.service.js';
import {gameDefaults,configSchemas,type GameConfig} from '../src/services/game-catalog.service.js';

const slotConfig=gameDefaults.SLOT.config as GameConfig<'SLOT'>;
const diceConfig=gameDefaults.DICE.config as GameConfig<'DICE'>;
const fishConfig=gameDefaults.FISH.config as GameConfig<'FISH'>;

const verifyProof=(outcome:ReturnType<typeof slotOutcome>)=>expect(createHash('sha256').update(String((outcome.result as any).serverSeed)).digest('hex')).toBe(outcome.serverProof);

describe('authoritative game logic',()=>{
 it('slot only returns documented payouts and verifiable result',()=>{for(let i=0;i<500;i++){const result=slotOutcome('user',`request_${i}`,10_000,slotConfig);expect([0,50_000,250_000,2_500_000]).toContain(result.payout);expect((result.result as any).grid).toHaveLength(15);verifyProof(result)}});
 it('dice returns valid dice, total and 1% house commission',()=>{for(let i=0;i<100;i++){const result=diceOutcome('user',`request_${i}`,100_000,'T',diceConfig),data=result.result as any;expect(data.dice.every((n:number)=>n>=1&&n<=6)).toBe(true);expect(data.total).toBe(data.dice.reduce((a:number,b:number)=>a+b,0));expect([0,198_000]).toContain(result.payout);verifyProof(result as any)}});
 it('fish payout and probability cannot be supplied by client',()=>{for(const kind of Object.keys(fishCatalog) as (keyof typeof fishCatalog)[]){const result=fishOutcome('user',`request_${kind}`,1_000,kind,fishConfig),data=result.result as any;expect(data.probability).toBeLessThanOrEqual(.72);expect([0,Math.floor(fishCatalog[kind]+550)]).toContain(result.payout);verifyProof(result as any)}});
});

describe('admin game config',()=>{
 it('mặc định của slot giữ RTP 95%',()=>{expect(slotRtp(slotConfig)).toBeCloseTo(.95,3)});
 it('payout đổi theo bội số admin đặt',()=>{
  const boosted=slotOutcome('user','request_win',10_000,{...slotConfig,smallWinBp:10_000,smallWinX:2,bigWinBp:0,jackpotBp:0});
  expect(boosted.payout).toBe(20_000);
 });
 it('từ chối bộ tỉ lệ có tổng vượt 100%',()=>{
  expect(configSchemas.SLOT.safeParse({...slotConfig,smallWinBp:9_999,bigWinBp:9_999}).success).toBe(false);
 });
});
