import {Prisma} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';
import {extractUsernameCandidates,type ParsedDeposit} from './timo-email.parser.js';

export type RecordOutcome=
  |{result:'DUPLICATE';bankTransactionId:string}
  |{result:'COMPLETED';depositId:string;userId:string;username:string;amount:number}
  |{result:'UNMATCHED';depositId:string;transferContent:string;amount:number};

/** Tìm người chơi theo nội dung chuyển khoản, ưu tiên ứng viên khớp cả chuỗi. */
async function findUserByTransferContent(tx:Prisma.TransactionClient,transferContent:string){
  const candidates=extractUsernameCandidates(transferContent);
  if(!candidates.length)return null;
  const users=await tx.user.findMany({where:{username:{in:candidates}},select:{id:true,username:true,status:true}});
  if(!users.length)return null;
  // Giữ đúng thứ tự ưu tiên của candidates chứ không theo thứ tự CSDL trả về:
  // ứng viên khớp nguyên nội dung (luật của SRS) phải thắng token bắt được thêm.
  for(const candidate of candidates){
    const user=users.find(row=>row.username===candidate);
    if(user)return user;
  }
  return null;
}

/**
 * Ghi nhận một giao dịch tiền vào và cộng tiền nếu khớp được người chơi.
 *
 * Toàn bộ nằm trong một transaction CSDL (SRS mục 19) để không bao giờ xảy ra
 * trạng thái "đã tạo giao dịch nhưng chưa cộng tiền" hoặc ngược lại. Chống cộng
 * trùng dựa vào UNIQUE(bankTransactionId) chứ không dựa vào việc đọc trước —
 * hai worker chạy song song vẫn an toàn.
 */
export async function recordBankDeposit(parsed:ParsedDeposit):Promise<RecordOutcome>{
  try{
    return await prisma.$transaction(async tx=>{
      const existing=await tx.bankDeposit.findUnique({where:{bankTransactionId:parsed.bankTransactionId},select:{id:true}});
      if(existing)return {result:'DUPLICATE',bankTransactionId:parsed.bankTransactionId} as const;

      const amount=BigInt(parsed.amount);
      const user=await findUserByTransferContent(tx,parsed.transferContent);

      // Tài khoản bị khoá vẫn không được cộng tiền tự động; để UNMATCHED cho
      // admin quyết định thay vì âm thầm nạp vào một tài khoản đang bị đình chỉ.
      if(!user||user.status!=='ACTIVE'){
        const deposit=await tx.bankDeposit.create({data:{
          bankTransactionId:parsed.bankTransactionId,amount,transferContent:parsed.transferContent,
          transactionTime:parsed.transactionTime,status:'UNMATCHED',emailSubject:parsed.emailSubject||null
        }});
        return {result:'UNMATCHED',depositId:deposit.id,transferContent:parsed.transferContent,amount:parsed.amount} as const;
      }

      const deposit=await tx.bankDeposit.create({data:{
        bankTransactionId:parsed.bankTransactionId,amount,transferContent:parsed.transferContent,
        transactionTime:parsed.transactionTime,status:'COMPLETED',userId:user.id,matchedAt:new Date(),
        emailSubject:parsed.emailSubject||null
      }});
      const updated=await tx.user.update({where:{id:user.id},data:{balance:{increment:amount},version:{increment:1}}});
      await tx.walletLedger.create({data:{
        userId:user.id,type:'DEPOSIT',amount,balanceAfter:updated.balance,
        description:`Nạp tiền qua ${parsed.bankTransactionId}`,referenceId:deposit.id
      }});
      return {result:'COMPLETED',depositId:deposit.id,userId:user.id,username:user.username,amount:parsed.amount} as const;
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  }catch(error){
    // Hai lần đọc cùng một email chạm nhau: bản ghi kia đã thắng, coi như trùng.
    if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')
      return {result:'DUPLICATE',bankTransactionId:parsed.bankTransactionId};
    throw error;
  }
}

/**
 * Admin gán một giao dịch UNMATCHED cho người chơi (SRS mục 7). Cộng tiền theo
 * đúng đường đi của luồng tự động để lịch sử ví không có hai kiểu bản ghi.
 */
export async function matchDepositManually(adminId:string,depositId:string,username:string){
  return prisma.$transaction(async tx=>{
    const deposit=await tx.bankDeposit.findUnique({where:{id:depositId}});
    if(!deposit)throw new AppError(404,'Không tìm thấy giao dịch','DEPOSIT_NOT_FOUND');
    if(deposit.status!=='UNMATCHED')throw new AppError(409,'Giao dịch đã được xử lý','DEPOSIT_ALREADY_MATCHED');

    const user=await tx.user.findUnique({where:{username},select:{id:true,username:true,status:true}});
    if(!user)throw new AppError(404,'Không tìm thấy người chơi','USER_NOT_FOUND');
    if(user.status!=='ACTIVE')throw new AppError(409,'Tài khoản người chơi đang bị khoá','ACCOUNT_SUSPENDED');

    const updated=await tx.user.update({where:{id:user.id},data:{balance:{increment:deposit.amount},version:{increment:1}}});
    await tx.walletLedger.create({data:{
      userId:user.id,type:'DEPOSIT',amount:deposit.amount,balanceAfter:updated.balance,
      description:`Nạp tiền qua ${deposit.bankTransactionId} (admin khớp tay)`,referenceId:deposit.id
    }});
    return tx.bankDeposit.update({where:{id:depositId},data:{
      status:'COMPLETED',userId:user.id,matchedAt:new Date(),resolvedById:adminId,resolvedAt:new Date()
    }});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

/** Tài khoản Timo đang bật để hiển thị ở trang nạp tiền (SRS mục 2.1). */
export async function getActiveBankAccount(){
  const account=await prisma.bankAccount.findFirst({where:{isActive:true},orderBy:{createdAt:'desc'}});
  if(!account)throw new AppError(503,'Hệ thống chưa cấu hình tài khoản nhận tiền','BANK_ACCOUNT_UNSET');
  return account;
}
