import {Router} from 'express';
import {z} from 'zod';
import {asyncRoute,jsonSafe} from '../lib/http.js';
import {prisma} from '../lib/prisma.js';
import {createDeposit,createWithdrawal,getWallet} from '../services/wallet.service.js';

const MIN_AMOUNT=50_000,MAX_AMOUNT=100_000_000;
const vnd=(value:number)=>value.toLocaleString('vi-VN');

const amount=z.object({
  amount:z.number({error:'Số tiền là bắt buộc và phải là số'})
    .int('Số tiền phải là số nguyên, không có phần lẻ')
    .min(MIN_AMOUNT,`Số tiền tối thiểu là ${vnd(MIN_AMOUNT)} vàng`)
    .max(MAX_AMOUNT,`Số tiền tối đa là ${vnd(MAX_AMOUNT)} vàng`)
});

const withdrawSchema=amount.extend({
  bankName:z.string().default(''),
  accountNumber:z.string().default(''),
  accountName:z.string().default('')
});

const router=Router();

router.get('/',asyncRoute(async(req,res)=>{
  res.json(await getWallet(req.auth!.userId));
}));

router.post('/deposit',asyncRoute(async(req,res)=>{
  const input=amount.parse(req.body);
  const request=await createDeposit(req.auth!.userId,input.amount);
  res.status(201).json({request:jsonSafe(request)});
}));

router.post('/withdraw',asyncRoute(async(req,res)=>{
  const input=withdrawSchema.parse(req.body);
  const request=await createWithdrawal(req.auth!.userId,input);
  res.status(201).json({request:jsonSafe(request)});
}));

router.get('/requests',asyncRoute(async(req,res)=>{
  const items=await prisma.walletRequest.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:100});
  res.json({items:jsonSafe(items)});
}));

export default router;
