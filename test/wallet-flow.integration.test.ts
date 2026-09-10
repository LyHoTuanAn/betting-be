import request from 'supertest';
import bcrypt from 'bcryptjs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createApp} from '../src/app.js';
import {prisma} from '../src/lib/prisma.js';
import {recordBankDeposit} from '../src/services/bank-deposit.service.js';
import {approveWithdrawal,createWithdrawal,getWallet,rejectWithdrawal} from '../src/services/wallet.service.js';
import {parseBankEmail} from '../src/services/timo-email.parser.js';

/**
 * Kiểm thử tiêu chí nghiệm thu ở SRS mục 23 trên MySQL thật — phần dễ sai nhất
 * là số học số dư và chống cộng trùng, hai thứ chỉ lộ ra khi chạy với CSDL.
 */

const app=createApp();
const run=Date.now().toString(36);
const player=`wf_${run}`;          // người chơi chính
const admin=`wfadm_${run}`;
let playerId='',adminId='';
const txn=(suffix:string)=>`FTWF${run.toUpperCase()}${suffix}`;

const balances=async(id:string)=>{
  const user=await prisma.user.findUniqueOrThrow({where:{id},select:{balance:true,lockedBalance:true}});
  return {balance:Number(user.balance),locked:Number(user.lockedBalance),available:Number(user.balance-user.lockedBalance)};
};

async function cleanup(){
  const users=await prisma.user.findMany({where:{username:{startsWith:'wf'}},select:{id:true}});
  const ids=users.map(user=>user.id);
  await prisma.bankDeposit.deleteMany({where:{OR:[{userId:{in:ids}},{bankTransactionId:{startsWith:'FTWF'}}]}});
  if(!ids.length)return;
  await prisma.$transaction([
    prisma.walletLedger.deleteMany({where:{userId:{in:ids}}}),
    prisma.gameRound.deleteMany({where:{userId:{in:ids}}}),
    prisma.walletRequest.deleteMany({where:{userId:{in:ids}}}),
    prisma.dailyClaim.deleteMany({where:{userId:{in:ids}}}),
    prisma.session.deleteMany({where:{userId:{in:ids}}}),
    prisma.user.deleteMany({where:{id:{in:ids}}})
  ]);
}

beforeAll(async()=>{
  await cleanup();
  const passwordHash=await bcrypt.hash('secret123',10);
  const created=await prisma.user.create({data:{username:player,displayName:'Wallet Flow',passwordHash,balance:2_000_000n,lockedBalance:0n}});
  playerId=created.id;
  const createdAdmin=await prisma.user.create({data:{username:admin,displayName:'Wallet Admin',passwordHash,role:'ADMIN',balance:0n}});
  adminId=createdAdmin.id;
});
afterAll(async()=>{await cleanup();await prisma.$disconnect()});

describe('Nạp tiền qua email Timo (SRS mục 23)',()=>{
 it('khớp username thì cộng tiền và ghi giao dịch COMPLETED',async()=>{
  const before=await balances(playerId);
  const outcome=await recordBankDeposit({
    bankTransactionId:txn('001'),amount:1_000_000,transferContent:player,
    transactionTime:new Date(),emailSubject:'Timo'
  });
  expect(outcome.result).toBe('COMPLETED');

  const after=await balances(playerId);
  expect(after.balance).toBe(before.balance+1_000_000);

  const deposit=await prisma.bankDeposit.findUniqueOrThrow({where:{bankTransactionId:txn('001')}});
  expect(deposit.status).toBe('COMPLETED');
  expect(deposit.userId).toBe(playerId);
  // Lịch sử ví phải có đúng một dòng trỏ về giao dịch ngân hàng này.
  expect(await prisma.walletLedger.count({where:{referenceId:deposit.id,type:'DEPOSIT'}})).toBe(1);
 });

 it('đọc lại cùng một email không cộng tiền lần hai',async()=>{
  const before=await balances(playerId);
  const outcome=await recordBankDeposit({
    bankTransactionId:txn('001'),amount:1_000_000,transferContent:player,
    transactionTime:new Date(),emailSubject:'Timo'
  });
  expect(outcome.result).toBe('DUPLICATE');
  expect(await balances(playerId)).toEqual(before);
  expect(await prisma.bankDeposit.count({where:{bankTransactionId:txn('001')}})).toBe(1);
 });

 it('không tìm thấy username thì lưu UNMATCHED và không cộng cho ai',async()=>{
  const before=await balances(playerId);
  const outcome=await recordBankDeposit({
    bankTransactionId:txn('002'),amount:1_000_000,transferContent:'khong_ton_tai_9x',
    transactionTime:new Date(),emailSubject:'Timo'
  });
  expect(outcome.result).toBe('UNMATCHED');
  expect(await balances(playerId)).toEqual(before);

  const deposit=await prisma.bankDeposit.findUniqueOrThrow({where:{bankTransactionId:txn('002')}});
  expect(deposit.status).toBe('UNMATCHED');
  expect(deposit.userId).toBeNull();
  expect(await prisma.walletLedger.count({where:{referenceId:deposit.id}})).toBe(0);
 });

 it('admin khớp tay giao dịch UNMATCHED thì tiền mới được cộng',async()=>{
  const before=await balances(playerId);
  const deposit=await prisma.bankDeposit.findUniqueOrThrow({where:{bankTransactionId:txn('002')}});
  const token=(await request(app).post('/api/auth/login').send({username:admin,password:'secret123'})).body.token;

  await request(app).post(`/api/admin/deposits/${deposit.id}/match`)
    .set('Authorization',`Bearer ${token}`).send({username:player}).expect(200);

  expect((await balances(playerId)).balance).toBe(before.balance+1_000_000);
  const updated=await prisma.bankDeposit.findUniqueOrThrow({where:{id:deposit.id}});
  expect(updated.status).toBe('COMPLETED');
  expect(updated.resolvedById).toBe(adminId);
 });

 it('email tiền vào thật đi hết chặng parse → cộng tiền',async()=>{
  const before=await balances(playerId);
  const parsed=parseBankEmail({
    from:'no-reply@timo.vn',subject:'Timo - Biến động số dư',date:new Date(),
    text:`Tài khoản của quý khách vừa nhận được tiền vào.\nSố tiền: +500.000 VND\nNội dung: ${player}\nMã giao dịch: ${txn('003')}`
  });
  expect(parsed).not.toBeNull();
  expect((await recordBankDeposit(parsed!)).result).toBe('COMPLETED');
  expect((await balances(playerId)).balance).toBe(before.balance+500_000);
 });
});

describe('Rút tiền (SRS mục 23)',()=>{
 const bank={bankName:'ABC Bank',accountNumber:'0123456789',accountName:'NGUYEN VAN A'};

 it('tạo yêu cầu thì khoá tiền, số dư tổng không đổi',async()=>{
  const before=await balances(playerId);
  await createWithdrawal(playerId,{amount:2_000_000,...bank});
  const after=await balances(playerId);
  expect(after.balance).toBe(before.balance);              // chưa chuyển đi
  expect(after.locked).toBe(before.locked+2_000_000);
  expect(after.available).toBe(before.available-2_000_000);
 });

 it('không cho rút quá số dư khả dụng',async()=>{
  const before=await balances(playerId);
  await expect(createWithdrawal(playerId,{amount:before.available+1,...bank})).rejects.toMatchObject({code:'INSUFFICIENT_BALANCE'});
  expect(await balances(playerId)).toEqual(before);
 });

 it('không tiêu được tiền đang bị khoá khi chơi game',async()=>{
  const {available}=await balances(playerId);
  const token=(await request(app).post('/api/auth/login').send({username:player,password:'secret123'})).body.token;
  // Cược lớn hơn số khả dụng nhưng vẫn nhỏ hơn tổng số dư: nếu game vẫn tính
  // theo `balance` thì ván này sẽ được chấp nhận và tiền đang khoá bị tiêu mất.
  const response=await request(app).post('/api/games/dice/play')
    .set('Authorization',`Bearer ${token}`).set('X-Idempotency-Key',`lockedbet_${run}`)
    .send({bet:available+1_000,side:'T'});
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
 });

 it('APPROVE: trừ cả số dư lẫn khoá, số khả dụng giữ nguyên',async()=>{
  const before=await balances(playerId);
  const pending=await prisma.walletRequest.findFirstOrThrow({where:{userId:playerId,status:'PENDING',type:'WITHDRAW'}});
  await approveWithdrawal(adminId,pending.id);

  const after=await balances(playerId);
  expect(after.balance).toBe(before.balance-Number(pending.amount));
  expect(after.locked).toBe(before.locked-Number(pending.amount));
  expect(after.available).toBe(before.available);          // tiền đã bị khoá từ trước
  expect((await prisma.walletRequest.findUniqueOrThrow({where:{id:pending.id}})).status).toBe('APPROVED');
  expect(await prisma.walletLedger.count({where:{referenceId:pending.id,type:'WITHDRAW'}})).toBe(1);
 });

 it('REJECT: nhả khoá, số dư tổng không đổi',async()=>{
  const created=await createWithdrawal(playerId,{amount:1_000_000,...bank});
  const before=await balances(playerId);
  await rejectWithdrawal(adminId,created.id,'Sai thông tin tài khoản');

  const after=await balances(playerId);
  expect(after.balance).toBe(before.balance);
  expect(after.locked).toBe(before.locked-1_000_000);
  expect(after.available).toBe(before.available+1_000_000);
  expect((await prisma.walletRequest.findUniqueOrThrow({where:{id:created.id}})).status).toBe('REJECTED');
 });

 it('không duyệt được yêu cầu đã xử lý',async()=>{
  const done=await prisma.walletRequest.findFirstOrThrow({where:{userId:playerId,status:'APPROVED'}});
  await expect(approveWithdrawal(adminId,done.id)).rejects.toMatchObject({code:'REQUEST_ALREADY_REVIEWED'});
 });

 it('GET /api/wallet trả về đúng ba con số',async()=>{
  const token=(await request(app).post('/api/auth/login').send({username:player,password:'secret123'})).body.token;
  const body=(await request(app).get('/api/wallet').set('Authorization',`Bearer ${token}`).expect(200)).body;
  expect(body).toEqual(await getWallet(playerId));
  expect(body.availableBalance).toBe(body.balance-body.lockedBalance);
 });
});
