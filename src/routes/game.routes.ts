import {Router,type Request} from 'express';
import {z} from 'zod';
import {asyncRoute, AppError, jsonSafe} from '../lib/http.js';
import {fishCatalog,fishOutcome,diceOutcome,play,slotOutcome,rouletteOutcome,isRouletteBetKey} from '../services/game.service.js';
import {loadGames,requireEnabledGame,assertBet,type GameConfig} from '../services/game-catalog.service.js';
import {dealHand,actionHand,getActiveHandForUser,evaluate7Cards} from '../services/poker.service.js';
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

/**
 * Một ván roulette là đặt nhiều cửa rồi quay đúng một lần, nên vẫn nằm gọn
 * trong mô hình play(): tổng tiền các cửa là tiền cược, tổng trả thưởng là
 * payout. Số trúng do server sinh — client không được phép tự quyết.
 */
const rouletteBody=z.object({
  bets:z.record(z.string(),z.number().int().positive('Tiền cược mỗi cửa phải lớn hơn 0'))
    .refine(bets=>Object.keys(bets).length>0,{message:'Bạn chưa đặt cửa nào'})
    .refine(bets=>Object.keys(bets).every(isRouletteBetKey),{message:'Có cửa cược không hợp lệ'})
});

router.post('/roulette/spin',asyncRoute(async(req,res)=>{
  const game=await requireEnabledGame('ROULETTE');
  const {bets}=rouletteBody.parse(req.body);
  // Hạn mức áp cho TỔNG tiền đặt của cả ván, không phải từng cửa.
  assertBet(game,Object.values(bets).reduce((sum,amount)=>sum+amount,0));
  const outcome=rouletteOutcome(req.auth!.userId,key(req),bets,game.config as GameConfig<'ROULETTE'>);
  const data=await play(req.auth!.userId,key(req),outcome),result=data.round.result as any;
  res.json({
    winningNumber:result.winningNumber,color:result.color,
    bet:Number(data.round.bet),payout:Number(data.round.payout),
    balance:data.balance,roundId:data.round.id,proof:data.round.serverProof
  });
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

router.get('/poker/active',asyncRoute(async(req,res)=>{
  const active=getActiveHandForUser(req.auth!.userId);
  if(!active)return res.json({active:null});
  const curEval=evaluate7Cards([...active.heroCards,...active.communityCards.slice(0,active.revealedCount)]);
  res.json({
    active:{
      handId:active.id,
      stage:active.stage,
      heroHand:active.heroCards,
      communityCards:active.communityCards.slice(0,active.revealedCount),
      handRank:curEval.name,
      pot:active.pot,
      currentBet:active.currentBet,
      totalBet:active.totalBet
    }
  });
}));

router.post('/poker/deal',asyncRoute(async(req,res)=>{
  const game=await requireEnabledGame('POKER');
  const {ante}=z.object({ante:z.number().int().positive()}).parse(req.body);
  assertBet(game,ante);
  const data=await dealHand(req.auth!.userId,ante,game.config as GameConfig<'POKER'>);
  res.json(data);
}));

router.post('/poker/action',asyncRoute(async(req,res)=>{
  const game=await requireEnabledGame('POKER');
  const body=z.object({
    handId:z.string().min(1),
    action:z.enum(['check','call','raise','allin','fold']),
    amount:z.number().int().optional()
  }).parse(req.body);
  const data=await actionHand(req.auth!.userId,body,game.config as GameConfig<'POKER'>);
  res.json(data);
}));

router.get('/history',asyncRoute(async(req,res)=>{const limit=z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit),items=await prisma.gameRound.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:limit});res.json({items:jsonSafe(items)})}));
router.get('/verify/:id',asyncRoute(async(req,res)=>{const round=await prisma.gameRound.findFirst({where:{id:String(req.params.id),userId:req.auth!.userId}});if(!round)throw new AppError(404,'Không tìm thấy ván chơi','ROUND_NOT_FOUND');res.json({round:jsonSafe(round),verification:'SHA256(serverSeed) phải trùng serverProof'})}));
export default router;
