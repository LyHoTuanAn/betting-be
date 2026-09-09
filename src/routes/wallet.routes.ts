import {Router} from 'express';
import {z} from 'zod';
import {asyncRoute,jsonSafe} from '../lib/http.js';
import {prisma} from '../lib/prisma.js';
import {claimDaily,createWalletRequest} from '../services/wallet.service.js';

const router=Router(),amount=z.object({amount:z.number().int().min(50_000).max(100_000_000)});
router.post('/daily-bonus',asyncRoute(async(req,res)=>res.json(await claimDaily(req.auth!.userId))));
router.post('/deposit',asyncRoute(async(req,res)=>{const input=amount.parse(req.body),request=await createWalletRequest(req.auth!.userId,'DEPOSIT',input.amount);res.status(201).json({request:jsonSafe(request)})}));
router.post('/withdraw',asyncRoute(async(req,res)=>{const input=amount.parse(req.body),request=await createWalletRequest(req.auth!.userId,'WITHDRAW',input.amount);res.status(201).json({request:jsonSafe(request)})}));
router.get('/requests',asyncRoute(async(req,res)=>{const items=await prisma.walletRequest.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:100});res.json({items:jsonSafe(items)})}));
export default router;
