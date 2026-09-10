import {createHash, createHmac, randomBytes} from 'node:crypto';
import {GameType, Prisma} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';
import type {GameConfig} from './game-catalog.service.js';

const symbols = ['7','◆','♛','BAR','♕','✦'];
export const fishCatalog = {clown:3500,blue:5200,lion:7200,arowana:12000,manta:16000,turtle:22000,squid:28000,shark:32000,dragon:52000,dragoncarp:100000,mermaid:180000} as const;
type Tx = Prisma.TransactionClient;
type Outcome = {game:GameType;bet:number;payout:number;result:Prisma.InputJsonObject;serverProof:string};

function fairRandom(userId:string,requestId:string) {
  const seed=randomBytes(32).toString('hex');
  const proof=createHash('sha256').update(seed).digest('hex');
  const digest=createHmac('sha256',seed).update(`${userId}:${requestId}`).digest();
  return {value:digest.readUInt32BE(0)/0x1_0000_0000,seed,proof};
}

/** RTP lý thuyết của bộ tỉ lệ hiện hành; admin cần thấy con số này khi chỉnh. */
export const slotRtp=(config:GameConfig<'SLOT'>)=>(config.jackpotBp*config.jackpotX+config.bigWinBp*config.bigWinX+config.smallWinBp*config.smallWinX)/10_000;

export function slotOutcome(userId:string,requestId:string,bet:number,config:GameConfig<'SLOT'>):Outcome {
  const fair=fairRandom(userId,requestId),roll=Math.floor(fair.value*10000);
  const bigCut=config.jackpotBp+config.bigWinBp,smallCut=bigCut+config.smallWinBp;
  const outcome=roll<config.jackpotBp?'jackpot':roll<bigCut?'bigWin':roll<smallCut?'smallWin':'lose';
  const multiplier=outcome==='jackpot'?config.jackpotX:outcome==='bigWin'?config.bigWinX:outcome==='smallWin'?config.smallWinX:0;
  const grid=Array.from({length:15},(_,i)=>symbols[Math.floor((fair.value*1e9+i*7919)%symbols.length)]!);
  if(multiplier)grid[5]=grid[6]=grid[7]=symbols[Math.floor(fair.value*3)]!;
  return {game:'SLOT',bet,payout:Math.floor(bet*multiplier),result:{outcome,grid,serverSeed:fair.seed,algorithm:'HMAC-SHA256',rtp:slotRtp(config)},serverProof:fair.proof};
}

export function diceOutcome(userId:string,requestId:string,bet:number,side:'T'|'X',config:GameConfig<'DICE'>):Outcome {
  const fair=fairRandom(userId,requestId),digest=createHmac('sha256',fair.seed).update('dice').digest();
  const dice=[0,1,2].map(i=>(digest[i]!%6)+1),total=dice.reduce((sum,n)=>sum+n,0),result=total>=11?'T':'X';
  const payout=result===side?Math.floor(bet*config.payoutX):0;
  return {game:'DICE',bet,payout,result:{side,dice,total,result,serverSeed:fair.seed,algorithm:'HMAC-SHA256',rtp:config.payoutX/2},serverProof:fair.proof};
}

/** Ô đỏ của bánh xe European; phần còn lại là đen, riêng 0 là xanh. */
export const ROULETTE_RED=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36] as const;
export type RouletteBets=Record<string,number>;

const rouletteColor=(n:number)=>n===0?'green':(ROULETTE_RED as readonly number[]).includes(n)?'red':'black';

/**
 * Tổng tiền NHẬN LẠI (đã gồm tiền cược) cho một số trúng, khớp từng đồng với
 * bảng trả thưởng của giao diện. Số 0 làm thua mọi cửa ngoài cược thẳng — đó
 * chính là toàn bộ lợi thế nhà cái của roulette European.
 */
export function roulettePayout(bets:RouletteBets,winningNumber:number,config:GameConfig<'ROULETTE'>){
  const n=winningNumber,color=rouletteColor(n);
  let total=0;
  for(const [key,amount] of Object.entries(bets)){
    if(!amount||amount<=0)continue;
    const straight=Number(key);
    if(Number.isInteger(straight)&&String(straight)===key.trim()){
      if(straight===n)total+=amount*config.straightX;
      continue;
    }
    const dozen=key==='1st 12'?n>=1&&n<=12:key==='2nd 12'?n>=13&&n<=24:key==='3rd 12'?n>=25&&n<=36:null;
    if(dozen!==null){if(dozen)total+=amount*config.dozenX;continue}
    const even=key==='1-18'?n>=1&&n<=18
      :key==='19-36'?n>=19&&n<=36
      :key==='EVEN'?n>0&&n%2===0
      :key==='ODD'?n>0&&n%2!==0
      :key==='RED'?color==='red'
      :key==='BLACK'?color==='black':null;
    if(even!==null&&even)total+=amount*config.evenMoneyX;
  }
  return Math.floor(total);
}

/** Danh sách cửa hợp lệ; route dùng để chặn key rác trước khi trừ tiền. */
export const ROULETTE_OUTSIDE=['1st 12','2nd 12','3rd 12','1-18','19-36','EVEN','ODD','RED','BLACK'] as const;
export const isRouletteBetKey=(key:string)=>
  (ROULETTE_OUTSIDE as readonly string[]).includes(key)||/^(?:[0-9]|[12][0-9]|3[0-6])$/.test(key);

/**
 * RTP của nhóm cửa có lợi nhất cho người chơi. Với bộ tham số chuẩn cả ba nhóm
 * đều bằng 36/37; lấy giá trị lớn nhất vì đó là mức nhà cái thực sự phải chịu
 * khi admin chỉnh lệch các hệ số.
 */
export const rouletteRtp=(config:GameConfig<'ROULETTE'>)=>Math.max(
  config.straightX/37,
  config.dozenX*12/37,
  config.evenMoneyX*18/37
);

export function rouletteOutcome(userId:string,requestId:string,bets:RouletteBets,config:GameConfig<'ROULETTE'>):Outcome {
  const fair=fairRandom(userId,requestId);
  // Lấy số từ digest riêng thay vì fair.value để phép chia lấy dư trải đều 37 ô.
  const digest=createHmac('sha256',fair.seed).update('roulette').digest();
  const winningNumber=digest.readUInt32BE(0)%37;
  const bet=Object.values(bets).reduce((sum,amount)=>sum+amount,0);
  const payout=roulettePayout(bets,winningNumber,config);
  return {
    game:'ROULETTE',bet,payout,
    result:{winningNumber,color:rouletteColor(winningNumber),bets,serverSeed:fair.seed,algorithm:'HMAC-SHA256',rtp:rouletteRtp(config)},
    serverProof:fair.proof
  };
}

export function fishOutcome(userId:string,requestId:string,power:number,fishKind:keyof typeof fishCatalog|'miss',config:GameConfig<'FISH'>):Outcome {
  const fair=fairRandom(userId,requestId),base=fishKind==='miss'?0:fishCatalog[fishKind];
  const payout=base?Math.floor(base+power*config.powerBonus):0;
  const probability=base?Math.min(.78,power*config.rtp/payout):0;
  const killed=fair.value<probability;
  return {game:'FISH',bet:power,payout:killed?payout:0,result:{fishKind,killed,hit:killed,probability,serverSeed:fair.seed,algorithm:'HMAC-SHA256',rtp:config.rtp},serverProof:fair.proof};
}

/**
 * Shots in a shared room only pay out on the killing blow, so damage is sized
 * to make the whole health bar cost payout/RTP to chew through. That keeps the
 * 98% return of the single-shot model no matter how many players share a fish.
 */
export function fishDamage(power:number,kind:keyof typeof fishCatalog,maxHp:number,roll:number,config:GameConfig<'FISH'>) {
  const payout=Math.floor(fishCatalog[kind]+power*config.powerBonus);
  const shots=payout/(config.rtp*power);
  // The killing shot overshoots the health bar and that waste is never
  // refunded, costing the player half a shot on average. Subtract it — but only
  // once the fish takes enough shots that discreteness cannot round the return
  // back above the target. Below that the raw figure is used, which can only
  // ever land under 98%: over-gunning a cheap fish stays a bad trade, exactly
  // as the old probability cap made it.
  return maxHp/(shots>=5?shots-.5:shots)*(.85+roll*.3);
}

export function fishRoomShot(userId:string,requestId:string,power:number,fishKind:keyof typeof fishCatalog|'miss',killed:boolean,config:GameConfig<'FISH'>):Outcome {
  const fair=fairRandom(userId,requestId),base=fishKind==='miss'?0:fishCatalog[fishKind];
  return {
    game:'FISH',bet:power,payout:killed&&base?Math.floor(base+power*config.powerBonus):0,
    result:{fishKind,killed,hit:fishKind!=='miss',serverSeed:fair.seed,algorithm:'HMAC-SHA256',rtp:config.rtp},
    serverProof:fair.proof
  };
}

async function execute(tx:Tx,userId:string,requestId:string,outcome:Outcome) {
  const duplicate=await tx.gameRound.findUnique({where:{userId_requestId:{userId,requestId}}});
  if(duplicate){
    const old=duplicate.result as Record<string,unknown>,fresh=outcome.result as Record<string,unknown>;
    if(duplicate.game!==outcome.game||duplicate.bet!==BigInt(outcome.bet)||old.side!==fresh.side||old.fishKind!==fresh.fishKind)throw new AppError(409,'Idempotency key đã được dùng cho yêu cầu khác','IDEMPOTENCY_CONFLICT');
    return duplicate;
  }
  // Tiền đang bị khoá cho yêu cầu rút không được đem đi cược, nên điều kiện là
  // số dư KHẢ DỤNG chứ không phải `balance`. Prisma không so sánh được hai cột
  // trong `where` nên phải viết thẳng SQL.
  const bet=BigInt(outcome.bet);
  const debited=await tx.$executeRaw`
    UPDATE \`User\` SET \`balance\`=\`balance\`-${bet}, \`version\`=\`version\`+1
    WHERE \`id\`=${userId} AND \`status\`='ACTIVE' AND \`balance\`-\`lockedBalance\`>=${bet}`;
  if(!debited)throw new AppError(409,'Số dư không đủ hoặc tài khoản bị khóa','INSUFFICIENT_BALANCE');
  const afterBet=await tx.user.findUniqueOrThrow({where:{id:userId},select:{balance:true}});
  const round=await tx.gameRound.create({data:{userId,requestId,game:outcome.game,bet:outcome.bet,payout:outcome.payout,net:outcome.payout-outcome.bet,result:outcome.result,serverProof:outcome.serverProof}});
  await tx.walletLedger.create({data:{userId,type:'GAME_BET',amount:-BigInt(outcome.bet),balanceAfter:afterBet.balance,description:`Cược ${outcome.game}`,referenceId:round.id}});
  if(outcome.payout>0){
    const paid=await tx.user.update({where:{id:userId},data:{balance:{increment:BigInt(outcome.payout)},version:{increment:1}}});
    await tx.walletLedger.create({data:{userId,type:'GAME_PAYOUT',amount:BigInt(outcome.payout),balanceAfter:paid.balance,description:`Trả thưởng ${outcome.game}`,referenceId:round.id}});
  }
  return round;
}

export async function play(userId:string,requestId:string,outcome:Outcome) {
  if(!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))throw new AppError(422,'Idempotency key không hợp lệ','INVALID_IDEMPOTENCY_KEY');
  for(let attempt=0;attempt<3;attempt++){
    try{
      const round=await prisma.$transaction(tx=>execute(tx,userId,requestId,outcome),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
      const user=await prisma.user.findUniqueOrThrow({where:{id:userId},select:{balance:true}});
      return {round,balance:Number(user.balance)};
    }catch(error){
      if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2034','P2002'].includes(error.code)){if(attempt<2)continue;}
      throw error;
    }
  }
  throw new AppError(409,'Xung đột giao dịch, vui lòng thử lại','TRANSACTION_CONFLICT');
}
