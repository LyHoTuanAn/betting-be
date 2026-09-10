import {Router} from 'express';
import {z} from 'zod';
import {asyncRoute,jsonSafe} from '../lib/http.js';
import {prisma} from '../lib/prisma.js';
import {publicUser} from '../services/auth.service.js';
import {requireAuth} from '../middleware/auth.js';

// Gắn requireAuth ngay trên router này thay vì trên cả tiền tố `/api`. Trước đây
// mọi đường dẫn `/api/...` chưa khai báo đều rơi vào requireAuth và trả về
// "Bạn cần đăng nhập", che mất lỗi thật là gọi sai địa chỉ API.
const router=Router();
router.use(requireAuth);
router.get('/me',asyncRoute(async(req,res)=>{const user=await prisma.user.findUniqueOrThrow({where:{id:req.auth!.userId}});res.json({user:publicUser(user)})}));
router.patch('/me',asyncRoute(async(req,res)=>{const {displayName}=z.object({displayName:z.string().trim().min(2).max(40)}).parse(req.body),user=await prisma.user.update({where:{id:req.auth!.userId},data:{displayName}});res.json({user:publicUser(user)})}));
router.get('/transactions',asyncRoute(async(req,res)=>{const limit=z.coerce.number().int().min(1).max(100).default(100).parse(req.query.limit),items=await prisma.walletLedger.findMany({where:{userId:req.auth!.userId},orderBy:{createdAt:'desc'},take:limit});res.json({items:jsonSafe(items)})}));
export default router;
