import {Prisma, type WalletRequestStatus, type WalletRequestType} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';

export async function claimDaily(userId:string){
  const claimDate=new Date();claimDate.setUTCHours(0,0,0,0);const amount=100_000n;
  try{return await prisma.$transaction(async tx=>{
    const claim=await tx.dailyClaim.create({data:{userId,claimDate,amount}});
    const user=await tx.user.update({where:{id:userId},data:{balance:{increment:amount},version:{increment:1}}});
    await tx.walletLedger.create({data:{userId,type:'DAILY_BONUS',amount,balanceAfter:user.balance,description:'Quà đăng nhập hằng ngày',referenceId:claim.id}});
    return {amount:Number(amount),balance:Number(user.balance),nextAt:new Date(claimDate.getTime()+86_400_000)};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
  catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new AppError(409,'Bạn đã nhận quà hôm nay','DAILY_ALREADY_CLAIMED');throw error;}
}

export async function createWalletRequest(userId:string,type:WalletRequestType,amount:number){
  return prisma.$transaction(async tx=>{
    if(type==='WITHDRAW'){
      const reserved=await tx.user.updateMany({where:{id:userId,balance:{gte:BigInt(amount)}},data:{balance:{decrement:BigInt(amount)},version:{increment:1}}});
      if(!reserved.count)throw new AppError(409,'Số dư không đủ','INSUFFICIENT_BALANCE');
      const user=await tx.user.findUniqueOrThrow({where:{id:userId},select:{balance:true}});
      const request=await tx.walletRequest.create({data:{userId,type,amount}});
      await tx.walletLedger.create({data:{userId,type:'WITHDRAW',amount:-BigInt(amount),balanceAfter:user.balance,description:'Giữ tiền cho yêu cầu rút',referenceId:request.id}});return request;
    }
    return tx.walletRequest.create({data:{userId,type,amount}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function reviewWalletRequest(adminId:string,id:string,status:Exclude<WalletRequestStatus,'PENDING'>,note?:string){
  return prisma.$transaction(async tx=>{
    const request=await tx.walletRequest.findUnique({where:{id}});if(!request)throw new AppError(404,'Không tìm thấy yêu cầu','REQUEST_NOT_FOUND');
    if(request.status!=='PENDING')throw new AppError(409,'Yêu cầu đã được xử lý','REQUEST_ALREADY_REVIEWED');
    if(request.type==='DEPOSIT'&&status==='APPROVED'){
      const user=await tx.user.update({where:{id:request.userId},data:{balance:{increment:request.amount},version:{increment:1}}});
      await tx.walletLedger.create({data:{userId:request.userId,type:'DEPOSIT',amount:request.amount,balanceAfter:user.balance,description:'Nạp tiền được duyệt',referenceId:id}});
    }
    if(request.type==='WITHDRAW'&&status==='REJECTED'){
      const user=await tx.user.update({where:{id:request.userId},data:{balance:{increment:request.amount},version:{increment:1}}});
      await tx.walletLedger.create({data:{userId:request.userId,type:'REFUND',amount:request.amount,balanceAfter:user.balance,description:'Hoàn tiền yêu cầu rút bị từ chối',referenceId:id}});
    }
    return tx.walletRequest.update({where:{id},data:{status,note,reviewedById:adminId,reviewedAt:new Date()}});
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
