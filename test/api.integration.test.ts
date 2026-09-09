import request from 'supertest';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createApp} from '../src/app.js';
import {prisma} from '../src/lib/prisma.js';

const app=createApp();let token='',refreshToken='',userId='';
const testRun=Date.now().toString(36);
const testUsername=`it_${testRun}`;

async function cleanTestUsers(ids?:string[]){
  const userIds=ids||((await prisma.user.findMany({where:{username:{startsWith:'it_'}},select:{id:true}})).map(user=>user.id));
  if(!userIds.length)return;
  await prisma.$transaction([
    prisma.walletLedger.deleteMany({where:{userId:{in:userIds}}}),prisma.gameRound.deleteMany({where:{userId:{in:userIds}}}),
    prisma.walletRequest.deleteMany({where:{userId:{in:userIds}}}),prisma.dailyClaim.deleteMany({where:{userId:{in:userIds}}}),
    prisma.session.deleteMany({where:{userId:{in:userIds}}}),prisma.user.deleteMany({where:{id:{in:userIds}}})
  ]);
}

// Integration tests only clean records that they own; never wipe a shared/dev database.
beforeAll(()=>cleanTestUsers());
afterAll(async()=>{if(userId)await cleanTestUsers([userId]);await prisma.$disconnect()});

describe('GoldZone API with MySQL',()=>{
 it('registers with 50,000 welcome gold, creates ledger and authenticates',async()=>{const response=await request(app).post('/api/auth/register').send({username:testUsername,displayName:'Integration Player',password:'secret123'}).expect(201);token=response.body.token;refreshToken=response.body.refreshToken;userId=response.body.user.id;expect(response.body.user.balance).toBe(50_000);expect(await prisma.walletLedger.count({where:{userId}})).toBe(1)});
 it('rotates refresh token and rejects reuse',async()=>{const rotated=await request(app).post('/api/auth/refresh').send({refreshToken}).expect(200);await request(app).post('/api/auth/refresh').send({refreshToken}).expect(401);token=rotated.body.token;refreshToken=rotated.body.refreshToken});
 it('processes one bet only when idempotency key repeats',async()=>{const before=(await request(app).get('/api/me').set('Authorization',`Bearer ${token}`)).body.user.balance,key='same_request_123';const first=await request(app).post('/api/games/slot/spin').set('Authorization',`Bearer ${token}`).set('X-Idempotency-Key',key).send({bet:1000}).expect(200);const second=await request(app).post('/api/games/slot/spin').set('Authorization',`Bearer ${token}`).set('X-Idempotency-Key',key).send({bet:1000}).expect(200);expect(second.body.roundId).toBe(first.body.roundId);expect(await prisma.gameRound.count({where:{userId,requestId:key}})).toBe(1);expect(second.body.balance).toBe(first.body.balance);expect(first.body.balance).toBeGreaterThanOrEqual(before-1000)});
 it('holds withdrawal balance and daily claim is unique',async()=>{await request(app).post('/api/wallet/daily-bonus').set('Authorization',`Bearer ${token}`).send({}).expect(200);const me=(await request(app).get('/api/me').set('Authorization',`Bearer ${token}`)).body.user;await request(app).post('/api/wallet/withdraw').set('Authorization',`Bearer ${token}`).send({amount:50_000}).expect(201);const after=(await request(app).get('/api/me').set('Authorization',`Bearer ${token}`)).body.user;expect(after.balance).toBe(me.balance-50_000);await request(app).post('/api/wallet/daily-bonus').set('Authorization',`Bearer ${token}`).send({}).expect(409)});
});
