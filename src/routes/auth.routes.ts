import {Router} from 'express';
import {z} from 'zod';
import {asyncRoute} from '../lib/http.js';
import * as auth from '../services/auth.service.js';

const router=Router();
const username=z.string().trim().toLowerCase().regex(/^[a-z0-9_]{4,24}$/,'Tên đăng nhập cần 4-24 ký tự chữ thường, số hoặc _');
const password=z.string().min(6,'Mật khẩu cần ít nhất 6 ký tự').max(72,'Mật khẩu tối đa 72 ký tự');
const displayName=z.string().trim().min(2,'Tên hiển thị cần ít nhất 2 ký tự').max(40,'Tên hiển thị tối đa 40 ký tự');
router.post('/register',asyncRoute(async(req,res)=>{const input=z.object({username,displayName,password}).parse(req.body);res.status(201).json(await auth.register(input,req))}));
router.post('/login',asyncRoute(async(req,res)=>{const input=z.object({username,password}).parse(req.body);res.json(await auth.login(input,req))}));
router.post('/refresh',asyncRoute(async(req,res)=>{const {refreshToken}=z.object({refreshToken:z.string().min(20)}).parse(req.body);res.json(await auth.refresh(refreshToken,req))}));
router.post('/logout',asyncRoute(async(req,res)=>{const {refreshToken}=z.object({refreshToken:z.string().min(20)}).parse(req.body);await auth.logout(refreshToken);res.json({ok:true})}));
export default router;
