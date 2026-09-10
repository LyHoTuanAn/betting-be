import {Prisma} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';

/**
 * Ví có hai con số: `balance` là tổng tiền đang đứng tên người chơi, còn
 * `lockedBalance` là phần trong đó đã bị giữ cho các yêu cầu rút chưa xử lý
 * xong. Số tiêu được luôn là hiệu của hai số này (SRS mục 11).
 */
export const walletView=(user:{balance:bigint;lockedBalance:bigint})=>({
  balance:Number(user.balance),
  lockedBalance:Number(user.lockedBalance),
  availableBalance:Number(user.balance-user.lockedBalance)
});

export async function getWallet(userId:string){
  const user=await prisma.user.findUniqueOrThrow({where:{id:userId},select:{balance:true,lockedBalance:true}});
  return walletView(user);
}

/** Quà đăng nhập hằng ngày. UNIQUE(userId, claimDate) chặn nhận hai lần/ngày. */
export async function claimDaily(userId:string){
  const claimDate=new Date();claimDate.setUTCHours(0,0,0,0);const amount=100_000n;
  try{return await prisma.$transaction(async tx=>{
    const claim=await tx.dailyClaim.create({data:{userId,claimDate,amount}});
    const user=await tx.user.update({where:{id:userId},data:{balance:{increment:amount},version:{increment:1}}});
    await tx.walletLedger.create({data:{userId,type:'DAILY_BONUS',amount,balanceAfter:user.balance,description:'Quà đăng nhập hằng ngày',referenceId:claim.id}});
    return {amount:Number(amount),...walletView(user),nextAt:new Date(claimDate.getTime()+86_400_000)};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
  catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new AppError(409,'Bạn đã nhận quà hôm nay','DAILY_ALREADY_CLAIMED');throw error;}
}

export async function createDeposit(userId:string,amount:number){
  if(amount<=0)throw new AppError(422,'Số tiền nạp phải lớn hơn 0','INVALID_AMOUNT');
  return prisma.walletRequest.create({data:{userId,type:'DEPOSIT',amount:BigInt(amount)}});
}

export type WithdrawalInput={amount:number;bankName:string;accountNumber:string;accountName:string};

/**
 * Tạo yêu cầu rút và khoá tiền ngay (SRS mục 10–11).
 *
 * Điều kiện đủ tiền nằm trong chính câu UPDATE thay vì đọc rồi mới ghi: hai yêu
 * cầu rút gửi cùng lúc không thể cùng thấy số dư cũ rồi khoá vượt quá số dư.
 * Phải viết SQL thô vì Prisma không so sánh được hai cột với nhau trong `where`.
 */
export async function createWithdrawal(userId:string,input:WithdrawalInput){
  if(input.amount<=0)throw new AppError(422,'Số tiền rút phải lớn hơn 0','INVALID_AMOUNT');
  const amount=BigInt(input.amount);
  return prisma.$transaction(async tx=>{
    const locked=await tx.$executeRaw`
      UPDATE \`User\` SET \`lockedBalance\`=\`lockedBalance\`+${amount}, \`version\`=\`version\`+1
      WHERE \`id\`=${userId} AND \`status\`='ACTIVE' AND \`balance\`-\`lockedBalance\`>=${amount}`;
    if(!locked)throw new AppError(409,'Số dư khả dụng không đủ','INSUFFICIENT_BALANCE');
    return tx.walletRequest.create({data:{
      userId,type:'WITHDRAW',amount,
      bankName:input.bankName,accountNumber:input.accountNumber,accountName:input.accountName
    }});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

async function loadPendingWithdrawal(tx:Prisma.TransactionClient,id:string){
  const request=await tx.walletRequest.findUnique({where:{id}});
  if(!request||request.type!=='WITHDRAW')throw new AppError(404,'Không tìm thấy yêu cầu rút','REQUEST_NOT_FOUND');
  if(request.status!=='PENDING')throw new AppError(409,'Yêu cầu đã được xử lý','REQUEST_ALREADY_REVIEWED');
  return request;
}

/**
 * Admin đã chuyển tiền tay xong và xác nhận (SRS mục 15): tiền rời khỏi ví thật
 * sự, nên trừ cả `balance` lẫn `lockedBalance` — số khả dụng giữ nguyên vì phần
 * này đã bị khoá từ lúc tạo yêu cầu.
 */
export async function approveWithdrawal(adminId:string,id:string,note?:string){
  return prisma.$transaction(async tx=>{
    const request=await loadPendingWithdrawal(tx,id);
    const settled=await tx.$executeRaw`
      UPDATE \`User\` SET \`balance\`=\`balance\`-${request.amount}, \`lockedBalance\`=\`lockedBalance\`-${request.amount}, \`version\`=\`version\`+1
      WHERE \`id\`=${request.userId} AND \`lockedBalance\`>=${request.amount}`;
    if(!settled)throw new AppError(409,'Số tiền khoá không khớp, không thể duyệt','LOCKED_BALANCE_MISMATCH');
    const user=await tx.user.findUniqueOrThrow({where:{id:request.userId},select:{balance:true}});
    await tx.walletLedger.create({data:{
      userId:request.userId,type:'WITHDRAW',amount:-request.amount,balanceAfter:user.balance,
      description:'Rút tiền đã được duyệt',referenceId:request.id
    }});
    return tx.walletRequest.update({where:{id},data:{status:'APPROVED',note,reviewedById:adminId,reviewedAt:new Date()}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

/** Từ chối và mở khoá tiền (SRS mục 16): `balance` không đổi, chỉ nhả khoá. */
export async function rejectWithdrawal(adminId:string,id:string,note?:string){
  return prisma.$transaction(async tx=>{
    const request=await loadPendingWithdrawal(tx,id);
    const released=await tx.$executeRaw`
      UPDATE \`User\` SET \`lockedBalance\`=\`lockedBalance\`-${request.amount}, \`version\`=\`version\`+1
      WHERE \`id\`=${request.userId} AND \`lockedBalance\`>=${request.amount}`;
    if(!released)throw new AppError(409,'Số tiền khoá không khớp, không thể từ chối','LOCKED_BALANCE_MISMATCH');
    return tx.walletRequest.update({where:{id},data:{status:'REJECTED',note,reviewedById:adminId,reviewedAt:new Date()}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
