import {Router} from 'express';
import {z} from 'zod';
import {GameType} from '@prisma/client';
import {asyncRoute,jsonSafe,AppError} from '../lib/http.js';
import {prisma} from '../lib/prisma.js';
import {approveWithdrawal,rejectWithdrawal} from '../services/wallet.service.js';
import {matchDepositManually} from '../services/bank-deposit.service.js';
import {readerStats} from '../services/email-reader.service.js';
import {loadGames,invalidateGameCache,configSchemas,gameDefaults,type GameConfig} from '../services/game-catalog.service.js';
import {slotRtp,rouletteRtp} from '../services/game.service.js';
import {getAllBannersAdmin, getAllEventsAdmin} from '../services/content.service.js';

const router=Router();

/** RTP lý thuyết để admin thấy ngay hệ quả của bộ tham số vừa nhập. */
const theoreticalRtp=(key:GameType,config:GameConfig)=>
  key==='SLOT'?slotRtp(config as GameConfig<'SLOT'>)
  :key==='DICE'?(config as GameConfig<'DICE'>).payoutX/2
  :key==='ROULETTE'?rouletteRtp(config as GameConfig<'ROULETTE'>)
  :(config as GameConfig<'FISH'>).rtp;

router.get('/stats',asyncRoute(async(_req,res)=>{
  const [users,suspended,pending,unmatched,rounds,wagered] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({where:{status:'SUSPENDED'}}),
    prisma.walletRequest.count({where:{status:'PENDING',type:'WITHDRAW'}}),
    prisma.bankDeposit.count({where:{status:'UNMATCHED'}}),
    prisma.gameRound.count(),
    prisma.gameRound.aggregate({_sum:{bet:true,payout:true,net:true}})
  ]);
  res.json({users,suspended,pendingWithdrawals:pending,unmatchedDeposits:unmatched,rounds,bet:Number(wagered._sum.bet||0),payout:Number(wagered._sum.payout||0),houseNet:-Number(wagered._sum.net||0)});
}));

router.get('/games',asyncRoute(async(_req,res)=>{
  const games=[...(await loadGames()).values()].sort((a,b)=>a.sortOrder-b.sortOrder);
  const grouped=await prisma.gameRound.groupBy({by:['game'],_count:{_all:true},_sum:{bet:true,payout:true}});
  res.json({games:games.map(game=>{
    const stat=grouped.find(row=>row.game===game.key);
    const bet=Number(stat?._sum.bet||0),payout=Number(stat?._sum.payout||0);
    return {...game,theoreticalRtp:theoreticalRtp(game.key,game.config),stats:{rounds:stat?._count._all||0,bet,payout,houseNet:bet-payout,actualRtp:bet?payout/bet:null}};
  })});
}));

const gamePatch=z.object({
  name:z.string().trim().min(2).max(60).optional(),
  subtitle:z.string().trim().min(2).max(120).optional(),
  enabled:z.boolean().optional(),
  sortOrder:z.number().int().min(0).max(99).optional(),
  minBet:z.number().int().min(1).max(1_000_000_000).optional(),
  maxBet:z.number().int().min(1).max(1_000_000_000).optional(),
  maintenanceNote:z.string().trim().max(200).nullable().optional(),
  config:z.unknown().optional()
});

router.patch('/games/:key',asyncRoute(async(req,res)=>{
  const key=z.nativeEnum(GameType).parse(String(req.params.key).toUpperCase());
  const input=gamePatch.parse(req.body);
  const current=(await loadGames()).get(key)!;
  const config=input.config===undefined?current.config:configSchemas[key].parse(input.config);
  const minBet=input.minBet??current.minBet,maxBet=input.maxBet??current.maxBet;
  if(minBet>maxBet)throw new AppError(422,'Cược tối thiểu không được lớn hơn cược tối đa','BET_RANGE_INVALID');

  const data={
    name:input.name??current.name,subtitle:input.subtitle??current.subtitle,
    enabled:input.enabled??current.enabled,sortOrder:input.sortOrder??current.sortOrder,
    minBet:BigInt(minBet),maxBet:BigInt(maxBet),
    maintenanceNote:input.maintenanceNote===undefined?current.maintenanceNote:input.maintenanceNote||null,
    config:config as object,updatedById:req.auth!.userId
  };
  const game=await prisma.game.upsert({where:{key},update:data,create:{key,...data}});
  invalidateGameCache();
  res.json({game:{...jsonSafe(game),theoreticalRtp:theoreticalRtp(key,config as GameConfig)}});
}));

router.post('/games/:key/reset',asyncRoute(async(req,res)=>{
  const key=z.nativeEnum(GameType).parse(String(req.params.key).toUpperCase());
  const preset=gameDefaults[key];
  const data={name:preset.name,subtitle:preset.subtitle,enabled:true,sortOrder:preset.sortOrder,minBet:BigInt(preset.minBet),maxBet:BigInt(preset.maxBet),maintenanceNote:null,config:preset.config as object,updatedById:req.auth!.userId};
  const game=await prisma.game.upsert({where:{key},update:data,create:{key,...data}});
  invalidateGameCache();
  res.json({game:jsonSafe(game)});
}));

router.get('/games/:key/rounds',asyncRoute(async(req,res)=>{
  const key=z.nativeEnum(GameType).parse(String(req.params.key).toUpperCase());
  const limit=z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
  const items=await prisma.gameRound.findMany({where:{game:key},orderBy:{createdAt:'desc'},take:limit,include:{user:{select:{username:true,displayName:true}}}});
  res.json({items:jsonSafe(items)});
}));

router.get('/users',asyncRoute(async(req,res)=>{
  const query=z.object({search:z.string().trim().max(40).optional(),status:z.enum(['ACTIVE','SUSPENDED']).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(req.query);
  const items=await prisma.user.findMany({
    where:{...(query.status?{status:query.status}:{}),...(query.search?{OR:[{username:{contains:query.search}},{displayName:{contains:query.search}}]}:{})},
    orderBy:{createdAt:'desc'},take:query.limit,
    select:{id:true,username:true,displayName:true,role:true,status:true,balance:true,createdAt:true}
  });
  res.json({items:jsonSafe(items)});
}));

// ==================== RÚT TIỀN (SRS mục 13-16) ====================
const reviewNote=z.object({note:z.string().trim().max(500).optional()});

router.get('/withdrawals',asyncRoute(async(req,res)=>{
  const status=z.enum(['PENDING','APPROVED','REJECTED']).optional().parse(req.query.status);
  const items=await prisma.walletRequest.findMany({
    where:{type:'WITHDRAW',...(status?{status}:{})},
    include:{user:{select:{username:true,displayName:true}},reviewedBy:{select:{username:true}}},
    // Chờ duyệt xếp cũ trước để admin xử lý theo thứ tự người chơi đã gửi.
    orderBy:{createdAt:status==='PENDING'?'asc':'desc'},take:200
  });
  res.json({items:jsonSafe(items)});
}));

router.post('/withdrawals/:id/approve',asyncRoute(async(req,res)=>{
  const {note}=reviewNote.parse(req.body??{});
  const request=await approveWithdrawal(req.auth!.userId,String(req.params.id),note);
  res.json({request:jsonSafe(request)});
}));

router.post('/withdrawals/:id/reject',asyncRoute(async(req,res)=>{
  const {note}=reviewNote.parse(req.body??{});
  const request=await rejectWithdrawal(req.auth!.userId,String(req.params.id),note);
  res.json({request:jsonSafe(request)});
}));

// ==================== NẠP TIỀN (SRS mục 20) ====================
router.get('/deposits',asyncRoute(async(req,res)=>{
  const query=z.object({
    status:z.enum(['ALL','COMPLETED','UNMATCHED']).default('ALL'),
    limit:z.coerce.number().int().min(1).max(200).default(100)
  }).parse(req.query);
  const items=await prisma.bankDeposit.findMany({
    where:query.status==='ALL'?{}:{status:query.status},
    include:{user:{select:{username:true,displayName:true}},resolvedBy:{select:{username:true}}},
    orderBy:{createdAt:'desc'},take:query.limit
  });
  res.json({items:jsonSafe(items)});
}));

router.get('/deposits/unmatched',asyncRoute(async(_req,res)=>{
  const items=await prisma.bankDeposit.findMany({where:{status:'UNMATCHED'},orderBy:{createdAt:'desc'},take:200});
  res.json({items:jsonSafe(items)});
}));

/** Gán tay một giao dịch UNMATCHED cho người chơi. */
router.post('/deposits/:id/match',asyncRoute(async(req,res)=>{
  const {username}=z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9_]{4,24}$/)}).parse(req.body);
  const deposit=await matchDepositManually(req.auth!.userId,String(req.params.id),username);
  res.json({deposit:jsonSafe(deposit)});
}));

/** Sức khoẻ worker đọc email — admin cần biết ngay khi nó ngừng chạy. */
router.get('/email-reader',asyncRoute(async(_req,res)=>res.json(readerStats())));

// ==================== TÀI KHOẢN NHẬN TIỀN (SRS mục 17) ====================
router.get('/bank-account',asyncRoute(async(_req,res)=>{
  const account=await prisma.bankAccount.findFirst({where:{isActive:true},orderBy:{createdAt:'desc'}});
  res.json({account:account?jsonSafe(account):null});
}));

const bankAccountSchema=z.object({
  bankName:z.string().trim().min(2).max(80),
  accountNumber:z.string().trim().regex(/^[0-9]{6,32}$/,'Số tài khoản chỉ gồm 6-32 chữ số'),
  accountName:z.string().trim().min(2).max(80),
  transferContentDescription:z.string().trim().max(200).default('Ghi đúng username của bạn trong nội dung chuyển khoản')
});

/**
 * Chỉ giữ đúng một tài khoản đang bật (SRS: MVP chỉ cần 1 tài khoản Timo).
 * Tắt hết các tài khoản cũ rồi mới tạo bản mới, thay vì sửa đè, để lịch sử vẫn
 * tra được giao dịch đã chuyển vào số tài khoản nào.
 */
router.put('/bank-account',asyncRoute(async(req,res)=>{
  const input=bankAccountSchema.parse(req.body);
  const account=await prisma.$transaction(async tx=>{
    await tx.bankAccount.updateMany({where:{isActive:true},data:{isActive:false}});
    return tx.bankAccount.create({data:{...input,isActive:true}});
  });
  res.json({account:jsonSafe(account)});
}));
router.patch('/users/:id/status',asyncRoute(async(req,res)=>{const {status}=z.object({status:z.enum(['ACTIVE','SUSPENDED'])}).parse(req.body),user=await prisma.user.update({where:{id:String(req.params.id)},data:{status}});if(status==='SUSPENDED')await prisma.session.updateMany({where:{userId:user.id,revokedAt:null},data:{revokedAt:new Date()}});res.json({user:{id:user.id,status:user.status}})}));

/**
 * Xoá vĩnh viễn một tài khoản. Mọi quan hệ của User đều đang để onDelete:
 * Restrict (sổ quỹ, ván chơi, yêu cầu nạp/rút, điểm danh) nên phải dọn con
 * trước trong cùng một transaction, nếu không MySQL sẽ chặn ở khoá ngoại.
 */
router.delete('/users/:id',asyncRoute(async(req,res)=>{
  const id=String(req.params.id);
  const user=await prisma.user.findUnique({where:{id},select:{id:true,username:true,role:true}});
  if(!user)throw new AppError(404,'Không tìm thấy tài khoản này','USER_NOT_FOUND');
  if(user.id===req.auth!.userId)throw new AppError(422,'Không thể tự xoá tài khoản đang đăng nhập','SELF_DELETE');
  if(user.role==='ADMIN')throw new AppError(422,'Không thể xoá tài khoản quản trị','ADMIN_DELETE');

  await prisma.$transaction([
    // Người này từng duyệt lệnh nạp/rút của người khác: gỡ tham chiếu, giữ lại lịch sử đó.
    prisma.walletRequest.updateMany({where:{reviewedById:id},data:{reviewedById:null,reviewedAt:null}}),
    prisma.session.deleteMany({where:{userId:id}}),
    prisma.dailyClaim.deleteMany({where:{userId:id}}),
    prisma.gameRound.deleteMany({where:{userId:id}}),
    prisma.walletRequest.deleteMany({where:{userId:id}}),
    prisma.walletLedger.deleteMany({where:{userId:id}}),
    prisma.user.delete({where:{id}})
  ]);
  res.json({ok:true,username:user.username});
}));

// ==================== BANNERS ====================
router.get('/banners', asyncRoute(async (_req, res) => {
  const items = await getAllBannersAdmin();
  res.json({banners: jsonSafe(items)});
}));

const bannerSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(240).default(''),
  image: z.string().trim().min(1).max(255),
  tag: z.string().trim().max(40).optional().nullable(),
  actionScreen: z.string().trim().max(50).optional().nullable(),
  actionUrl: z.string().trim().max(255).optional().nullable(),
  actionLabel: z.string().trim().max(60).optional().nullable(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0)
});

router.post('/banners', asyncRoute(async (req, res) => {
  const input = bannerSchema.parse(req.body);
  const banner = await prisma.banner.create({
    data: {
      ...input,
      tag: input.tag || null,
      actionScreen: input.actionScreen || null,
      actionUrl: input.actionUrl || null,
      actionLabel: input.actionLabel || null
    }
  });
  res.json({banner: jsonSafe(banner)});
}));

router.patch('/banners/:id', asyncRoute(async (req, res) => {
  const input = bannerSchema.partial().parse(req.body);
  const banner = await prisma.banner.update({
    where: {id: String(req.params.id)},
    data: input
  });
  res.json({banner: jsonSafe(banner)});
}));

router.delete('/banners/:id', asyncRoute(async (req, res) => {
  await prisma.banner.delete({where: {id: String(req.params.id)}});
  res.json({ok: true});
}));

// ==================== EVENTS ====================
router.get('/events', asyncRoute(async (_req, res) => {
  const items = await getAllEventsAdmin();
  res.json({events: jsonSafe(items)});
}));

const eventSchema = z.object({
  title: z.string().trim().min(1).max(150),
  category: z.string().trim().min(1).max(50),
  badge: z.string().trim().max(50).optional().nullable(),
  reward: z.string().trim().min(1).max(120),
  desc: z.string().trim().min(1),
  image: z.string().trim().min(1).max(255),
  status: z.string().trim().max(20).default('ACTIVE'),
  startDate: z.string().trim().max(40).optional().nullable(),
  endDate: z.string().trim().max(40).optional().nullable(),
  actionType: z.string().trim().max(50).optional().nullable(),
  actionUrl: z.string().trim().max(255).optional().nullable(),
  actionLabel: z.string().trim().max(60).optional().nullable(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0)
});

router.post('/events', asyncRoute(async (req, res) => {
  const input = eventSchema.parse(req.body);
  const event = await prisma.event.create({
    data: {
      ...input,
      badge: input.badge || null,
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      actionType: input.actionType || null,
      actionUrl: input.actionUrl || null,
      actionLabel: input.actionLabel || null
    }
  });
  res.json({event: jsonSafe(event)});
}));

router.patch('/events/:id', asyncRoute(async (req, res) => {
  const input = eventSchema.partial().parse(req.body);
  const event = await prisma.event.update({
    where: {id: String(req.params.id)},
    data: input
  });
  res.json({event: jsonSafe(event)});
}));

router.delete('/events/:id', asyncRoute(async (req, res) => {
  await prisma.event.delete({where: {id: String(req.params.id)}});
  res.json({ok: true});
}));

export default router;
