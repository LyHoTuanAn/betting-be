import {Router,type Request} from 'express';
import {z} from 'zod';
import {asyncRoute, AppError, jsonSafe} from '../lib/http.js';
import {fishCatalog,fishOutcome,diceOutcome,play,slotOutcome} from '../services/game.service.js';
import {loadGames,requireEnabledGame,assertBet,type GameConfig} from '../services/game-catalog.service.js';
import {prisma} from '../lib/prisma.js';

const router=Router();
const key=(req:Request)=>String(req.get('x-idempotency-key')||req.body.requestId||'');

/** Sảnh chỉ vẽ những game admin đang bật, kèm hạn mức cược để client hiển thị đúng. */
router.get('/catalog',asyncRoute(async(_req,res)=>{
  const games=[...(await loadGames()).values()].filter(game=>game.enabled).sort((a,b)=>a.sortOrder-b.sortOrder);
  res.json({games:games.map(({key,name,subtitle,minBet,maxBet})=>({key,name,subtitle,minBet,maxBet}))});
}));

router.post('/slot/spin',asyncRoute(async(req,res)=>{
  const game=await requireEnabledGame('SLOT');
  const {bet}=z.object({bet:z.number().int()}).parse(req.body);
  assertBet(game,bet);
  const outcome=slotOutcome(req.auth!.userId,key(req),bet,game.config as GameConfig<'SLOT'>);
  const data=await play(req.auth!.userId,key(req),outcome),result=data.round.result as any;
  res.json({outcome:result.outcome,grid:result.grid,payout:Number(data.round.payout),balance:data.balance,roundId:data.round.id,proof:data.round.serverProof});
}));

router.post('/dice/play',asyncRoute(async(req,res)=>{
  const game=await requireEnabledGame('DICE');
  const input=z.object({bet:z.number().int(),side:z.enum(['T','X'])}).parse(req.body);
  assertBet(game,input.bet);
  const outcome=diceOutcome(req.auth!.userId,key(req),input.bet,input.side,game.config as GameConfig<'DICE'>);
  const data=await play(req.auth!.userId,key(req),outcome),result=data.round.result as any;
  res.json({...result,payout:Number(data.round.payout),balance:data.balance,roundId:data.round.id,proof:data.round.serverProof});
}));

router.post('/fish/shoot',asyncRoute(async(req,res)=>{
  const game=await requireEnabledGame('FISH');
  const kinds=Object.keys(fishCatalog) as [keyof typeof fishCatalog,...(keyof typeof fishCatalog)[]];
  const input=z.object({power:z.number().int(),fishKind:z.union([z.enum(kinds),z.literal('miss')])}).parse(req.body);
  assertBet(game,input.power);
  const outcome=fishOutcome(req.auth!.userId,key(req),input.power,input.fishKind,game.config as GameConfig<'FISH'>);
  const data=await play(req.auth!.userId,key(req),outcome),result=data.round.result as any;
  res.json({...result,payout:Number(data.round.payout),balance:data.balance,roundId:data.round.id,proof:data.round.serverProof});
}));

router.get('/history',asyncRoute(async(req,res)=>{const limit=z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit),items=await prisma.gameRound.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:limit});res.json({items:jsonSafe(items)})}));
router.get('/verify/:id',asyncRoute(async(req,res)=>{const round=await prisma.gameRound.findFirst({where:{id:String(req.params.id),userId:req.auth!.userId}});if(!round)throw new AppError(404,'Không tìm thấy ván chơi','ROUND_NOT_FOUND');res.json({round:jsonSafe(round),verification:'SHA256(serverSeed) phải trùng serverProof'})}));
export default router;
