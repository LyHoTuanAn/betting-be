import {Router} from 'express';
import {z} from 'zod';
import {config} from '../config.js';
import {asyncRoute,jsonSafe} from '../lib/http.js';
import {prisma} from '../lib/prisma.js';
import {claimDaily,createWithdrawal,getWallet} from '../services/wallet.service.js';
import {getActiveBankAccount} from '../services/bank-deposit.service.js';

const router=Router();
const vnd=(value:number)=>value.toLocaleString('vi-VN');

// SRS mục 22 — GET /api/wallet
router.get('/',asyncRoute(async(req,res)=>res.json(await getWallet(req.auth!.userId))));

/**
 * SRS mục 2.1 — thông tin để người chơi chuyển khoản. Nội dung chuyển khoản do
 * server phát ra chứ không để client tự ghép: sai một ký tự là giao dịch rơi vào
 * UNMATCHED và phải chờ admin xử lý tay.
 */
router.get('/deposit-info',asyncRoute(async(req,res)=>{
  const [account,user]=await Promise.all([
    getActiveBankAccount(),
    prisma.user.findUniqueOrThrow({where:{id:req.auth!.userId},select:{username:true}})
  ]);
  res.json({
    bankName:account.bankName,accountNumber:account.accountNumber,accountName:account.accountName,
    transferContent:user.username,
    note:account.transferContentDescription
  });
}));

router.get('/transactions',asyncRoute(async(req,res)=>{
  const limit=z.coerce.number().int().min(1).max(100).default(100).parse(req.query.limit);
  const items=await prisma.walletLedger.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:limit});
  res.json({items:jsonSafe(items)});
}));

// Nói thẳng hạn mức và định dạng trong thông báo: người nhập sai cần biết ngưỡng
// hợp lệ là bao nhiêu, chứ "Dữ liệu không hợp lệ" thì họ chỉ có thể đoán.
const withdrawSchema=z.object({
  amount:z.number({error:'Số tiền rút là bắt buộc và phải là số'})
    .int('Số tiền rút phải là số nguyên, không có phần lẻ')
    .min(config.WITHDRAW_MIN,`Số tiền rút tối thiểu là ${vnd(config.WITHDRAW_MIN)} vàng`)
    .max(config.WITHDRAW_MAX,`Số tiền rút tối đa là ${vnd(config.WITHDRAW_MAX)} vàng`),
  bankName:z.string({error:'Tên ngân hàng là bắt buộc'}).trim()
    .min(2,'Tên ngân hàng phải có ít nhất 2 ký tự').max(80,'Tên ngân hàng tối đa 80 ký tự'),
  accountNumber:z.string({error:'Số tài khoản là bắt buộc'}).trim()
    .regex(/^[0-9]{6,32}$/,'Số tài khoản chỉ gồm 6-32 chữ số, không có khoảng trắng'),
  accountName:z.string({error:'Tên chủ tài khoản là bắt buộc'}).trim()
    .min(2,'Tên chủ tài khoản phải có ít nhất 2 ký tự').max(80,'Tên chủ tài khoản tối đa 80 ký tự')
});

router.post('/withdraw',asyncRoute(async(req,res)=>{
  const input=withdrawSchema.parse(req.body);
  const request=await createWithdrawal(req.auth!.userId,input);
  res.status(201).json({request:jsonSafe(request),wallet:await getWallet(req.auth!.userId)});
}));

router.get('/withdrawals',asyncRoute(async(req,res)=>{
  const items=await prisma.walletRequest.findMany({
    where:{userId:req.auth!.userId,type:'WITHDRAW'},orderBy:{createdAt:'desc'},take:100
  });
  res.json({items:jsonSafe(items)});
}));

/** Lịch sử nạp của chính người chơi, để đối chiếu với giao dịch ngân hàng. */
router.get('/deposits',asyncRoute(async(req,res)=>{
  const items=await prisma.bankDeposit.findMany({
    where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:100
  });
  res.json({items:jsonSafe(items)});
}));

router.post('/daily-bonus',asyncRoute(async(req,res)=>res.json(await claimDaily(req.auth!.userId))));

export default router;
