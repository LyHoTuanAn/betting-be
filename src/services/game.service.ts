import {createHash, createHmac, randomBytes} from 'node:crypto';
import {GameType, Prisma} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {AppError} from '../lib/http.js';
import type {GameConfig} from './game-catalog.service.js';

const symbols = ['7','◆','♛','BAR','♕','✦'];
export const fishCatalog = {clown:3500,blue:5200,lion:7200,arowana:12000,manta:16000,turtle:22000,squid:28000,shark:32000,dragon:52000,dragoncarp:100000,mermaid:180000} as const;
type Tx = Prisma.TransactionClient;
export type Outcome = {game:GameType;bet:number;payout:number;result:Prisma.InputJsonObject;serverProof:string};

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

/**
 * Sáu linh vật theo đúng thứ tự mặt xúc xắc của client (MASCOT_LIST): chỉ số
 * trong mảng này chính là con số server trả về, nên đổi thứ tự ở đây là đổi
 * luôn hình hiện trên bàn.
 */
export const BAUCUA_MASCOTS=['NAI','BAU','GA','CA','CUA','TOM'] as const;
export type BauCuaMascot=typeof BAUCUA_MASCOTS[number];
export type BauCuaBets=Record<string,number>;

/** Cửa "bão" ăn khi cả ba mặt giống nhau, bất kể là con gì. */
export const BAUCUA_TRIPLE_KEY='TRIPLE_ANY';
export const isBauCuaBetKey=(key:string)=>
  key===BAUCUA_TRIPLE_KEY||(BAUCUA_MASCOTS as readonly string[]).includes(key);

/**
 * Tổng tiền NHẬN LẠI (đã gồm tiền cược) của một lần lắc. Cửa linh vật ăn theo
 * SỐ MẶT trùng — ra hai con cua thì cửa cua nhận gấp đôi mức một con — nên ba
 * hệ số oneX/twoX/threeX là ba bậc riêng chứ không nhân tuyến tính; admin hạ
 * đúng một bậc là siết đúng một trường hợp.
 */
export function baucuaPayout(bets:BauCuaBets,dice:number[],config:GameConfig<'BAUCUA'>){
  const isTriple=dice[0]===dice[1]&&dice[1]===dice[2];
  const stepX=[0,config.oneX,config.twoX,config.threeX];
  let total=0;
  for(const [key,amount] of Object.entries(bets)){
    if(!amount||amount<=0)continue;
    if(key===BAUCUA_TRIPLE_KEY){if(isTriple)total+=amount*config.tripleX;continue}
    const face=(BAUCUA_MASCOTS as readonly string[]).indexOf(key);
    if(face<0)continue;
    const matches=dice.filter(die=>die===face).length;
    if(matches)total+=amount*stepX[matches]!;
  }
  return Math.floor(total);
}

/**
 * RTP của cửa có lợi nhất cho người chơi, cùng cách tính với roulette. Với ba
 * xúc xắc sáu mặt, xác suất một cửa linh vật trúng đúng k mặt (tính trên 216
 * tổ hợp) là 75/15/1, còn bão bất kỳ là 6/216 — nên bộ mặc định 2/3/4/31 cho
 * 199/216 ≈ 92,1% ở cửa linh vật và 31/36 ≈ 86,1% ở cửa bão.
 */
export const baucuaRtp=(config:GameConfig<'BAUCUA'>)=>Math.max(
  (75*config.oneX+15*config.twoX+config.threeX)/216,
  config.tripleX*6/216
);

export function baucuaOutcome(userId:string,requestId:string,bets:BauCuaBets,config:GameConfig<'BAUCUA'>):Outcome {
  const fair=fairRandom(userId,requestId);
  // Mỗi mặt lấy từ một đoạn 32 bit riêng của digest thay vì từng byte, để phép
  // chia lấy dư cho 6 không lệch thấy được như khi chỉ có 256 giá trị đầu vào.
  const digest=createHmac('sha256',fair.seed).update('baucua').digest();
  const dice=[0,1,2].map(i=>digest.readUInt32BE(i*4)%6);
  const counts=Object.fromEntries(BAUCUA_MASCOTS.map((key,face)=>[key,dice.filter(die=>die===face).length]));
  const bet=Object.values(bets).reduce((sum,amount)=>sum+amount,0);
  return {
    game:'BAUCUA',bet,payout:baucuaPayout(bets,dice,config),
    result:{
      dice,faces:dice.map(face=>BAUCUA_MASCOTS[face]!),counts,
      isTriple:dice[0]===dice[1]&&dice[1]===dice[2],bets,
      serverSeed:fair.seed,algorithm:'HMAC-SHA256',rtp:baucuaRtp(config)
    },
    serverProof:fair.proof
  };
}

/**
 * Một lần lắc dùng chung cho cả bàn: sinh đúng một seed rồi suy ra ba mặt, nên
 * mọi người trong phòng thấy cùng kết quả và ai cũng kiểm lại được bằng cặp
 * seed/proof giống hệt ván đơn. Phòng bốc seed một lần thay vì mỗi người một
 * lần — nếu để `baucuaOutcome` chạy cho từng người thì mỗi ghế ra một kiểu.
 */
export function baucuaRoomRoll(roomId:string,roundNo:number){
  const seed=randomBytes(32).toString('hex');
  const proof=createHash('sha256').update(seed).digest('hex');
  const digest=createHmac('sha256',seed).update(`${roomId}:${roundNo}`).digest();
  return {dice:[0,1,2].map(i=>digest.readUInt32BE(i*4)%6),seed,proof};
}

/** Phần thắng thua của MỘT người trong phòng, tính trên ba mặt cả bàn đã lắc. */
export function baucuaRoomOutcome(bets:BauCuaBets,roll:ReturnType<typeof baucuaRoomRoll>,roomId:string,roundNo:number,config:GameConfig<'BAUCUA'>):Outcome {
  const {dice,seed,proof}=roll;
  return {
    game:'BAUCUA',
    bet:Object.values(bets).reduce((sum,amount)=>sum+amount,0),
    payout:baucuaPayout(bets,dice,config),
    result:{
      dice,faces:dice.map(face=>BAUCUA_MASCOTS[face]!),
      counts:Object.fromEntries(BAUCUA_MASCOTS.map((key,face)=>[key,dice.filter(die=>die===face).length])),
      isTriple:dice[0]===dice[1]&&dice[1]===dice[2],bets,
      roomId,roundNo,serverSeed:seed,algorithm:'HMAC-SHA256',rtp:baucuaRtp(config)
    },
    serverProof:proof
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
      const round=await prisma.$transaction(tx=>execute(tx,userId,requestId,outcome),{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
      const user=await prisma.user.findUniqueOrThrow({where:{id:userId},select:{balance:true}});
      return {round,balance:Number(user.balance)};
    }catch(error){
      if(error instanceof Prisma.PrismaClientKnownRequestError&&['P2034','P2002'].includes(error.code)){if(attempt<2)continue;}
      throw error;
    }
  }
  throw new AppError(409,'Xung đột giao dịch, vui lòng thử lại','TRANSACTION_CONFLICT');
}
